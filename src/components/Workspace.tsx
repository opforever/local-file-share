import { useEffect, useMemo, useRef, useState } from 'react'
import type { BeamEngine, TransferItem } from '../lib/transfer.ts'
import type { ConnectionStats } from '../lib/rtc.ts'
import { formatBytes, formatEta, formatSpeed } from '../lib/format.ts'
import { directoryInputSupported, filesFromDataTransfer, filesFromList, type PickedFile } from '../lib/pickFiles.ts'
import type { Settings } from '../hooks/useSettings.ts'
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconFile,
  IconFolder,
  IconImage,
  IconLock,
  IconSend,
  IconText,
  IconTrash,
  IconUpload,
  IconX,
} from './icons.tsx'

export interface Note {
  id: string
  from: 'me' | 'peer'
  body: string
  at: number
}

export interface Sample {
  out: number
  in: number
}

interface WorkspaceProps {
  items: TransferItem[]
  stats: ConnectionStats
  samples: Sample[]
  settings: Settings
  folderName: string | null
  safetyCode: string | null
  peerLabel: string | null
  engine: BeamEngine | null
  notes: Note[]
  onSendFiles: (files: PickedFile[]) => void
  onSendText: (text: string) => void
  onPickFolder: () => void
  onCopyNote: (body: string) => void
  onClearNotes: () => void
  notify: (message: string, kind?: 'info' | 'good' | 'warn' | 'bad') => void
}

/* ------------------------------ sparkline ------------------------------- */

function Spark({ samples }: { samples: Sample[] }) {
  const paths = useMemo(() => {
    const window = samples.slice(-56)
    if (window.length < 2) return { out: '', in: '' }
    const peak = Math.max(1, ...window.map((s) => Math.max(s.out, s.in)))
    const toPoints = (pick: (s: Sample) => number) =>
      window
        .map((sample, index) => {
          const x = (index / (window.length - 1)) * 100
          const y = 38 - (pick(sample) / peak) * 34
          return `${x.toFixed(2)},${y.toFixed(2)}`
        })
        .join(' ')
    return { out: toPoints((s) => s.out), in: toPoints((s) => s.in) }
  }, [samples])

  return (
    <div className="spark" title="Throughput over the last minute">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={paths.out} fill="none" stroke="var(--accent)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        <polyline points={paths.in} fill="none" stroke="var(--accent-2)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

/* ------------------------------- thumbnails ------------------------------ */

function Thumb({ item }: { item: TransferItem }) {
  const url = useMemo(
    () => (item.file && item.mime.startsWith('image/') ? URL.createObjectURL(item.file) : null),
    [item.file, item.mime],
  )
  const [brokenFor, setBrokenFor] = useState<string | null>(null)
  const broken = url !== null && brokenFor === url
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url)
    },
    [url],
  )

  if (url && !broken) return <img src={url} alt="" onError={() => setBrokenFor(url)} />
  if (item.mime.startsWith('image/')) return <IconImage size={19} />
  if (item.mime.startsWith('text/') || item.mime.includes('json') || item.mime.includes('pdf')) return <IconText size={19} />
  return <IconFile size={19} />
}

/* ------------------------------ transfer row ----------------------------- */

function statusMeta(item: TransferItem): { label: string; tone: '' | 'is-done' | 'is-bad' | 'is-active' } {
  switch (item.status) {
    case 'queued':
      return { label: 'queued', tone: '' }
    case 'sending':
    case 'finishing':
      return { label: 'sending', tone: 'is-active' }
    case 'receiving':
      return { label: 'receiving', tone: 'is-active' }
    case 'done':
      return { label: item.verified === true ? 'verified' : 'done', tone: 'is-done' }
    case 'error':
      return { label: 'failed', tone: 'is-bad' }
    case 'canceled':
      return { label: 'canceled', tone: '' }
  }
}

