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
    body: 'Files travel over a direct WebRTC data channel between the two browsers. On the same Wi‑Fi or Ethernet that means full LAN throughput — often hundreds of MB/s — with no relay in the middle.',
  },
  {
    icon: IconLock,
    title: 'Encrypted in transit',
    body: 'Every data channel is DTLS‑encrypted end to end. The pairing codes only carry the handshake; your files are never readable by anyone else, and nothing is uploaded.',
  },
  {
    icon: IconShield,
    title: 'No server, no account',
    body: 'The website is just static files. Pairing happens by showing a QR code or pasting a code between your own devices — there is no backend storing or routing your data.',
  },
  {
    icon: IconBolt,
    title: 'Built for big transfers',
    body: 'Chunked streaming with backpressure keeps memory flat, receives are written straight to disk where supported, and folders, resume-friendly queues and optional SHA‑256 verification are included.',
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
            One device creates an invite (a compressed WebRTC offer) and shows it as a QR code or link. The other device
            answers the same way. Those two short codes are the entire “server”.
          </p>
        </div>

        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <div className="card-title">Tips for top speed</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted)', fontSize: '0.9rem', display: 'grid', gap: 6 }}>
            <li>Keep both devices on the same network; 5 GHz Wi‑Fi or wired beats 2.4 GHz by a wide margin.</li>
            <li>Leave “Verify integrity” off when speed matters more than a checksum.</li>
            <li>On desktop, pick a save folder so files stream straight to disk.</li>
            <li>Install NearBeam as an app to use it on a LAN with no internet at all.</li>
          </ul>
        </div>

        <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
          NearBeam is open source and self-hostable — deploy the static build anywhere (Vercel, Netlify, GitHub Pages,
          or your own box). Works best in current Chrome, Edge, Firefox and Safari.
        </p>
      </div>
    </Modal>
  )
}
