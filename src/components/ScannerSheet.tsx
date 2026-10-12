import { useEffect } from 'react'
import { useScanner } from '../hooks/useScanner.ts'
import { Modal } from './Modal.tsx'
import { IconAlert, IconCamera, IconRefresh, IconScan } from './icons.tsx'

interface ScannerSheetProps {
  open: boolean
  onClose: () => void
  onCode: (code: string) => void
}

export function ScannerSheet({ open, onClose, onCode }: ScannerSheetProps) {
  const scanner = useScanner(onCode)

  useEffect(() => {
    if (!open) {
      scanner.stop()
      return
    }
    const timer = setTimeout(() => void scanner.start(), 80)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const close = () => {
    scanner.stop()
    onClose()
  }

  return (
    <Modal open={open} onClose={close} title="Scan a NearBeam code" icon={<IconScan size={18} />}>
      <div className="scanner-frame">
        <video ref={scanner.videoRef} className="scanner-video" muted playsInline autoPlay />
      </div>
      <p style={{ color: 'var(--muted)', fontSize: '0.88rem', marginBlock: 'var(--space-3)' }}>
        {scanner.state === 'starting' && 'Starting the camera…'}
        {scanner.state === 'scanning' && 'Line the other device’s QR code up inside the frame.'}
        {scanner.state === 'denied' && 'Camera access was blocked. Allow it in your browser’s site settings, or paste the code instead.'}
        {scanner.state === 'unsupported' && 'This browser can’t open a camera. Paste the code instead.'}
        {scanner.state === 'error' && 'The camera could not start. Paste the code instead.'}
        {scanner.state === 'idle' && 'The camera is off.'}
      </p>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {(scanner.state === 'denied' || scanner.state === 'error' || scanner.state === 'idle' || scanner.state === 'unsupported') && (
          <button className="btn btn-primary" onClick={() => void scanner.start()}>
            {scanner.state === 'idle' ? <IconCamera size={16} /> : <IconRefresh size={16} />}
            {scanner.state === 'idle' ? 'Start camera' : 'Try again'}
          </button>
        )}
        <button className="btn btn-ghost" onClick={close}>
          Done
        </button>
      </div>
      {(scanner.state === 'denied' || scanner.state === 'unsupported' || scanner.state === 'error') && (
        <p style={{ color: 'var(--warn)', fontSize: '0.82rem', marginTop: 'var(--space-3)', display: 'flex', gap: 6 }}>
          <IconAlert size={14} /> Pasting the code works exactly the same way — no camera needed.
        </p>
      )}
    </Modal>
  )
}
