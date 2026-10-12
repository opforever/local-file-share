/**
 * Where received bytes physically land.
 *
 * Three strategies, chosen per file at receive time:
 *  - `folder`  File System Access: stream straight into a user-picked folder
 *              (Chromium desktop). Zero extra copies, files appear live.
 *  - `opfs`    Origin Private File System: stream to disk inside the browser's
 *              sandbox. Keeps multi-gigabyte receives out of RAM on every
 *              modern browser, including iOS Safari.
 *  - `memory`  Plain Blob in RAM. Fastest for small files, no disk round trip.
 */

export type SinkLocation = 'folder' | 'opfs' | 'memory'

export interface IncomingMeta {
  id: string
  name: string
  size: number
  mime: string
}

export interface SavedFile {
  file: File
  location: SinkLocation
  /** Remove any staging copy (OPFS) once the user has saved it elsewhere. */
  cleanup?: () => Promise<void>
}

export interface FileSink {
  write(chunk: Uint8Array): Promise<void>
  finalize(): Promise<SavedFile>
  abort(): Promise<void>
}

export type SinkFactory = (meta: IncomingMeta) => Promise<FileSink>

/** Capability probes, evaluated once. */
export const supportsOpfs =
  typeof navigator !== 'undefined' &&
  'storage' in navigator &&
  typeof navigator.storage?.getDirectory === 'function'

export const supportsFolderSave =
  typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'

/** Above this size we stage on disk instead of holding the file in RAM. */
export const MEMORY_SINK_LIMIT = 96 * 1024 * 1024

function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'file'
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const usable = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file'
  return usable.slice(0, 180)
}

/* ------------------------------------------------------------------ */

class MemorySink implements FileSink {
  private parts: ArrayBuffer[] = []
  private readonly name: string
  private readonly mime: string

  constructor(name: string, mime: string) {
    this.name = name
    this.mime = mime
  }

  write(chunk: Uint8Array): Promise<void> {
    this.parts.push(chunk.buffer as ArrayBuffer)
    return Promise.resolve()
  }

  async finalize(): Promise<SavedFile> {
    const file = new File(this.parts, this.name, { type: this.mime })
    this.parts = []
    return { file, location: 'memory' }
  }

  async abort(): Promise<void> {
    this.parts = []
  }
}

class OpfsSink implements FileSink {
  private readonly dir: FileSystemDirectoryHandle
  private readonly handle: FileSystemFileHandle
  private readonly writable: FileSystemWritableFileStream

  private constructor(dir: FileSystemDirectoryHandle, handle: FileSystemFileHandle, writable: FileSystemWritableFileStream) {
    this.dir = dir
    this.handle = handle
    this.writable = writable
  }

  static async create(meta: IncomingMeta): Promise<OpfsSink> {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('nearbeam-inbox', { create: true })
    const handle = await dir.getFileHandle(`${meta.id}-${safeName(meta.name)}`, { create: true })
    const writable = await handle.createWritable()
    return new OpfsSink(dir, handle, writable)
  }

  write(chunk: Uint8Array): Promise<void> {
    return this.writable.write(chunk as unknown as BufferSource)
  }

  async finalize(): Promise<SavedFile> {
    await this.writable.close()
    // The OPFS File is already disk-backed; returning it as-is avoids any
    // in-memory copy. The UI supplies the sender's original display name.
    const file = await this.handle.getFile()
    return { file, location: 'opfs', cleanup: () => this.remove() }
  }

  async abort(): Promise<void> {
    try {
      await this.writable.abort()
    } catch {
      /* stream may already be closed */
    }
    await this.remove()
  }

  private async remove(): Promise<void> {
    try {
      await this.dir.removeEntry(this.handle.name)
    } catch {
      /* already gone */
    }
  }
}

class FolderSink implements FileSink {
  private readonly handle: FileSystemFileHandle
  private readonly writable: FileSystemWritableFileStream

  private constructor(handle: FileSystemFileHandle, writable: FileSystemWritableFileStream) {
    this.handle = handle
    this.writable = writable
  }

  static async create(dir: FileSystemDirectoryHandle, meta: IncomingMeta): Promise<FolderSink> {
    const handle = await dir.getFileHandle(safeName(meta.name), { create: true })
    const writable = await handle.createWritable()
    return new FolderSink(handle, writable)
  }

  write(chunk: Uint8Array): Promise<void> {
    return this.writable.write(chunk as unknown as BufferSource)
  }

  async finalize(): Promise<SavedFile> {
    await this.writable.close()
    const file = await this.handle.getFile()
    return { file, location: 'folder' }
  }

  async abort(): Promise<void> {
    try {
      await this.writable.abort()
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */

/**
 * Builds the sink factory for a session.
 * @param getFolder  returns the user-picked save folder, if any.
 */
export function createSinkFactory(getFolder: () => FileSystemDirectoryHandle | null): SinkFactory {
  return async (meta) => {
    const folder = getFolder()
    if (folder) {
      try {
        return await FolderSink.create(folder, meta)
      } catch {
        /* permission revoked mid-session: fall through to staging */
      }
    }
    if (supportsOpfs && meta.size > MEMORY_SINK_LIMIT) {
      try {
        return await OpfsSink.create(meta)
      } catch {
        /* quota or unsupported: fall back to memory */
      }
    }
    return new MemorySink(meta.name, meta.mime)
  }
}

/** Ask the user for a folder to receive into. Returns null if they cancel. */
export async function pickReceiveFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsFolderSave) return null
  try {
    const handle = await window.showDirectoryPicker!({
      id: 'nearbeam-receive',
      mode: 'readwrite',
      startIn: 'downloads',
    })
    const state = await handle.queryPermission?.({ mode: 'readwrite' })
    if (state === 'granted') return handle
    const requested = await handle.requestPermission?.({ mode: 'readwrite' })
    return requested === 'granted' ? handle : null
  } catch {
    return null
  }
}

/** Free any leftover OPFS staging files from previous sessions. */
export async function purgeOpfsInbox(): Promise<void> {
  if (!supportsOpfs) return
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('nearbeam-inbox')
    for await (const [name] of dir) {
      await dir.removeEntry(name).catch(() => undefined)
    }
  } catch {
    /* inbox never created: nothing to purge */
    }
}
