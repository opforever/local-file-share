import type { Toast } from '../hooks/useToasts.ts'
import { IconAlert, IconCheck, IconInfo } from './icons.tsx'

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button key={toast.id} className={`toast is-${toast.kind}`} onClick={() => onDismiss(toast.id)}>
          <span className="tdot" />
          <span style={{ flex: 1, textAlign: 'left' }}>{toast.message}</span>
          {toast.kind === 'good' ? (
            <IconCheck size={16} />
          ) : toast.kind === 'info' ? (
            <IconInfo size={16} />
          ) : (
            <IconAlert size={16} />
          )}
        </button>
      ))}
    </div>
  )
}
