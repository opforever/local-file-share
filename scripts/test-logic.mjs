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
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
const outDir = mkdtempSync(join(tmpdir(), 'nb-test-'))

const bundle = await rolldown({
  input: ['src/lib/sha256.ts', 'src/lib/codec.ts'],
  cwd: root,
})
await bundle.write({ dir: outDir, format: 'esm' })

const sha = await import(pathToFileURL(join(outDir, 'sha256.js')).href)
const codec = await import(pathToFileURL(join(outDir, 'codec.js')).href)

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
