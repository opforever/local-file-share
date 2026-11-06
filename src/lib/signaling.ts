export interface Pairing {
  id: string
  inviteUrl: string
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new Error('The hosted pairing API did not return JSON. Redeploy the latest NearBeam version and try again.')
  }
  return (await response.json()) as Record<string, unknown>
}

async function checkPairingService(): Promise<void> {
  const response = await fetch('/api/info', { cache: 'no-store' })
  const body = await readJson(response)
  if (!response.ok) {
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : `The hosted pairing service returned HTTP ${response.status}.`,
    )
  }
  if (body.available !== true) throw new Error('The hosted pairing service is not configured on this deployment.')
}

async function createPairing(): Promise<Pairing> {
  const response = await fetch('/api/pairings', { method: 'POST', cache: 'no-store' })
  const body = await readJson(response)
  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `Could not create pairing (HTTP ${response.status}).`)
  }
  if (typeof body.id !== 'string') throw new Error('The hosted pairing service returned an invalid pairing ID.')

  const url = new URL(window.location.pathname, window.location.origin)
  url.searchParams.set('pair', body.id)
  return { id: body.id, inviteUrl: url.href }
}

function pairingEndpoint(id: string, field?: 'offer' | 'answer'): string {
  const params = new URLSearchParams({ id })
  if (field) params.set('field', field)
  return `/api/pairings?${params}`
}

async function readPairingCode(id: string, field: 'offer' | 'answer', signal?: AbortSignal): Promise<string | null> {
  const response = await fetch(pairingEndpoint(id, field === 'answer' ? 'answer' : undefined), {
    cache: 'no-store',
    signal,
  })
  if (response.status === 204) return null
  const body = await readJson(response)
  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `Could not read pairing ${field} (HTTP ${response.status}).`)
  }
  if (typeof body.code !== 'string') throw new Error(`The hosted pairing service returned an invalid ${field}.`)
  return body.code
}

async function sendPairingCode(id: string, field: 'offer' | 'answer', code: string): Promise<void> {
  const response = await fetch(pairingEndpoint(id, field), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    cache: 'no-store',
  })
  if (!response.ok) {
    const body = await readJson(response)
    throw new Error(
      typeof body.error === 'string' ? body.error : `Could not send pairing ${field} (HTTP ${response.status}).`,
    )
  }
}

async function cancelPairing(id: string): Promise<void> {
  const response = await fetch(pairingEndpoint(id), { method: 'DELETE', cache: 'no-store' })
  if (!response.ok && response.status !== 410) {
    const body = await readJson(response)
    throw new Error(typeof body.error === 'string' ? body.error : `Could not cancel pairing (HTTP ${response.status}).`)
  }
}

export function extractPairingId(raw: string): string | null {
  try {
    const url = new URL(raw)
    const id = url.searchParams.get('pair')
    return id && /^[A-Za-z0-9_-]{43}$/.test(id) ? id : null
  } catch {
    return null
  }
}

export function isAllowedPairingUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:') return true
    if (url.protocol !== 'http:') return false

    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (hostname === 'localhost' || hostname.endsWith('.local')) return true

    const octets = hostname.split('.').map(Number)
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false
    }
    return (
      octets[0] === 10 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 169 && octets[1] === 254)
    )
  } catch {
    return false
  }
}

export {
  cancelPairing,
  checkPairingService,
  createPairing,
  readPairingCode,
  sendPairingCode,
}
