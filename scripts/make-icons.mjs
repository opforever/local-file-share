#!/usr/bin/env node
/**
 * Rasterises the NearBeam mark into the PNG icons the web app manifest needs.
 *
 * Zero dependencies on purpose: it writes PNGs by hand with node:zlib, so a
 * fresh `git clone && npm install` never needs a native image toolchain.
 * Re-run with `node scripts/make-icons.mjs` after editing the artwork below.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

/* ------------------------------------------------------------------ *
 * Minimal PNG encoder
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ *
 * Tiny software rasteriser (signed distance fields + supersampling)
 * ------------------------------------------------------------------ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6))
  return t * t * (3 - 2 * t)
}
const mix = (a, b, t) => a + (b - a) * t

function sdRoundBox(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius)
  const qy = Math.abs(py - cy) - (halfH - radius)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius
}

function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy || 1e-9
  const t = clamp01((wx * vx + wy * vy) / len2)
  return Math.hypot(wx - vx * t, wy - vy * t)
}

function sdPolyline(px, py, points) {
  let d = Infinity
  for (let i = 0; i < points.length - 1; i++) {
    d = Math.min(d, sdSegment(px, py, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]))
  }
  return d
}

// Artwork, authored in a 64x64 box to match public/favicon.svg.
const GRADIENT = [
  [0x5a, 0xd1, 0xff],
  [0x6f, 0x8d, 0xff],
  [0xa0, 0x6b, 0xff],
]
const GLYPH = [0x06, 0x10, 0x1f]
const ARROW_TOP = [
  [17, 25.5],
  [40.5, 25.5],
  [34, 19],
]
const ARROW_BOTTOM = [
  [47, 38.5],
  [23.5, 38.5],
  [30, 45],
]

/**
 * @param size    output edge length in px
 * @param bleed   true = full-bleed square (maskable), false = rounded, transparent outside
 */
function renderIcon(size, bleed) {
  const buf = Buffer.alloc(size * size * 4)
  const s = size / 64
  const radius = bleed ? 0 : 17 * s
  const half = bleed ? size / 2 : (60 / 2) * s
  const centre = size / 2
  const strokeHalf = (5.5 / 2) * s * (bleed ? 0.86 : 1)
  // Maskable icons keep the glyph inside the browser's circular safe zone.
  const g = bleed ? 0.78 : 1

  const glyphPolylines = [ARROW_TOP, ARROW_BOTTOM].map((pts) =>
    pts.map(([x, y]) => [centre + (x - 32) * s * g, centre + (y - 32) * s * g]),
  )

  const ss = size >= 256 ? 2 : 3 // supersampling factor
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let gg = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = px + (sx + 0.5) / ss
          const y = py + (sy + 0.5) / ss

          const box = sdRoundBox(x, y, centre, centre, half, half, radius)
          const cover = 1 - smooth(-0.5, 0.5, box)
          if (cover <= 0) continue

          // Diagonal gradient across the tile.
          const t = clamp01((x / size + y / size) / 2)
          const stop = t * (GRADIENT.length - 1)
          const i = Math.min(Math.floor(stop), GRADIENT.length - 2)
          const f = stop - i
          const cr = mix(GRADIENT[i][0], GRADIENT[i + 1][0], f)
          const cg = mix(GRADIENT[i][1], GRADIENT[i + 1][1], f)
          const cb = mix(GRADIENT[i][2], GRADIENT[i + 1][2], f)

          let dr = cr
          let dg = cg
          let db = cb
          for (const line of glyphPolylines) {
            const d = sdPolyline(x, y, line)
            const ink = 1 - smooth(strokeHalf - 0.6, strokeHalf + 0.6, d)
            if (ink > 0) {
              dr = mix(dr, GLYPH[0], ink * 0.93)
              dg = mix(dg, GLYPH[1], ink * 0.93)
              db = mix(db, GLYPH[2], ink * 0.93)
            }
          }

          r += dr
          gg += dg
          b += db
          a += cover
        }
      }
      const n = ss * ss
      const o = (py * size + px) * 4
      const alpha = a / n
      buf[o] = Math.round(r / n)
      buf[o + 1] = Math.round(gg / n)
      buf[o + 2] = Math.round(b / n)
      buf[o + 3] = Math.round(alpha * 255)
    }
  }
  return encodePng(size, size, buf)
}

mkdirSync(OUT_DIR, { recursive: true })
const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-192.png', 192, true],
  ['maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
]
for (const [name, size, bleed] of targets) {
  writeFileSync(join(OUT_DIR, name), renderIcon(size, bleed))
  console.log(`wrote public/icons/${name} (${size}x${size}${bleed ? ', maskable' : ''})`)
}