function TransferRow({ item, engine }: { item: TransferItem; engine: BeamEngine | null }) {
  const meta = statusMeta(item)
  const active = item.status === 'sending' || item.status === 'receiving' || item.status === 'finishing'
  const percent = item.size > 0 ? Math.min(100, (item.transferred / item.size) * 100) : item.status === 'done' ? 100 : 0

  return (
    <div className="titem">
      <span className="ticon">
        <Thumb item={item} />
      </span>
      <span className="tmain">
        <span className="tname" title={item.path ?? item.name}>
          {item.name}
        </span>
        <span className="tmeta">
          <span>{formatBytes(item.size)}</span>
          {item.path && <span>· {item.path}</span>}
          <span className={`status-chip ${meta.tone}`}>{meta.label}</span>
          {item.error && <span style={{ color: 'var(--bad)' }}>· {item.error}</span>}
        </span>
        <div className={`progress ${item.status === 'done' ? 'is-done' : item.status === 'error' ? 'is-bad' : ''}`}>
          <i style={{ width: `${percent}%` }} />
        </div>
      </span>
      <span className="tside">
        <span className="tspeed">
          {active ? formatSpeed(item.speed) : item.status === 'done' ? formatEta(0, 0) : `${Math.round(percent)}%`}
        </span>
        {active || item.status === 'queued' ? (
          <button className="icon-btn" title="Cancel" aria-label={`Cancel ${item.name}`} onClick={() => engine?.cancelItem(item.id)}>
            <IconX size={16} />
          </button>
        ) : item.direction === 'in' && item.file && item.location !== 'folder' ? (
          <button className="icon-btn" title="Save" aria-label={`Save ${item.name}`} onClick={() => void engine?.saveReceived(item.id)}>
            <IconDownload size={16} />
          </button>
        ) : null}
      </span>
    </div>
  )
}

/* -------------------------------- dropzone ------------------------------- */

