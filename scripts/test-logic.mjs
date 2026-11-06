#!/usr/bin/env node
/**
 * Validates the pure-logic modules (incremental SHA-256 and the invite-code
 * codec) against Node's reference implementations. Run: node scripts/test-logic.mjs
 */
import { createHash, randomBytes } from 'node:crypto'
import { rolldown } from 'rolldown'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
const outDir = mkdtempSync(join(tmpdir(), 'nb-test-'))

const bundle = await rolldown({
  input: {
    sha256: 'src/lib/sha256.ts',
    codec: 'src/lib/codec.ts',
    signaling: 'src/lib/signaling.ts',
    'pairing-api': 'api/[...route].ts',
  },
  external: ['node:crypto'],
  cwd: root,
})
await bundle.write({ dir: outDir, format: 'esm' })

const sha = await import(pathToFileURL(join(outDir, 'sha256.js')).href)
const codec = await import(pathToFileURL(join(outDir, 'codec.js')).href)
const signaling = await import(pathToFileURL(join(outDir, 'signaling.js')).href)
const pairingApi = await import(pathToFileURL(join(outDir, 'pairing-api.js')).href)

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) {
    failures++
    console.error(`FAIL ${label}\n  actual:   ${actual}\n  expected: ${expected}`)
  }
  return ok
}

