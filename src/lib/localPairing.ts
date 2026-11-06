interface LocalPairingInfo {
  inviteBaseUrl: string
}

export interface LocalPairing {
  id: string
  inviteUrl: string
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new Error('The local NearBeam service did not return JSON.')
  }
  return (await response.json()) as Record<string, unknown>
}

export async function getLocalPairingInfo(): Promise<LocalPairingInfo | null> {
  const response = await fetch('/api/info', { cache: 'no-store' })
  if (response.status === 404 || !(response.headers.get('content-type') ?? '').includes('application/json')) return null
  if (!response.ok) throw new Error(`The local signaling service returned HTTP ${response.status}.`)
  const body = await readJson(response)
  if (typeof body.inviteBaseUrl !== 'string') throw new Error('The local signaling service returned an invalid address.')
  return { inviteBaseUrl: body.inviteBaseUrl }
}

export async function createLocalPairing(code: string): Promise<LocalPairing> {
  const response = await fetch('/api/pairings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    cache: 'no-store',
  })
  const body = await readJson(response)
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Could not create pairing (HTTP ${response.status}).`)
  if (typeof body.id !== 'string' || typeof body.inviteUrl !== 'string') {
    throw new Error('The local signaling service returned an invalid pairing link.')
  }
  return { id: body.id, inviteUrl: body.inviteUrl }
}

export async function getLocalOffer(id: string): Promise<string> {
  const response = await fetch(`/api/pairings/${encodeURIComponent(id)}`, { cache: 'no-store' })
  const body = await readJson(response)
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Could not read invite (HTTP ${response.status}).`)
  if (typeof body.code !== 'string') throw new Error('The local signaling service returned an invalid invite.')
  return body.code
}

export async function sendLocalAnswer(id: string, code: string): Promise<void> {
  const response = await fetch(`/api/pairings/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    cache: 'no-store',
  })
  if (!response.ok) {
    const body = await readJson(response)
    throw new Error(typeof body.error === 'string' ? body.error : `Could not return the pairing response (HTTP ${response.status}).`)
  }
}

export async function getLocalAnswer(id: string): Promise<string | null> {
  const response = await fetch(`/api/pairings/${encodeURIComponent(id)}/answer`, { cache: 'no-store' })
  if (response.status === 204) return null
  const body = await readJson(response)
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Could not read the pairing response (HTTP ${response.status}).`)
  if (typeof body.code !== 'string') throw new Error('The local signaling service returned an invalid response.')
  return body.code
}

export async function cancelLocalPairing(id: string): Promise<void> {
  const response = await fetch(`/api/pairings/${encodeURIComponent(id)}`, { method: 'DELETE', cache: 'no-store' })
  if (!response.ok && response.status !== 410) {
    throw new Error(`Could not cancel local pairing (HTTP ${response.status}).`)
  }
}

export function extractLocalPairingId(raw: string): string | null {
  try {
    const url = new URL(raw)
    const id = url.searchParams.get('pair')
    return id && /^[A-Za-z0-9_-]{40,50}$/.test(id) ? id : null
  } catch {
    return null
  }
}

export function isLocalPairingUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:') return false
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (hostname === 'localhost' || hostname.endsWith('.local')) return true

    const octets = hostname.split('.').map(Number)
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false
    }
    return (
      octets[0] === 10 ||
      octets[0] === 192 && octets[1] === 168 ||
      octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 ||
      octets[0] === 169 && octets[1] === 254
    )
  } catch {
    return false
  }
}
