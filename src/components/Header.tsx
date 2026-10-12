import type { PairPhase } from '../hooks/usePeer.ts'
import type { ConnectionStats } from '../lib/rtc.ts'
import { IconGear, IconInfo, IconMoon, IconSun, IconX } from './icons.tsx'

interface HeaderProps {
  phase: PairPhase
  stats: ConnectionStats
  peerLabel: string | null
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onOpenSettings: () => void
  onOpenAbout: () => void
  onDisconnect: () => void
}

function statusFor(phase: PairPhase, stats: ConnectionStats): { text: string; tone: 'good' | 'warn' | 'bad' | 'idle'; live: boolean } {
  switch (phase) {
    case 'connected':
      if (stats.direct === false) return { text: 'Connected · relayed', tone: 'warn', live: true }
      return { text: 'Connected · direct', tone: 'good', live: true }
    case 'hosting':
      return { text: 'Waiting for peer', tone: 'warn', live: true }
    case 'joining':
      return { text: 'Connecting…', tone: 'warn', live: true }
    case 'failed':
      return { text: 'Disconnected', tone: 'bad', live: false }
    default:
      return { text: 'Ready', tone: 'idle', live: false }
  }
}

export function Header({ phase, stats, peerLabel, theme, onToggleTheme, onOpenSettings, onOpenAbout, onDisconnect }: HeaderProps) {
  const status = statusFor(phase, stats)
  const connected = phase === 'connected'

  return (
    <header className="header">
      <div className="header-inner">
        <span className="brand">
          <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
            <defs>
              <linearGradient id="nb-hdr" x1="4" y1="4" x2="60" y2="60" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#5ad1ff" />
                <stop offset="0.55" stopColor="#6f8dff" />
                <stop offset="1" stopColor="#a06bff" />
              </linearGradient>
            </defs>
            <rect x="2" y="2" width="60" height="60" rx="17" fill="url(#nb-hdr)" />
            <g fill="none" stroke="#06101f" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.93">
              <path d="M17 25.5h23.5l-6.5-6.5" />
              <path d="M47 38.5H23.5l6.5 6.5" />
            </g>
          </svg>
          <span>
            <span className="brand-name">NearBeam</span>
            <span className="brand-tag"> · nearby transfer</span>
          </span>
        </span>

        <span className="header-spacer" />

        <span className={`pill is-${status.tone} ${status.live ? 'is-live' : ''}`}>
          <span className="dot" />
          {connected && peerLabel ? `${peerLabel}` : status.text}
        </span>

        {connected && (
          <button className="icon-btn" onClick={onDisconnect} title="Disconnect" aria-label="Disconnect">
            <IconX size={18} />
          </button>
        )}

        <button className="icon-btn" onClick={onToggleTheme} title="Toggle theme" aria-label="Toggle colour theme">
          {theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings" aria-label="Settings">
          <IconGear size={18} />
        </button>
        <button className="icon-btn" onClick={onOpenAbout} title="About & privacy" aria-label="About and privacy">
          <IconInfo size={18} />
        </button>
      </div>
    </header>
  )
}