/* ---- SHA-256 vs node:crypto across block boundaries ---- */
const sizes = [0, 1, 55, 56, 63, 64, 65, 119, 128, 1000, 65536, 1_000_003]
for (const size of sizes) {
  const data = randomBytes(size)
  const expected = createHash('sha256').update(data).digest('hex')
  check(`sha256 whole len=${size}`, sha.sha256Hex(new Uint8Array(data)), expected)

  // Streaming in awkward chunk sizes must match the one-shot digest.
  for (const chunkSize of [1, 7, 64, 63, 1000]) {
    const h = new sha.Sha256()
    for (let i = 0; i < data.length; i += chunkSize) {
      h.update(new Uint8Array(data.subarray(i, Math.min(i + chunkSize, data.length))))
    }
    check(`sha256 stream len=${size} chunk=${chunkSize}`, h.digestHex(), expected)
  }
}
// Known answer test (FIPS example).
check('sha256 "abc"', sha.sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
check('sha256 empty', sha.sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')

/* ---- Codec round-trip ---- */
const sampleSdp = `v=0\r\no=- 4611731400430051360 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=msid-semantic: WMS\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:9vAq\r\na=ice-pwd:xyz\r\na=fingerprint:sha-256 AA:BB\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=candidate:1 1 udp 2113937151 192.168.1.20 54321 typ host\r\n`.repeat(3)

const payload = { v: 1, t: 'offer', sdp: sampleSdp, name: 'Pixel 8' }
const code = await codec.encodePayload(payload)
console.log(`code length: ${code.length} chars (raw SDP JSON: ${JSON.stringify(payload).length})`)
if (code.length > sampleSdp.length) {
  failures++
  console.error('FAIL codec did not compress')
}
const decoded = await codec.decodePayload(code)
check('codec round-trip', JSON.stringify(decoded), JSON.stringify(payload))

// Wrapped / whitespace-padded / URL-embedded forms must all decode.
const wrapped = codec.wrapCode(code, 64)
check('codec wrapped', JSON.stringify(await codec.decodePayload(wrapped)), JSON.stringify(payload))
check('codec padded', JSON.stringify(await codec.decodePayload(`\n  ${wrapped}  \n`)), JSON.stringify(payload))
check(
  'codec from url',
  JSON.stringify(await codec.decodePayload(`https://example.app/?nb=${encodeURIComponent(code)}`)),
  JSON.stringify(payload),
)

/* ---- Pairing URL validation ---- */
check(
  'private IPv4 pairing URL',
  signaling.isAllowedPairingUrl('http://192.168.1.25:4173/?pair=abc'),
  true,
)
check('local .local pairing URL', signaling.isAllowedPairingUrl('http://nearbeam.local/?pair=abc'), true)
check('public HTTP pairing URL rejected', signaling.isAllowedPairingUrl('http://example.com/?pair=abc'), false)
check('hosted HTTPS pairing URL accepted', signaling.isAllowedPairingUrl('https://nearbeam.vercel.app/?pair=abc'), true)
check('FTP pairing URL rejected', signaling.isAllowedPairingUrl('ftp://192.168.1.25/?pair=abc'), false)
check(
  'pairing id extracted',
  signaling.extractPairingId(`https://nearbeam.vercel.app/?pair=${'a'.repeat(43)}`),
  'a'.repeat(43),
)

/* ---- Hosted signaling API offer/answer lifecycle ---- */
const redis = new Map()
const originalFetch = globalThis.fetch
const originalUrl = process.env.UPSTASH_REDIS_REST_URL
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token'
globalThis.fetch = async (_url, options) => {
  const [command, ...args] = JSON.parse(options.body)
  let result
  if (command === 'PING') {
    result = 'PONG'
  } else if (command === 'SET') {
    const [key, value] = args
    result = redis.has(key) ? null : 'OK'
    if (result) redis.set(key, value)
  } else if (command === 'GET') {
    result = redis.get(args[0]) ?? null
  } else if (command === 'DEL') {
    result = Number(redis.delete(args[0]))
  } else if (command === 'EVAL') {
    const [, keyCount, key, field, code] = args
    if (keyCount !== 1 || !redis.has(key)) result = -1
    else {
      const state = JSON.parse(redis.get(key))
      if (state[field]) result = 0
      else {
        state[field] = code
        for (const [key, value] of Object.entries(state)) {
          if (value === null) delete state[key]
        }
        redis.set(key, JSON.stringify(state))
        result = 1
      }
    }
  } else {
    throw new Error(`Unexpected Redis command: ${command}`)
  }
  return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

class MockResponse {
  headersSent = false
  statusCode = 0
  body = ''

  writeHead(status) {
    this.headersSent = true
    this.statusCode = status
    return this
  }

  end(body = '') {
    this.body = body
  }

  destroy() {}
}

async function callApi(method, url, body = '') {
  const request = Readable.from(body ? [Buffer.from(body)] : [])
  request.method = method
  request.url = url
  const response = new MockResponse()
  await pairingApi.default(request, response)
  return {
    status: response.statusCode,
    body: response.body ? JSON.parse(response.body) : null,
  }
}

delete process.env.UPSTASH_REDIS_REST_URL
delete process.env.UPSTASH_REDIS_REST_TOKEN
const unconfigured = await callApi('GET', '/api/info')
check('hosted pairing explains missing Redis configuration', unconfigured.status, 503)
check(
  'missing config error points to Vercel environment variables',
  unconfigured.body.error.includes('UPSTASH_REDIS_REST_URL'),
  true,
)
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token'

const info = await callApi('GET', '/api/info')
check('hosted pairing is available when Redis is configured', info.status, 200)
const room = await callApi('POST', '/api/pairings')
check('hosted pairing room created', room.status, 201)
const pairingId = room.body.id
check('hosted pairing ID shape', /^[A-Za-z0-9_-]{43}$/.test(pairingId), true)
check('waiting for sender offer', (await callApi('GET', `/api/pairings/${pairingId}`)).status, 204)
check(
  'sender offer accepted',
  (await callApi('POST', `/api/pairings/${pairingId}/offer`, '{"code":"NBZ1:b2ZmZXI"}')).status,
  204,
)
check(
  'duplicate sender offer rejected',
  (await callApi('POST', `/api/pairings/${pairingId}/offer`, '{"code":"NBZ1:c2Vjb25k"}')).status,
  409,
)
check(
  'receiver reads offer',
  (await callApi('GET', `/api/pairings/${pairingId}`)).body.code,
  'NBZ1:b2ZmZXI',
)
check(
  'receiver answer accepted',
  (await callApi('POST', `/api/pairings/${pairingId}/answer`, '{"code":"NBZ1:YW5zd2Vy"}')).status,
  204,
)
check(
  'sender reads answer',
  (await callApi('GET', `/api/pairings/${pairingId}/answer`)).body.code,
  'NBZ1:YW5zd2Vy',
)
check('pairing room removed after answer is read', (await callApi('GET', `/api/pairings/${pairingId}`)).status, 410)
globalThis.fetch = originalFetch
if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL
else process.env.UPSTASH_REDIS_REST_URL = originalUrl
if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken

// Garbage must throw, not crash silently.
for (const bad of ['', '   ', 'hello world', 'NBZ1:!!!', 'NBQ1:AAAA']) {
  let threw = false
  try {
    await codec.decodePayload(bad)
  } catch {
    threw = true
  }
  check(`codec rejects ${JSON.stringify(bad)}`, threw, true)
}

console.log(failures === 0 ? '\nAll logic tests passed.' : `\n${failures} test(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
