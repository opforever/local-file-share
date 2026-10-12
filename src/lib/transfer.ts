/**
 * The transfer engine: a bidirectional file/text pump over a single WebRTC
 * data channel.
 *
 * Design notes
 * ------------
 * - One logical stream per direction. The sender serialises files (meta →
 *   binary chunks → done → ack) so a receiving peer never interleaves two
 *   incoming files, which keeps the disk sink trivially correct.
 * - Two layers of flow control keep memory bounded at gigabit rates:
 *     1. `bufferedAmount` backpressure against the SCTP send buffer.
 *     2. An application-level brake: the receiver asks the sender to pause
 *        when its unwritten queue grows past a threshold (slow disk / mobile).
 * - A one-chunk read-ahead hides file-read latency behind network waits.
 * - Optional streaming SHA-256 on both ends verifies integrity without ever
 *   holding a whole file in RAM and without re-reading from disk.
 * - The item list is an external store so React can subscribe with
 *   `useSyncExternalStore` and progress updates are batched, never per-chunk.
 */

import { Sha256 } from './sha256.ts'
import type { FileSink, SinkFactory, SinkLocation } from './sinks.ts'

export const CHUNK_SIZE = 64 * 1024
const HIGH_WATER = 8 * 1024 * 1024
const BRAKE_ON = 32 * 1024 * 1024
const BRAKE_OFF = 8 * 1024 * 1024
const ACK_TIMEOUT = 180_000
const SPEED_SAMPLE_MS = 300

export type ItemStatus =
  | 'queued'
  | 'sending'
  | 'finishing'
  | 'receiving'
  | 'done'
  | 'error'
  | 'canceled'

export interface TransferItem {
  id: string
  direction: 'out' | 'in'
  name: string
  path?: string
  size: number
  mime: string
  transferred: number
  status: ItemStatus
  speed: number
  error?: string
  startedAt?: number
  endedAt?: number
  /** sha256 match result; undefined when verification is off. */
  verified?: boolean
  /** Received payload, available once an incoming file completes. */
  file?: File
  location?: SinkLocation
  at: number
}

export interface BeamFile {
  file: File
  /** Relative path when the file came from a folder selection. */
  path?: string
}

export type BeamEvent =
  | { type: 'file-done'; item: TransferItem }
  | { type: 'file-error'; item: TransferItem }
  | { type: 'text'; id: string; body: string; at: number }
  | { type: 'peer-hello'; label: string }
  | { type: 'closed'; reason?: string }

export interface BeamOptions {
  verify: boolean
  sinkFactory: SinkFactory
  label: string
  onEvent?: (event: BeamEvent) => void
}

/* ------------------------------- wire types ------------------------------- */

type Wire =
  | { k: 'hello'; label: string }
  | { k: 'meta'; id: string; name: string; path?: string; size: number; mime: string; verify?: boolean }
  | { k: 'done'; id: string; sha?: string }
  | { k: 'ack'; id: string; ok: boolean; err?: string }
  | { k: 'cancel'; id: string }
  | { k: 'text'; id: string; body: string; at: number }
  | { k: 'brake' }
  | { k: 'go' }

interface OutgoingEntry {
  id: string
  file: File
  path?: string
}

interface IncomingState {
  id: string
  sink: FileSink
  hash: Sha256 | null
  chain: Promise<void>
  pendingBytes: number
  braking: boolean
  item: TransferItem
}

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** One-deep read-ahead so disk latency overlaps network backpressure. */
function chunkReader(file: File, size: number): () => Promise<ArrayBuffer | null> {
  let offset = 0
  let inflight: Promise<ArrayBuffer> | null = null

  const prime = () => {
    if (inflight || offset >= file.size) return
    const start = offset
    const end = Math.min(offset + size, file.size)
    offset = end
    inflight = file.slice(start, end).arrayBuffer()
  }
  prime()

  return async () => {
    const current = inflight
    inflight = null
    prime()
    return current ? current : null
  }
}

export class BeamEngine {
  private readonly items = new Map<string, TransferItem>()
  private readonly order: string[] = []
  private snapshot: TransferItem[] = []
  private readonly listeners = new Set<() => void>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private readonly queue: OutgoingEntry[] = []
  private pumping = false
  private readonly cancelRequested = new Set<string>()

  private incoming: IncomingState | null = null
  private readonly cleanups = new Map<string, () => Promise<void>>()

  private readonly pendingAcks = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly brakeWaiters: Array<() => void> = []
  private readonly closeWaiters: Array<() => void> = []
  private brakeGen = 0
  private remoteBrake = false

  private readonly speedWindows = new Map<string, { start: number; bytes: number }>()
  private readonly dc: RTCDataChannel
  private readonly opts: BeamOptions
  private closed = false
  private totalOutBytes = 0
  private totalInBytes = 0

