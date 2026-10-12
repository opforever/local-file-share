import { useEffect, type ReactNode } from 'react'
import { IconX } from './icons.tsx'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  icon?: ReactNode
  wide?: boolean
  children: ReactNode
}

export function Modal({ open, onClose, title, icon, wide, children }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={wide ? 'sheet sheet-wide' : 'sheet'} role="dialog" aria-modal="true">
        <div className="sheet-head">
          {icon}
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog">
            <IconX size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
