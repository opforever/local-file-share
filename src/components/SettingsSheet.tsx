import type { Settings } from '../hooks/useSettings.ts'
import { Modal } from './Modal.tsx'
import { IconGear } from './icons.tsx'

interface SettingsSheetProps {
  open: boolean
  onClose: () => void
  settings: Settings
  onUpdate: (patch: Partial<Settings>) => void
  connected: boolean
}

export function SettingsSheet({ open, onClose, settings, onUpdate, connected }: SettingsSheetProps) {
  return (
    <Modal open={open} onClose={onClose} title="Settings" icon={<IconGear size={18} />}>
      <label className="switch">
        <span>
          <strong style={{ display: 'block', fontSize: '0.92rem' }}>Verify integrity (SHA-256)</strong>
          <span className="hint">
            Streams a digest with every file and checks it on arrival. Costs CPU, so leave off when you want raw speed.
          </span>
        </span>
        <input type="checkbox" checked={settings.verify} onChange={(e) => onUpdate({ verify: e.target.checked })} />
      </label>

      <label className="switch">
        <span>
          <strong style={{ display: 'block', fontSize: '0.92rem' }}>Auto-save received files</strong>
          <span className="hint">Triggers a browser download as each file completes. Files also stay listed for manual saving.</span>
        </span>
        <input type="checkbox" checked={settings.autoSave} onChange={(e) => onUpdate({ autoSave: e.target.checked })} />
      </label>

      <label className="switch">
        <span>
          <strong style={{ display: 'block', fontSize: '0.92rem' }}>Internet fallback (public STUN)</strong>
          <span className="hint">
            Off by default so traffic never leaves your local network. Turn on only to bridge two different networks —
            applies the next time you pair.
          </span>
        </span>
        <input type="checkbox" checked={settings.allowRelay} onChange={(e) => onUpdate({ allowRelay: e.target.checked })} disabled={connected} />
      </label>

      <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: 'var(--space-4)' }}>
        Settings are stored only on this device. NearBeam has no account, no server storage and no analytics.
      </p>
    </Modal>
  )
}