  constructor(dc: RTCDataChannel, opts: BeamOptions) {
    this.dc = dc
    this.opts = opts
    dc.binaryType = 'arraybuffer'
    dc.addEventListener('message', this.onMessage)
    dc.addEventListener('close', this.onClose)
    dc.addEventListener('error', this.onClose)
    this.sendJson({ k: 'hello', label: opts.label })
  }

  /* ------------------------------ store API ------------------------------ */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): TransferItem[] => this.snapshot

  private mark(delay = 90): void {
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => this.flush(), delay)
  }

  private markNow(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flush()
  }

  private flush(): void {
    this.flushTimer = null
    this.snapshot = this.order.map((id) => ({ ...this.items.get(id)! }))
    for (const key of [...this.speedWindows.keys()]) {
      if (!this.items.has(key)) this.speedWindows.delete(key)
    }
    for (const listener of this.listeners) listener()
  }

  private upsert(item: TransferItem): void {
    if (!this.items.has(item.id)) this.order.push(item.id)
    this.items.set(item.id, item)
  }

  /* ------------------------------- counters ------------------------------ */

  get totalOut(): number {
    return this.totalOutBytes
  }

  get totalIn(): number {
    return this.totalInBytes
  }

  private bump(item: TransferItem, bytes: number): void {
    item.transferred += bytes
    const now = performance.now()
    if (item.startedAt === undefined) item.startedAt = now
    const window = this.speedWindows.get(item.id) ?? { start: now, bytes: 0 }
    window.bytes += bytes
    if (now - window.start >= SPEED_SAMPLE_MS) {
      const instant = window.bytes / ((now - window.start) / 1000)
      item.speed = item.speed === 0 ? instant : item.speed * 0.65 + instant * 0.35
      window.start = now
      window.bytes = 0
    }
    this.speedWindows.set(item.id, window)
    this.mark()
  }

  /* ------------------------------ public API ----------------------------- */

  enqueue(files: BeamFile[]): void {
    for (const { file, path } of files) {
      const item: TransferItem = {
        id: uid(),
        direction: 'out',
        name: file.name,
        path,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        transferred: 0,
        status: 'queued',
        speed: 0,
        at: Date.now(),
        file,
      }
      this.upsert(item)
      this.queue.push({ id: item.id, file, path })
    }
    this.markNow()
    void this.pump()
  }

  sendText(body: string): void {
    const trimmed = body.trim()
    if (!trimmed || this.closed) return
    this.sendJson({ k: 'text', id: uid(), body: trimmed, at: Date.now() })
  }

  cancelItem(id: string): void {
    const item = this.items.get(id)
    if (!item) return
    if (item.direction === 'out') {
      const queuedIndex = this.queue.findIndex((entry) => entry.id === id)
      if (queuedIndex >= 0) {
        this.queue.splice(queuedIndex, 1)
        item.status = 'canceled'
        item.endedAt = Date.now()
        item.speed = 0
        this.markNow()
        return
      }
      this.cancelRequested.add(id)
      return
    }
    if (this.incoming?.id === id) {
      void this.abortIncoming('Canceled by receiver')
    }
  }

  clearFinished(): void {
    const keep: string[] = []
    for (const id of this.order) {
      const item = this.items.get(id)!
      if (item.status === 'done' || item.status === 'canceled' || item.status === 'error') {
        this.items.delete(id)
        this.cleanups.get(id)?.().catch(() => undefined)
        this.cleanups.delete(id)
      } else {
        keep.push(id)
      }
    }
    this.order.length = 0
    this.order.push(...keep)
    this.markNow()
  }

  /** Save a received file to the user's downloads. */
  async saveReceived(id: string): Promise<void> {
    const item = this.items.get(id)
    if (!item?.file) return
    const url = URL.createObjectURL(item.file)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = item.name
    anchor.rel = 'noopener'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    // Staging copy is no longer needed once the browser has taken over.
    const cleanup = this.cleanups.get(id)
    if (cleanup) {
      this.cleanups.delete(id)
      setTimeout(() => void cleanup().catch(() => undefined), 30_000)
    }
  }

  dispose(): void {
    this.teardown('disposed')
  }

  /* ------------------------------ send path ------------------------------ */

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!
        try {
          await this.sendOne(entry)
        } catch (error) {
          const item = this.items.get(entry.id)
          if (item && item.status !== 'canceled') {
            item.status = 'error'
            item.error = error instanceof Error ? error.message : String(error)
            item.endedAt = Date.now()
            item.speed = 0
            this.markNow()
            this.opts.onEvent?.({ type: 'file-error', item: { ...item } })
          }
        }
        if (this.closed) break
      }
    } finally {
      this.pumping = false
    }
  }

  private async sendOne(entry: OutgoingEntry): Promise<void> {
    const item = this.items.get(entry.id)!
    if (this.closed) throw new Error('Connection closed before transfer started')

    item.status = 'sending'
    item.startedAt = performance.now()
    this.markNow()

    const hash = this.opts.verify ? new Sha256() : null
    this.sendJson({
      k: 'meta',
      id: item.id,
      name: item.name,
      path: item.path,
      size: item.size,
      mime: item.mime,
      verify: hash ? true : undefined,
    })

    const next = chunkReader(entry.file, CHUNK_SIZE)
    let chunk = await next()
    while (chunk !== null) {
      if (this.cancelRequested.has(item.id)) break
      if (this.closed) throw new Error('Connection closed during transfer')
      await this.gate()
      if (hash) hash.update(new Uint8Array(chunk))
      this.dc.send(chunk)
      this.totalOutBytes += chunk.byteLength
      this.bump(item, chunk.byteLength)
      chunk = await next()
    }

    if (this.cancelRequested.delete(item.id)) {
      this.sendJson({ k: 'cancel', id: item.id })
      item.status = 'canceled'
      item.endedAt = Date.now()
      item.speed = 0
      this.markNow()
      return
    }

    item.status = 'finishing'
    this.markNow()
    this.sendJson({ k: 'done', id: item.id, sha: hash ? hash.digestHex() : undefined })

    const ok = await this.waitAck(item.id)
    item.status = ok ? 'done' : 'error'
    if (!ok) item.error = 'The receiving device reported a problem.'
    item.endedAt = Date.now()
    item.speed = 0
    this.markNow()
    this.opts.onEvent?.({ type: ok ? 'file-done' : 'file-error', item: { ...item } })
  }

  private waitAck(id: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id)
        resolve(false)
      }, ACK_TIMEOUT)
      this.pendingAcks.set(id, { resolve, timer })
      this.closeWaiters.push(() => {
        clearTimeout(timer)
        this.pendingAcks.delete(id)
        resolve(false)
      })
    })
  }

  /* --------------------------- flow control ------------------------------ */

  private async gate(): Promise<void> {
    for (;;) {
      if (this.closed) throw new Error('Connection closed')
      const generation = this.brakeGen
      if (this.remoteBrake) {
        await this.waitBrakeGen(generation)
        continue
      }
      if (this.dc.bufferedAmount > HIGH_WATER) {
        await this.onceBufferLow()
        continue
      }
      return
    }
  }

  private waitBrakeGen(generation: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.brakeGen !== generation) resolve()
      }
      this.brakeWaiters.push(check)
      this.closeWaiters.push(resolve)
      check()
    })
  }

  private onceBufferLow(): Promise<void> {
    return new Promise((resolve) => {
      const onLow = () => {
        this.dc.removeEventListener('bufferedamountlow', onLow)
        resolve()
      }
      this.dc.addEventListener('bufferedamountlow', onLow)
      this.closeWaiters.push(() => {
        this.dc.removeEventListener('bufferedamountlow', onLow)
        resolve()
      })
      if (this.dc.bufferedAmount <= HIGH_WATER) {
        this.dc.removeEventListener('bufferedamountlow', onLow)
        resolve()
      }
    })
  }

  /* ----------------------------- receive path ---------------------------- */

  private onMessage = (event: MessageEvent): void => {
    if (this.closed) return
    if (typeof event.data === 'string') this.onControl(event.data)
    else this.onChunk(event.data as ArrayBuffer)
  }

  private onControl(raw: string): void {
    let msg: Wire
    try {
      msg = JSON.parse(raw) as Wire
    } catch {
      return
    }
    switch (msg.k) {
      case 'hello':
        this.opts.onEvent?.({ type: 'peer-hello', label: msg.label })
        break
      case 'meta':
        void this.startIncoming(msg)
        break
      case 'done':
        void this.finishIncoming(msg)
        break
      case 'ack': {
        const pending = this.pendingAcks.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingAcks.delete(msg.id)
          pending.resolve(msg.ok)
        }
        break
      }
      case 'cancel':
        if (this.incoming?.id === msg.id) void this.abortIncoming('Canceled by sender')
        break
      case 'text':
        this.opts.onEvent?.({ type: 'text', id: msg.id, body: msg.body, at: msg.at })
        break
      case 'brake':
        this.remoteBrake = true
        break
      case 'go':
        this.remoteBrake = false
        this.brakeGen++
        for (const waiter of this.brakeWaiters.splice(0)) waiter()
        break
    }
  }

  private async startIncoming(msg: Extract<Wire, { k: 'meta' }>): Promise<void> {
    if (this.incoming) {
      this.sendJson({ k: 'ack', id: msg.id, ok: false, err: 'Receiver busy' })
      return
    }
    const item: TransferItem = {
      id: msg.id,
      direction: 'in',
      name: msg.name,
      path: msg.path,
      size: msg.size,
      mime: msg.mime,
      transferred: 0,
      status: 'receiving',
      speed: 0,
      at: Date.now(),
    }
    this.upsert(item)
    this.markNow()

    let sink: FileSink
    try {
      sink = await this.opts.sinkFactory({ id: msg.id, name: msg.name, size: msg.size, mime: msg.mime })
    } catch (error) {
      item.status = 'error'
      item.error = error instanceof Error ? error.message : 'Could not open a destination.'
      item.endedAt = Date.now()
      this.markNow()
      this.sendJson({ k: 'ack', id: msg.id, ok: false, err: item.error })
      return
    }

    this.incoming = {
      id: msg.id,
      sink,
      hash: msg.verify ? new Sha256() : null,
      chain: Promise.resolve(),
      pendingBytes: 0,
      braking: false,
      item,
    }
  }

  private onChunk(buffer: ArrayBuffer): void {
    const inc = this.incoming
    if (!inc) return
    const bytes = buffer.byteLength
    const view = new Uint8Array(buffer)
    inc.pendingBytes += bytes
    this.totalInBytes += bytes

    inc.chain = inc.chain.then(async () => {
      try {
        await inc.sink.write(view)
        inc.hash?.update(view)
      } catch (error) {
        await this.failIncoming(inc, error)
        return
      }
      inc.pendingBytes -= bytes
      this.bump(inc.item, bytes)
      if (!inc.braking && inc.pendingBytes > BRAKE_ON) {
        inc.braking = true
        this.sendJson({ k: 'brake' })
      } else if (inc.braking && inc.pendingBytes < BRAKE_OFF) {
        inc.braking = false
        this.sendJson({ k: 'go' })
      }
    })
  }

  private async finishIncoming(msg: Extract<Wire, { k: 'done' }>): Promise<void> {
    const inc = this.incoming
    if (!inc || inc.id !== msg.id) return
    this.incoming = null

    await inc.chain
    const item = inc.item
    try {
      const saved = await inc.sink.finalize()
      item.file = saved.file
      item.location = saved.location
      if (saved.cleanup) this.cleanups.set(item.id, saved.cleanup)
      if (inc.hash && msg.sha) item.verified = inc.hash.digestHex() === msg.sha
      item.status = 'done'
      item.transferred = item.size
      item.endedAt = Date.now()
      item.speed = 0
      this.markNow()
      this.sendJson({ k: 'ack', id: msg.id, ok: true })
      this.opts.onEvent?.({ type: 'file-done', item: { ...item } })
    } catch (error) {
      await this.failIncoming(inc, error)
    }
  }

  private async failIncoming(inc: IncomingState, error: unknown): Promise<void> {
    if (this.incoming === inc) this.incoming = null
    const item = inc.item
    item.status = 'error'
    item.error = error instanceof Error ? error.message : String(error)
    item.endedAt = Date.now()
    item.speed = 0
    this.markNow()
    this.sendJson({ k: 'ack', id: inc.id, ok: false, err: item.error })
    this.opts.onEvent?.({ type: 'file-error', item: { ...item } })
    await inc.sink.abort().catch(() => undefined)
  }

  private async abortIncoming(reason: string): Promise<void> {
    const inc = this.incoming
    if (!inc) return
    this.incoming = null
    await inc.chain.catch(() => undefined)
    const item = inc.item
    item.status = 'canceled'
    item.error = reason
    item.endedAt = Date.now()
    item.speed = 0
    this.markNow()
    this.sendJson({ k: 'ack', id: inc.id, ok: false, err: reason })
    await inc.sink.abort().catch(() => undefined)
  }

  /* ------------------------------- lifecycle ----------------------------- */

  private onClose = (): void => {
    this.teardown('Connection to the other device closed.')
  }

  private teardown(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.dc.removeEventListener('message', this.onMessage)
    this.dc.removeEventListener('close', this.onClose)
    this.dc.removeEventListener('error', this.onClose)

    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
    this.pendingAcks.clear()
    for (const waiter of this.closeWaiters.splice(0)) waiter()

    for (const id of this.order) {
      const item = this.items.get(id)!
      if (item.status === 'queued' || item.status === 'sending' || item.status === 'receiving' || item.status === 'finishing') {
        item.status = 'error'
        item.error = reason
        item.endedAt = Date.now()
        item.speed = 0
      }
    }
    void this.incoming?.sink.abort().catch(() => undefined)
    this.incoming = null
    this.markNow()
    this.opts.onEvent?.({ type: 'closed', reason })
  }

  private sendJson(msg: Wire): void {
    if (this.dc.readyState !== 'open') return
    this.dc.send(JSON.stringify(msg))
  }
}
