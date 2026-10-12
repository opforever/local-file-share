/**
 * Incremental SHA-256, written from scratch so that integrity verification can
 * stream. `crypto.subtle.digest` needs the whole file in one BufferSource,
 * which would pin a multi-gigabyte transfer in RAM; hashing chunk-by-chunk as
 * bytes pass through keeps verification memory flat and costs no extra I/O.
 *
 * Reference: FIPS 180-4. Pure TypeScript, no dependencies.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

export class Sha256 {
  private readonly h = new Uint32Array(H0)
  private readonly block = new Uint8Array(64)
  private readonly w = new Uint32Array(64)
  private blockLength = 0
  private byteLength = 0
  private finalized = false

  /** Feed another piece of the message. Safe to call with any chunk size. */
  update(data: Uint8Array): this {
    if (this.finalized) throw new Error('Sha256: cannot update after digest().')
    let offset = 0
    this.byteLength += data.length

    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, data.length)
      this.block.set(data.subarray(0, take), this.blockLength)
      this.blockLength += take
      offset = take
      if (this.blockLength === 64) {
        this.compress(this.block, 0)
        this.blockLength = 0
      }
    }

    while (offset + 64 <= data.length) {
      this.compress(data, offset)
      offset += 64
    }

    const tail = data.length - offset
    if (tail > 0) {
      this.block.set(data.subarray(offset, offset + tail), 0)
      this.blockLength = tail
    }
    return this
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = this.w
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, hh] = this.h

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    const h = this.h
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }

  /** Finalise and return the 32-byte digest. */
  digest(): Uint8Array {
    if (!this.finalized) {
      this.finalized = true
      const bitLengthHi = Math.floor(this.byteLength / 0x20000000)
      const bitLengthLo = (this.byteLength << 3) >>> 0

      this.blockLengthAppend(Uint8Array.of(0x80))
      while (this.blockLength !== 56) {
        this.blockLengthAppend(Uint8Array.of(0))
      }

      const lengthBytes = new Uint8Array(8)
      lengthBytes[0] = (bitLengthHi >>> 24) & 0xff
      lengthBytes[1] = (bitLengthHi >>> 16) & 0xff
      lengthBytes[2] = (bitLengthHi >>> 8) & 0xff
      lengthBytes[3] = bitLengthHi & 0xff
      lengthBytes[4] = (bitLengthLo >>> 24) & 0xff
      lengthBytes[5] = (bitLengthLo >>> 16) & 0xff
      lengthBytes[6] = (bitLengthLo >>> 8) & 0xff
      lengthBytes[7] = bitLengthLo & 0xff
      this.blockLengthAppend(lengthBytes)
    }

    const out = new Uint8Array(32)
    for (let i = 0; i < 8; i++) {
      out[i * 4] = (this.h[i] >>> 24) & 0xff
      out[i * 4 + 1] = (this.h[i] >>> 16) & 0xff
      out[i * 4 + 2] = (this.h[i] >>> 8) & 0xff
      out[i * 4 + 3] = this.h[i] & 0xff
    }
    return out
  }

  /** Lowercase hex digest, the form used for comparison between peers. */
  digestHex(): string {
    const bytes = this.digest()
    let hex = ''
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
    return hex
  }

  /** Appends raw padding bytes without touching the user message length. */
  private blockLengthAppend(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      this.block[this.blockLength++] = bytes[i]
      if (this.blockLength === 64) {
        this.compress(this.block, 0)
        this.blockLength = 0
      }
    }
  }
}

/** Convenience one-shot hash of a complete buffer. */
export function sha256Hex(data: Uint8Array): string {
  return new Sha256().update(data).digestHex()
}
