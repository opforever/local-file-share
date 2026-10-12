/** Human-facing formatting helpers shared across the UI. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** 1234567 -> "1.2 MB" (decimal units, which is what people expect for files). */
export function formatBytes(bytes: number, fractionDigits?: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1) return '0 B'
  const exponent = Math.min(Math.floor(Math.log10(bytes) / 3), UNITS.length - 1)
  const value = bytes / 1000 ** exponent
  const digits = fractionDigits ?? (value >= 100 ? 0 : value >= 10 ? 1 : 2)
  return `${value.toFixed(digits)} ${UNITS[exponent]}`
}

/** Bytes per second -> "184 MB/s". */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s'
  return `${formatBytes(bytesPerSecond)}/s`
}

/** Milliseconds -> "1:07" or "1h 04m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Remaining time given a byte count and the current smoothed speed. */
export function formatEta(bytesLeft: number, bytesPerSecond: number): string {
  if (bytesLeft <= 0) return 'done'
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 1024) return '…'
  return `${formatDuration((bytesLeft / bytesPerSecond) * 1000)} left`
}

/** A short "HH:MM" style clock for logs and timestamps. */
export function formatClock(date: Date = new Date()): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Split a path-ish string into a display name plus its containing folder. */
export function splitPath(path: string): { name: string; dir: string } {
  const parts = path.split(/[/\\]+/).filter(Boolean)
  const name = parts.pop() ?? path
  return { name, dir: parts.join('/') }
}

/**
 * Guard a downloaded filename so a remote peer cannot smuggle in path
 * separators or drive-relative tricks. Everything lands flat in Downloads.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'file'
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 200) : 'file'
}
