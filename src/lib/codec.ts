/**
 * Compact, transport-agnostic encoding for WebRTC signaling payloads.
 *
 * NearBeam deliberately has no signaling server: the two devices exchange an
 * SDP offer/answer through whatever channel the humans already have — a QR
 * code on a screen, a pasted snippet, or a link dropped into any chat app.
 * SDP text is extremely repetitive, so gzip shrinks it ~4x and base64url keeps
 * the result QR- and URL-safe.
 */

const PREFIX_GZIP = 'NBZ1:'
const PREFIX_RAW = 'NBR1:'

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(input: string): Uint8Array {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return bytes
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decode compressed invite codes.')
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Serialise a payload into a short, QR-friendly string. */
export async function encodePayload(value: unknown): Promise<string> {
  const json = JSON.stringify(value)
  const raw = new TextEncoder().encode(json)
  try {
    const gz = await gzipBytes(raw)
    if (gz.length < raw.length) return PREFIX_GZIP + bytesToBase64Url(gz)
  } catch {
    /* fall through to the uncompressed form */
  }
  return PREFIX_RAW + bytesToBase64Url(raw)
}

/**
 * Recover a payload from a pasted code. Tolerates surrounding whitespace,
 * line wrapping (codes are wrapped for display), and a full invite URL so
 * that pasting a shared link behaves exactly like pasting the code.
 */
export async function decodePayload(text: string): Promise<unknown> {
  const source = extractCode(text)
  if (!source) throw new Error('That does not look like a NearBeam code.')

  const prefix = source.slice(0, PREFIX_GZIP.length)
  const body = source.slice(PREFIX_GZIP.length)
  let bytes = base64UrlToBytes(body)
  if (prefix === PREFIX_GZIP) bytes = await gunzipBytes(bytes)
  else if (prefix !== PREFIX_RAW) throw new Error('Unrecognised invite code format.')

  const json = new TextDecoder().decode(bytes)
  return JSON.parse(json) as unknown
}

function looksLikeCode(value: string): boolean {
  return value.startsWith(PREFIX_GZIP) || value.startsWith(PREFIX_RAW)
}

/** Pull a NearBeam code out of raw text, a wrapped block, or an invite URL. */
export function extractCode(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // 1) A bare code, possibly line-wrapped for display.
  const collapsed = trimmed.replace(/\s+/g, '')
  if (looksLikeCode(collapsed)) return collapsed.replace(/[^A-Za-z0-9:_-]/g, '')

  // 2) A full invite URL; the code may be percent-encoded in query or hash.
  const candidates: string[] = []
  try {
    const url = new URL(trimmed)
    const fromQuery = url.searchParams.get('nb')
    if (fromQuery) candidates.push(fromQuery)
    const fromHash = url.hash.match(/nb=([^&\s]+)/)?.[1]
    if (fromHash) {
      try {
        candidates.push(decodeURIComponent(fromHash))
      } catch {
        candidates.push(fromHash)
      }
    }
  } catch {
    /* not an absolute URL — fall through to the loose matcher */
  }

  // 3) A URL fragment pasted without its origin.
  const loose = trimmed.match(/[?&#]nb=([^&\s]+)/)
  if (loose) {
    try {
      candidates.push(decodeURIComponent(loose[1]))
    } catch {
      candidates.push(loose[1])
    }
  }

  for (const candidate of candidates) {
    const clean = candidate.replace(/\s+/g, '')
    if (looksLikeCode(clean)) return clean.replace(/[^A-Za-z0-9:_-]/g, '')
  }
  return null
}

/** Wrap a long code into fixed-width lines so it is readable when displayed. */
export function wrapCode(code: string, width = 72): string {
  const lines: string[] = []
  for (let i = 0; i < code.length; i += width) lines.push(code.slice(i, i + width))
  return lines.join('\n')
}

/** Build a shareable invite link; the code lives in the URL fragment/query. */
export function buildInviteUrl(code: string): string {
  const base = `${location.origin}${location.pathname}`
  return `${base}?nb=${encodeURIComponent(code)}`
}
