import { useCallback, useRef, useState } from 'react'

export type ToastKind = 'info' | 'good' | 'warn' | 'bad'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = nextId.current++
      setToasts((current) => [...current.slice(-3), { id, kind, message }])
      setTimeout(() => dismiss(id), 4600)
    },
    [dismiss],
  )

  return { toasts, push, dismiss }
}
