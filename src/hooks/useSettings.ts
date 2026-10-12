import { useCallback, useEffect, useState } from 'react'

/* --------------------------------- theme --------------------------------- */

const THEME_KEY = 'nearbeam:theme'

export type Theme = 'dark' | 'light'

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  )

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* storage unavailable */
    }
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#070b14' : '#f4f7fc')
  }, [theme])

  const toggle = useCallback(() => setTheme((current) => (current === 'dark' ? 'light' : 'dark')), [])
  return { theme, toggle }
}

/* -------------------------------- settings ------------------------------- */

const SETTINGS_KEY = 'nearbeam:settings'

export interface Settings {
  /** Stream a SHA-256 digest alongside each file and verify on arrival. */
  verify: boolean
  /** Allow public STUN so peers on different networks can still connect. */
  allowRelay: boolean
  /** Trigger a browser download automatically when a file completes. */
  autoSave: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  verify: false,
  allowRelay: false,
  autoSave: true,
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
    } catch {
      /* fall back to defaults */
    }
    return DEFAULT_SETTINGS
  })

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      /* storage unavailable */
    }
  }, [settings])

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }))
  }, [])

  return { settings, update }
}
