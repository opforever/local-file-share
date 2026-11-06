import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

interface PairingState {
  offer: string | null
  answer: string | null
}

interface RedisResponse {
  result?: unknown
  error?: string
}

const pairingLifetimeSeconds = 300
const maxBodyBytes = 64 * 1024
const pairingKey = (id: string) => `nearbeam:pair:${id}`
const setCodeScript = `
local value = redis.call('GET', KEYS[1])
if not value then return -1 end
local pairing = cjson.decode(value)
if pairing[ARGV[1]] then return 0 end
pairing[ARGV[1]] = ARGV[2]
local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then return -1 end
redis.call('SET', KEYS[1], cjson.encode(pairing), 'EX', ttl)
return 1
`

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'Cache-Control': 'no-store' })
  response.end()
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBodyBytes) throw new Error('Request body is too large.')
    chunks.push(bytes)
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Request body must be a JSON object.')
  return body as Record<string, unknown>
}

function redisCredentials(): { url: string; token: string } {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    throw new Error(
      'Hosted one-scan pairing needs a Redis database. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to this Vercel project, then redeploy.',
    )
  }
  return { url: url.replace(/\/+$/, ''), token }
}

async function redisCommand<T>(...command: Array<string | number>): Promise<T> {
  const { url, token } = redisCredentials()
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    cache: 'no-store',
  })
  const result = (await response.json()) as RedisResponse
  if (!response.ok || result.error) {
    throw new Error(`Pairing storage request failed${result.error ? `: ${result.error}` : ` (HTTP ${response.status})`}.`)
  }
  return result.result as T
}

function validCode(value: unknown): value is string {
  return typeof value === 'string' && value.length <= maxBodyBytes && /^NB[ZR]1:[A-Za-z0-9_-]+$/.test(value)
}

async function getPairing(id: string): Promise<PairingState | null> {
  const value = await redisCommand<string | null>('GET', pairingKey(id))
  if (value === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Pairing storage returned invalid state.')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Pairing storage returned invalid state.')
  const state = parsed as Partial<PairingState>
  if (
    (state.offer !== undefined && state.offer !== null && typeof state.offer !== 'string') ||
    (state.answer !== undefined && state.answer !== null && typeof state.answer !== 'string')
  ) {
    throw new Error('Pairing storage returned invalid state.')
  }
  return { offer: state.offer ?? null, answer: state.answer ?? null }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'https://nearbeam.invalid')
  if (url.pathname === '/api/info' && request.method === 'GET') {
    try {
      const result = await redisCommand<string>('PING')
      if (result !== 'PONG') throw new Error('Pairing storage health check failed.')
      sendJson(response, 200, { available: true })
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : 'Pairing storage is not configured.' })
    }
    return
  }

  if (url.pathname === '/api/pairings' && request.method === 'POST') {
    const id = randomBytes(32).toString('base64url')
    const result = await redisCommand<string | null>(
      'SET',
      pairingKey(id),
      JSON.stringify({ offer: null, answer: null }),
      'EX',
      pairingLifetimeSeconds,
      'NX',
    )
    if (result !== 'OK') throw new Error('Could not reserve a pairing. Please try again.')
    sendJson(response, 201, { id })
    return
  }

  const match = url.pathname.match(/^\/api\/pairings\/([A-Za-z0-9_-]{43})(?:\/(offer|answer))?$/)
  if (!match) {
    sendJson(response, 404, { error: 'Pairing endpoint not found.' })
    return
  }

  const [, id, field] = match
  const key = pairingKey(id)
  if (request.method === 'GET') {
    const pairing = await getPairing(id)
    if (!pairing) {
      sendJson(response, 410, { error: 'This pairing expired or was cancelled. Show a new receiver QR.' })
      return
    }
    if (!field) {
      if (!pairing.offer) sendEmpty(response, 204)
      else sendJson(response, 200, { code: pairing.offer })
      return
    }
    if (field === 'answer' && pairing.answer) {
      await redisCommand<number>('DEL', key)
      sendJson(response, 200, { code: pairing.answer })
      return
    }
    if (field === 'offer') {
      sendJson(response, 405, { error: 'Offers are read from the base pairing endpoint.' })
      return
    }
    sendEmpty(response, 204)
    return
  }

  if (request.method === 'POST' && (field === 'offer' || field === 'answer')) {
    let body: Record<string, unknown>
    try {
      body = await readJson(request)
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body.' })
      return
    }
    if (!validCode(body.code)) {
      sendJson(response, 400, { error: `A valid NearBeam ${field} code is required.` })
      return
    }
    const result = await redisCommand<number>('EVAL', setCodeScript, 1, key, field, body.code)
    if (result === -1) {
      sendJson(response, 410, { error: 'This pairing expired or was cancelled. Show a new receiver QR.' })
    } else if (result === 0) {
      sendJson(response, 409, { error: `A pairing ${field} was already received.` })
    } else {
      sendEmpty(response, 204)
    }
    return
  }

  if (request.method === 'DELETE' && !field) {
    await redisCommand<number>('DEL', key)
    sendEmpty(response, 204)
    return
  }

  sendJson(response, 405, { error: 'Method not allowed.' })
}

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    await handle(request, response)
  } catch (error) {
    console.error('Hosted pairing request failed:', error)
    if (!response.headersSent) {
      sendJson(response, 500, { error: 'Hosted pairing failed. Check the Vercel function logs and Redis configuration.' })
    } else {
      response.destroy()
    }
  }
}
