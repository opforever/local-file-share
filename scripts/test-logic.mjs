#!/usr/bin/env node
/**
 * Validates the pure-logic modules and invite-code codec. Run: node scripts/test-logic.mjs
 */
import { rolldown } from 'rolldown'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
const outDir = mkdtempSync(join(tmpdir(), 'nb-test-'))

const bundle = await rolldown({
  input: {
    codec: 'src/lib/codec.ts',
    signaling: 'src/lib/signaling.ts',
  },
  external: ['node:crypto'],
  cwd: root,
})
await bundle.write({ dir: outDir, format: 'esm' })

const codec = await import(pathToFileURL(join(outDir, 'codec.js')).href)
const signaling = await import(pathToFileURL(join(outDir, 'signaling.js')).href)

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) {
    failures++
    console.error(`FAIL ${label}\n  actual:   ${actual}\n  expected: ${expected}`)
  }
  return ok
}

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
check('public HTTPS pairing URL rejected for local-only pairing', signaling.isAllowedPairingUrl('https://nearbeam.vercel.app/?pair=abc'), false)
check('FTP pairing URL rejected', signaling.isAllowedPairingUrl('ftp://192.168.1.25/?pair=abc'), false)
check(
  'pairing id extracted',
  signaling.extractPairingId(`https://nearbeam.vercel.app/?pair=${'a'.repeat(43)}`),
  'a'.repeat(43),
)

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
