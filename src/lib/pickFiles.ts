/** Normalise user file selections (picker, folder picker, drag & drop). */

export interface PickedFile {
  file: File
  /** Relative path inside a folder selection, if any. */
  path?: string
}

const MAX_FILES = 5000

interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
}

export async function filesFromDataTransfer(transfer: DataTransfer): Promise<PickedFile[]> {
  const items = Array.from(transfer.items ?? [])
  const entries = items
    .map((item) => {
      const getter = (item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry
      return typeof getter === 'function' ? getter.call(item) : null
    })
    .filter((entry): entry is EntryLike => Boolean(entry))

  if (entries.length === 0) {
    return Array.from(transfer.files).map((file) => ({ file }))
  }

  const out: PickedFile[] = []
  for (const entry of entries) {
    await walkEntry(entry, '', out)
    if (out.length >= MAX_FILES) break
  }
  return out
}

async function walkEntry(entry: EntryLike, prefix: string, out: PickedFile[]): Promise<void> {
  if (out.length >= MAX_FILES) return

  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry
    const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject))
    out.push({ file, path: prefix ? `${prefix}${file.name}` : undefined })
    return
  }

  if (entry.isDirectory) {
    const directory = entry as FileSystemDirectoryEntry
    const reader = directory.createReader()
    let batch: FileSystemEntry[] = []
    do {
      batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      for (const child of batch) {
        await walkEntry(child as EntryLike, `${prefix}${entry.name}/`, out)
      }
    } while (batch.length > 0 && out.length < MAX_FILES)
  }
}

export function filesFromList(list: FileList): PickedFile[] {
  return Array.from(list).map((file) => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
    return { file, path: relative || undefined }
  })
}

export function directoryInputSupported(): boolean {
  return typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype
}
