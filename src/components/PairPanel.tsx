import { useState } from 'react'
import { buildInviteUrl, wrapCode } from '../lib/codec.ts'
import { canShare, copyText, shareText } from '../lib/clipboard.ts'
import { QrImage } from './QrImage.tsx'
import { IconCamera, IconCheck, IconCopy, IconLink, IconScan, IconSend, IconX } from './icons.tsx'

interface PairPanelProps {
  role: 'host' | 'guest'
  showCode: string | null
  showCodeKind: 'invite' | 'response'
  busy: boolean
  error: string | null
  connected: boolean
  onScan: () => void
  onSubmitCode: (code: string) => Promise<void>
  onCancel: () => void
  notify: (message: string, kind?: 'info' | 'good' | 'warn' | 'bad') => void
}

export function PairPanel({
  role,
  showCode,
  showCodeKind,
  busy,
  error,
  connected,
  onScan,
  onSubmitCode,
  onCancel,
  notify,
}: PairPanelProps) {
  const [paste, setPaste] = useState('')
  const [copied, setCopied] = useState<'code' | 'link' | null>(null)

  const isHost = role === 'host'

  const doCopy = async (kind: 'code' | 'link') => {
    if (!showCode) return
    const value = kind === 'link' ? buildInviteUrl(showCode) : showCode
    const ok = await copyText(value)
    if (ok) {
      setCopied(kind)
      setTimeout(() => setCopied(null), 1600)
      notify(kind === 'link' ? 'Invite link copied.' : 'Code copied.', 'good')
    } else {
      notify('Could not access the clipboard.', 'bad')
    }
  }

  const doShare = async () => {
    if (!showCode) return
    const ok = await shareText('NearBeam invite', buildInviteUrl(showCode))
    if (!ok) await doCopy('link')
  }

  const submit = async () => {
    if (!paste.trim() || busy) return
    await onSubmitCode(paste.trim())
    setPaste('')
  }

  const needsInput = isHost ? !connected : !showCode && !connected

  return (
    <section className="pair-grid">
      {/* Left: what this device shows the other device. */}
      <div className="card" style={{ display: 'grid', gap: 'var(--space-4)', justifyItems: 'stretch' }}>
        <div className="card-title">
          {showCode
            ? showCodeKind === 'invite'
              ? 'Show this invite'
              : 'Show this response'
            : isHost
              ? 'Show this invite'
              : 'Scan the invite'}
        </div>

        {showCode ? (
          <>
            <QrImage value={showCode} label={showCodeKind === 'invite' ? 'Invite QR code' : 'Response QR code'} />
            <button className="code-box" onClick={() => void doCopy('code')} title="Tap to copy">
              {wrapCode(showCode)}
            </button>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              <button className="btn btn-sm" onClick={() => void doCopy('code')}>
                {copied === 'code' ? <IconCheck size={15} /> : <IconCopy size={15} />}
                {copied === 'code' ? 'Copied' : 'Copy code'}
              </button>
              {showCodeKind === 'invite' && (
                <>
                  <button className="btn btn-sm" onClick={() => void doCopy('link')}>
                    {copied === 'link' ? <IconCheck size={15} /> : <IconLink size={15} />}
                    {copied === 'link' ? 'Copied' : 'Copy link'}
                  </button>
                  {canShare() && (
                    <button className="btn btn-sm" onClick={() => void doShare()}>
                      <IconSend size={15} />
                      Share
                    </button>
                  )}
                </>
              )}
              <button className="btn btn-sm btn-ghost" onClick={onScan}>
                <IconScan size={15} />
                Scan instead
              </button>
            </div>
          </>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-3)', justifyItems: 'center', padding: 'var(--space-5) 0' }}>
            <span className="role-icon" style={{ width: 52, height: 52, borderRadius: 16, display: 'grid', placeItems: 'center', background: 'var(--surface-2)', color: 'var(--accent)' }}>
              <IconCamera size={24} />
            </span>
            <p style={{ color: 'var(--muted)', fontSize: '0.9rem', textAlign: 'center', maxWidth: '30ch' }}>
              {isHost ? 'Creating your invite…' : 'Scan the sender’s QR code, or paste their invite below.'}
            </p>
            <button className="btn btn-primary" onClick={onScan}>
              <IconScan size={17} />
              Scan a QR code
            </button>
          </div>
        )}
      </div>

      {/* Right: what this device needs from the other device. */}
      <div className="card" style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div className="card-title">{isHost ? 'Get the response back' : 'Get the invite'}</div>

        <ol className="step-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {isHost ? (
            <>
              <li className="step">
                <span>
                  On the other device open NearBeam and pick <strong>Receive</strong>, then scan the invite QR.
                </span>
              </li>
              <li className="step">
                <span>
                  That device shows a <strong>response</strong> QR — scan it here, or paste its code below.
                </span>
              </li>
              <li className="step">
                <span>You’re paired. Files stream device-to-device; nothing touches a server.</span>
              </li>
            </>
          ) : (
            <>
              <li className="step">
                <span>
                  On the sending device pick <strong>Send</strong> so it shows an invite QR.
                </span>
              </li>
              <li className="step">
                <span>Scan it here or paste the invite code, then connect.</span>
              </li>
              <li className="step">
                <span>Show your response QR back to the sender to finish pairing.</span>
              </li>
            </>
          )}
        </ol>

        {needsInput && (
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <textarea
              className="code-box"
              style={{ maxHeight: 150, minHeight: 96 }}
              placeholder={
                isHost
                  ? 'Paste the response code (or invite link) from the receiving device…'
                  : 'Paste the invite code (or invite link) from the sending device…'
              }
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              spellCheck={false}
            />
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => void submit()} disabled={busy || !paste.trim()}>
                {busy ? <span className="spin" /> : <IconSend size={16} />}
                {busy ? 'Connecting…' : isHost ? 'Connect' : 'Connect & respond'}
              </button>
              <button className="btn btn-ghost" onClick={onScan} disabled={busy}>
                <IconScan size={16} />
                Scan
              </button>
            </div>
          </div>
        )}

        {!needsInput && !connected && (
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
            Waiting for the other device to finish the handshake… keep both screens open.
          </p>
        )}

        {error && (
          <p style={{ color: 'var(--bad)', fontSize: '0.88rem' }} role="alert">
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            <IconX size={15} />
            Cancel pairing
          </button>
        </div>
      </div>
    </section>
  )
}
