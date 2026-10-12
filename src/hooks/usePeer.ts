import { useCallback, useEffect, useRef, useState } from 'react'
import { decodePayload, encodePayload } from '../lib/codec.ts'
import {
  createBeamChannel,
  EMPTY_STATS,
  readConnectionStats,
  rtcConfiguration,
  sessionSafetyCode,
  waitIceGathering,
  type ConnectionStats,
  type RtcSettings,
} from '../lib/rtc.ts'
import { deviceLabel } from '../lib/ua.ts'

export type PairPhase = 'idle' | 'hosting' | 'joining' | 'connected' | 'failed'

interface SignalingPayload {
  v: number
  t: 'offer' | 'answer'
  sdp: string
  label: string
}

export interface UsePeerOptions {
  settings: RtcSettings
  onChannelOpen?: (channel: RTCDataChannel) => void
  onChannelClosed?: (reason: string) => void
}

export function usePeer({ settings, onChannelOpen, onChannelClosed }: UsePeerOptions) {
  const [phase, setPhase] = useState<PairPhase>('idle')
  const [role, setRole] = useState<'host' | 'guest' | null>(null)
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [peerLabel, setPeerLabel] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new')
  const [iceState, setIceState] = useState<RTCIceConnectionState>('new')
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<ConnectionStats>(EMPTY_STATS)
  const [safetyCode, setSafetyCode] = useState<string | null>(null)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const offerSdpRef = useRef<string | null>(null)
  const answerSdpRef = useRef<string | null>(null)
  const previousStatsRef = useRef<{ bytesSent: number; bytesReceived: number; at: number } | null>(null)
  const [selfLabel] = useState(() => deviceLabel())

  const teardown = useCallback(
    (reason?: string) => {
      channelRef.current?.close()
      pcRef.current?.close()
      channelRef.current = null
      pcRef.current = null
      offerSdpRef.current = null
      answerSdpRef.current = null
      previousStatsRef.current = null
      setInviteCode(null)
      setSafetyCode(null)
      setStats(EMPTY_STATS)
      setConnectionState('new')
      setIceState('new')
      if (reason) {
        setError(reason)
        setPhase('failed')
      } else {
        setError(null)
        setPhase('idle')
      }
      setRole(null)
    },
    [],
  )

  const wireChannel = useCallback(
    (channel: RTCDataChannel) => {
      channelRef.current = channel
      channel.binaryType = 'arraybuffer'
      channel.bufferedAmountLowThreshold = 2 * 1024 * 1024
      channel.onopen = () => {
        setPhase('connected')
        setError(null)
        onChannelOpen?.(channel)
        const offer = offerSdpRef.current
        const answer = answerSdpRef.current
        if (offer && answer) {
          void sessionSafetyCode(offer, answer).then(setSafetyCode).catch(() => undefined)
        }
      }
      channel.onclose = () => onChannelClosed?.('The other device closed the connection.')
      channel.onerror = () => onChannelClosed?.('The data channel reported an error.')
    },
    [onChannelOpen, onChannelClosed],
  )

  const wirePeer = useCallback(
    (pc: RTCPeerConnection) => {
      pcRef.current = pc
      pc.onconnectionstatechange = () => {
        setConnectionState(pc.connectionState)
        if (pc.connectionState === 'failed') {
          teardown('The connection failed. Both devices usually need to be on the same Wi‑Fi/network — or enable “internet fallback” in settings.')
        } else if (pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
          // `disconnected` often recovers on flaky Wi‑Fi; only surface failure.
          if (pc.connectionState === 'closed') onChannelClosed?.('Connection closed.')
        }
      }
      pc.oniceconnectionstatechange = () => setIceState(pc.iceConnectionState)
    },
    [onChannelClosed, teardown],
  )

  /** Host: build an offer and return its shareable invite code. */
  const createInvite = useCallback(async (): Promise<string> => {
    teardown()
    const pc = new RTCPeerConnection(rtcConfiguration(settings))
    wirePeer(pc)
    wireChannel(createBeamChannel(pc))
    setRole('host')
    setPhase('hosting')
    setError(null)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitIceGathering(pc)
    // Capture the SDP *after* gathering so the safety code hashes exactly the
    // string the peer receives (including candidates).
    const offerSdp = pc.localDescription?.sdp ?? offer.sdp ?? ''
    offerSdpRef.current = offerSdp
    const payload: SignalingPayload = {
      v: 1,
      t: 'offer',
      sdp: offerSdp,
      label: selfLabel,
    }
    const code = await encodePayload(payload)
    setInviteCode(code)
    return code
  }, [settings, teardown, wireChannel, wirePeer, selfLabel])

  /** Guest: consume an offer code and return the answer code to send back. */
  const acceptInvite = useCallback(
    async (code: string): Promise<string> => {
      teardown()
      const payload = (await decodePayload(code)) as SignalingPayload
      if (!payload || payload.t !== 'offer' || typeof payload.sdp !== 'string') {
        throw new Error('That code is not a NearBeam invite.')
      }
      const pc = new RTCPeerConnection(rtcConfiguration(settings))
      wirePeer(pc)
      pc.ondatachannel = (event) => wireChannel(event.channel)
      setRole('guest')
      setPhase('joining')
      setError(null)
      setPeerLabel(payload.label ?? null)

      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
      offerSdpRef.current = payload.sdp
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await waitIceGathering(pc)
      const answerSdp = pc.localDescription?.sdp ?? answer.sdp ?? ''
      answerSdpRef.current = answerSdp
      const response: SignalingPayload = {
        v: 1,
        t: 'answer',
        sdp: answerSdp,
        label: selfLabel,
      }
      return encodePayload(response)
    },
    [settings, teardown, wireChannel, wirePeer, selfLabel],
  )

  /** Host: apply the guest's answer to finish the handshake. */
  const completeInvite = useCallback(async (code: string): Promise<void> => {
    const pc = pcRef.current
    if (!pc) throw new Error('Create an invite first.')
    const payload = (await decodePayload(code)) as SignalingPayload
    if (!payload || payload.t !== 'answer' || typeof payload.sdp !== 'string') {
      throw new Error('That code is not a NearBeam response.')
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
    answerSdpRef.current = payload.sdp
    setInviteCode(null)
  }, [])

  const cancelPairing = useCallback(() => teardown(), [teardown])
  const disconnect = useCallback(() => teardown(), [teardown])

  /* Live throughput / candidate stats while connected. */
  useEffect(() => {
    if (connectionState !== 'connected' || !pcRef.current) return
    const pc = pcRef.current
    let cancelled = false
    const tick = async () => {
      try {
        const snapshot = await readConnectionStats(pc)
        if (cancelled) return
        const now = performance.now()
        const prev = previousStatsRef.current
        let sendRate = 0
        let recvRate = 0
        if (prev) {
          const dt = (now - prev.at) / 1000
          if (dt > 0) {
            sendRate = Math.max(0, (snapshot.bytesSent - prev.bytesSent) / dt)
            recvRate = Math.max(0, (snapshot.bytesReceived - prev.bytesReceived) / dt)
          }
        }
        previousStatsRef.current = { bytesSent: snapshot.bytesSent, bytesReceived: snapshot.bytesReceived, at: now }
        setStats({ ...snapshot, sendRate, recvRate })
      } catch {
        /* pc may have closed between poll and read */
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [connectionState])

  useEffect(() => () => teardown(), [teardown])

  return {
    phase,
    role,
    inviteCode,
    peerLabel,
    connectionState,
    iceState,
    error,
    stats,
    safetyCode,
    selfLabel,
    channel: channelRef,
    createInvite,
    acceptInvite,
    completeInvite,
    cancelPairing,
    disconnect,
    setError,
  }
}

export type PeerApi = ReturnType<typeof usePeer>