function Dropzone({ onFiles }: { onFiles: (files: PickedFile[]) => void }) {
  const [over, setOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const dirInput = useRef<HTMLInputElement>(null)
  const supportsDir = directoryInputSupported()

  return (
    <div
      className={`dropzone ${over ? 'is-over' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        void filesFromDataTransfer(event.dataTransfer).then(onFiles)
      }}
    >
      <span className="dz-icon">
        <IconUpload size={24} />
      </span>
      <h3>Drop files or folders here</h3>
      <p>Everything streams straight to the other device over your local network — no upload, no size cap.</p>
      <div className="dz-actions">
        <button className="btn btn-primary" onClick={() => fileInput.current?.click()}>
          <IconUpload size={16} />
          Choose files
        </button>
        {supportsDir && (
          <button className="btn" onClick={() => dirInput.current?.click()}>
            <IconFolder size={16} />
            Choose folder
          </button>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) onFiles(filesFromList(event.target.files))
          event.target.value = ''
        }}
      />
      <input
        ref={dirInput}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(event) => {
          if (event.target.files) onFiles(filesFromList(event.target.files))
          event.target.value = ''
        }}
      />
    </div>
  )
}

/* ------------------------------- workspace ------------------------------- */

export function Workspace(props: WorkspaceProps) {
  const { items, stats, samples, engine, notes, settings, folderName, safetyCode, peerLabel } = props
  const [draft, setDraft] = useState('')

  const outgoing = items.filter((item) => item.direction === 'out')
  const incoming = items.filter((item) => item.direction === 'in')
  const busyCount = items.filter((item) => item.status === 'sending' || item.status === 'receiving' || item.status === 'finishing').length

  const sendText = () => {
    if (!draft.trim()) return
    props.onSendText(draft)
    setDraft('')
  }

  return (
    <section className="workspace">
      <div className="col-left">
        <div className="statbar">
          <div className="stat">
            <div className="label">Sending</div>
            <div className="value">{formatSpeed(stats.sendRate)}</div>
            <div className="sub">{formatBytes(stats.bytesSent)} total</div>
          </div>
          <div className="stat">
            <div className="label">Receiving</div>
            <div className="value">{formatSpeed(stats.recvRate)}</div>
            <div className="sub">{formatBytes(stats.bytesReceived)} total</div>
          </div>
          <div className="stat">
            <div className="label">Round trip</div>
            <div className="value">{stats.rtt === null ? '—' : `${Math.round(stats.rtt)} ms`}</div>
            <div className="sub">{stats.direct === false ? 'relayed path' : 'direct path'}</div>
          </div>
          <div className="stat">
            <div className="label">Peer</div>
            <div className="value" style={{ fontSize: '0.98rem', lineHeight: 1.3 }}>
              {peerLabel ?? '—'}
            </div>
            <div className="sub mono" title="Compare aloud with the other device to confirm pairing">
              {safetyCode ? `code ${safetyCode}` : 'verifying…'}
            </div>
          </div>
          <Spark samples={samples} />
        </div>

        <div className="card" style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <div className="card-title">
            <IconUpload size={15} /> Send to {peerLabel ?? 'peer'}
            <span className="count">
              {busyCount > 0 ? `${busyCount} active` : `${outgoing.length} item${outgoing.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <Dropzone onFiles={props.onSendFiles} />
          {outgoing.length > 0 && (
            <>
              <div className="tlist">
                {outgoing.map((item) => (
                  <TransferRow key={item.id} item={item} engine={engine} />
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => engine?.clearFinished()}>
                  <IconTrash size={14} />
                  Clear finished
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="col-right">
        <div className="card" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <div className="card-title">
            <IconDownload size={15} /> Incoming
            <span className="count">
              {folderName ? `saving to ${folderName}` : settings.autoSave ? 'auto-save on' : 'manual save'}
            </span>
          </div>
          {incoming.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>Nothing received yet in this session.</p>
          ) : (
            <div className="tlist">
              {incoming.map((item) => (
                <TransferRow key={item.id} item={item} engine={engine} />
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button className="btn btn-sm" onClick={props.onPickFolder}>
              <IconFolder size={15} />
              {folderName ? 'Change folder' : 'Save into a folder…'}
            </button>
            {incoming.some((item) => item.file && item.location !== 'folder') && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  for (const item of incoming) {
                    if (item.file && item.location !== 'folder') void engine?.saveReceived(item.id)
                  }
                }}
              >
                <IconDownload size={15} />
                Save all
              </button>
            )}
          </div>
          <p style={{ color: 'var(--muted)', fontSize: '0.78rem', display: 'flex', gap: 6, alignItems: 'center' }}>
            <IconLock size={13} />
            {settings.verify ? 'Integrity verification (SHA-256) is on.' : 'Verification off for maximum speed — enable it in settings.'}
          </p>
        </div>

        <div className="card textbeam" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <div className="card-title">
            <IconText size={15} /> Clipboard beam
            <span className="count">{notes.length ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : ''}</span>
          </div>
          <textarea
            placeholder="Paste a link, address, or note and beam it across…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') sendText()
            }}
          />
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={sendText} disabled={!draft.trim()}>
              <IconSend size={15} />
              Beam text
            </button>
            {notes.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={props.onClearNotes}>
                <IconTrash size={14} />
                Clear
              </button>
            )}
          </div>
          {notes.length > 0 && (
            <div style={{ display: 'grid', gap: 'var(--space-2)', maxHeight: 220, overflowY: 'auto' }}>
              {notes
                .slice()
                .reverse()
                .map((note) => (
                  <div className="note" key={note.id}>
                    <span style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--muted)', fontSize: '0.74rem' }}>
                      <span>{note.from === 'me' ? 'You' : peerLabel ?? 'Peer'}</span>
                      <button className="icon-btn" style={{ width: 24, height: 24 }} title="Copy" onClick={() => props.onCopyNote(note.body)}>
                        <IconCopy size={13} />
                      </button>
                    </span>
                    <span>{note.body}</span>
                  </div>
                ))}
            </div>
          )}
        </div>

        {items.some((item) => item.verified === true) && (
          <p style={{ color: 'var(--good)', fontSize: '0.82rem', display: 'flex', gap: 6, alignItems: 'center' }}>
            <IconCheck size={14} /> Digests matched — files arrived bit-for-bit identical.
          </p>
        )}
      </div>
    </section>
  )
}
