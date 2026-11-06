import { Modal } from './Modal.tsx'
import { IconBolt, IconLock, IconShield, IconWifi } from './icons.tsx'

interface AboutSheetProps {
  open: boolean
  onClose: () => void
}

const PRINCIPLES: Array<{ icon: typeof IconBolt; title: string; body: string }> = [
  {
    icon: IconWifi,
    title: 'Device to device',
    body: 'Files travel over a direct WebRTC data channel between the browsers. Speed depends on both devices, their actual Wi‑Fi link, and receive storage.',
  },
  {
    icon: IconLock,
    title: 'Browser transport',
    body: 'WebRTC requires transport encryption in browsers. NearBeam cannot turn it off; no extra file hashes or verification codes are added.',
  },
  {
    icon: IconShield,
    title: 'Local pairing only',
    body: 'The receiver runs the short-lived pairing helper on the LAN. No Redis, cloud signaling, STUN or TURN service is used.',
  },
  {
    icon: IconBolt,
    title: 'Built for big transfers',
    body: 'Chunked streaming with backpressure keeps memory bounded. Receives can write straight to disk where supported.',
  },
]

export function AboutSheet({ open, onClose }: AboutSheetProps) {
  return (
    <Modal open={open} onClose={onClose} title="How NearBeam works" wide>
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {PRINCIPLES.map(({ icon: Icon, title, body }) => (
          <div key={title} style={{ display: 'grid', gridTemplateColumns: '40px 1fr', gap: 'var(--space-3)' }}>
            <span
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                display: 'grid',
                placeItems: 'center',
                background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                color: 'var(--accent)',
              }}
            >
              <Icon size={20} />
            </span>
            <span>
              <strong style={{ display: 'block', marginBottom: 3 }}>{title}</strong>
              <span style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{body}</span>
            </span>
          </div>
        ))}

        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <div className="card-title">Pairing in one line</div>
          <p style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>
            The receiver displays a QR through the local helper; the sender scans it and the handshake completes
            automatically. Files then flow directly between devices.
          </p>
        </div>

        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <div className="card-title">Tips for top speed</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted)', fontSize: '0.9rem', display: 'grid', gap: 6 }}>
            <li>Keep both devices on the same network; 5 GHz Wi‑Fi or wired beats 2.4 GHz by a wide margin.</li>
            <li>Check both devices’ actual Wi‑Fi link speed; “5 GHz” is a band, not a throughput guarantee.</li>
            <li>On desktop, pick a save folder so files stream straight to disk.</li>
            <li>Keep the devices on the same local network and avoid guest Wi‑Fi or VPNs.</li>
          </ul>
        </div>

        <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
          NearBeam is open source and self-hostable. Run the local companion on the receiving device for one-scan
          pairing. Works best in current Chrome, Edge, Firefox and Safari.
        </p>
      </div>
    </Modal>
  )
}
