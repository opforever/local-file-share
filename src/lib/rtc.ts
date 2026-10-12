/**
 * WebRTC plumbing: ICE configuration, gathering, stats and the shared
 * "safety code" both peers derive from the exchanged offer/answer pair.
 */

import { Sha256 } from './sha256.ts'

export interface RtcSettings {
  /** When false (default) only on-LAN candidates are used: fastest & private. */
  allowRelay: boolean
}

/**
 * An intentionally empty ICE server list means "host candidates only": the
 * two browsers talk directly over the local network with no STUN/TURN hop and
 * nothing leaves the LAN. Users can opt into public STUN to bridge networks.
 */
export function rtcConfiguration(settings: RtcSettings): RTCConfiguration {
  return {
    iceServers: settings.allowRelay
      ? [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
      : [],
    bundlePolicy: 'max-bundle',
  }
}

export function createBeamChannel(pc: RTCPeerConnection): RTCDataChannel {
  const channel = pc.createDataChannel('nearbeam', {
    ordered: true,
    // Reliable + ordered keeps file bytes exact; SCTP handles retransmission.
  })
  channel.binaryType = 'arraybuffer'
  // Fire `bufferedamountlow` once the send queue drains to ~2 MB.
  channel.bufferedAmountLowThreshold = 2 * 1024 * 1024
  return channel
}

/** Resolve once ICE gathering finishes, or after `timeoutMs` whichever first. */
export function waitIceGathering(pc: RTCPeerConnection, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    const timer = setTimeout(finish, timeoutMs)
    pc.addEventListener('icegatheringstatechange', onChange)
  })
}

export interface ConnectionStats {
  sendRate: number
  recvRate: number
  rtt: number | null
  localCandidate: string | null
  remoteCandidate: string | null
  bytesSent: number
  bytesReceived: number
  /** True when traffic is flowing over a private/LAN or link-local address. */
  direct: boolean | null
}

export const EMPTY_STATS: ConnectionStats = {
  sendRate: 0,
  recvRate: 0,
  rtt: null,
  localCandidate: null,
  remoteCandidate: null,
  bytesSent: 0,
  bytesReceived: 0,
  direct: null,
}

interface LooseStats {
  type?: string
  state?: string
  nominated?: boolean
  selected?: boolean
  id?: string
  localCandidateId?: string
  remoteCandidateId?: string
  currentRoundTripTime?: number
  bytesSent?: number
  bytesReceived?: number
  candidateType?: string
  address?: string
  ip?: string
}

function isPrivateAddress(address: string | undefined): boolean | null {
  if (!address) return null
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) return true
  if (/^(127\.|169\.254\.)/.test(address)) return true
  if (/\.local$/i.test(address)) return true // mDNS-obfuscated host candidate
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(address)) return true
  if (/^fe80:/i.test(address)) return true
  return false
}

/** Read the selected candidate pair plus live byte counters. */
export async function readConnectionStats(pc: RTCPeerConnection): Promise<ConnectionStats> {
  const report = await pc.getStats()
  const pairs: LooseStats[] = []
  const candidates = new Map<string, LooseStats>()

  report.forEach((entry) => {
    const stat = entry as unknown as LooseStats
    if (stat.type === 'candidate-pair') pairs.push(stat)
    else if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
      if (stat.id) candidates.set(stat.id, stat)
    }
  })

  const active =
    pairs.find((p) => p.state === 'succeeded' && (p.nominated || p.selected)) ??
    pairs.find((p) => p.state === 'succeeded') ??
    pairs.find((p) => p.state === 'in-progress')

  if (!active) return { ...EMPTY_STATS }

  const local = active.localCandidateId ? candidates.get(active.localCandidateId) : undefined
  const remote = active.remoteCandidateId ? candidates.get(active.remoteCandidateId) : undefined

  const localType = local?.candidateType ?? null
  const remoteType = remote?.candidateType ?? null
  const privateLocal = isPrivateAddress(local?.address ?? local?.ip)
  const direct =
    localType === 'host' || remoteType === 'host'
      ? true
      : privateLocal === true
        ? true
        : localType === 'relay' || remoteType === 'relay'
          ? false
          : privateLocal

  return {
    sendRate: 0,
    recvRate: 0,
    rtt: typeof active.currentRoundTripTime === 'number' ? active.currentRoundTripTime * 1000 : null,
    localCandidate: localType,
    remoteCandidate: remoteType,
    bytesSent: active.bytesSent ?? 0,
    bytesReceived: active.bytesReceived ?? 0,
    direct,
  }
}

/**
 * A short code both sides can read aloud to confirm they are paired with the
 * device they intend. Both peers hash the same (offer, answer) pair, so the
 * value matches on each end; a mismatch means a mixed-up invite.
 */
export async function sessionSafetyCode(offerSdp: string, answerSdp: string): Promise<string> {
  const digest = new Sha256()
    .update(new TextEncoder().encode(`nearbeam/1\n${offerSdp}\n${answerSdp}`))
    .digest()
  const hex = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
  return hex.match(/.{4}/g)?.join('-').toUpperCase() ?? hex.toUpperCase()
}
