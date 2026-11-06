import type { Settings } from '../hooks/useSettings.ts'
import { Modal } from './Modal.tsx'
import { IconGear } from './icons.tsx'

interface SettingsSheetProps {
  open: boolean
  onClose: () => void
  settings: Settings
  onUpdate: (patch: Partial<Settings>) => void
}

export function SettingsSheet({ open, onClose, settings, onUpdate }: SettingsSheetProps) {
  return (
    <Modal open={open} onClose={onClose} title="Settings" icon={<IconGear size={18} />}>
      <label className="switch">
        <span>
          <strong style={{ display: 'block', fontSize: '0.92rem' }}>Auto-save received files</strong>
          <span className="hint">Triggers a browser download as each file completes. Files also stay listed for manual saving.</span>
        </span>
        <input type="checkbox" checked={settings.autoSave} onChange={(e) => onUpdate({ autoSave: e.target.checked })} />
      </label>

      <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: 'var(--space-4)' }}>
        Transfers stay on your LAN. Browsers require WebRTC transport encryption; it cannot be turned off.
        Settings are stored only on this device.
      </p>
    </Modal>
  )
}
