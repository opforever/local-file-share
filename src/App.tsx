import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AboutSheet } from './components/AboutSheet.tsx'
import { Header } from './components/Header.tsx'
import { PairPanel } from './components/PairPanel.tsx'
import { ScannerSheet } from './components/ScannerSheet.tsx'
import { SettingsSheet } from './components/SettingsSheet.tsx'
import { Toasts } from './components/Toasts.tsx'
import { useToasts } from './hooks/useToasts.ts'
import { Workspace, type Note, type Sample } from './components/Workspace.tsx'
import {
  IconAlert,
  IconBolt,
  IconDevices,
  IconDownload,
  IconLock,
  IconRefresh,
  IconShield,
  IconUpload,
  IconWifi,
} from './components/icons.tsx'
import { usePeer } from './hooks/usePeer.ts'
import { useSettings, useTheme } from './hooks/useSettings.ts'
import { extractCode } from './lib/codec.ts'
import { copyText } from './lib/clipboard.ts'
import {
  cancelLocalPairing,
  createLocalPairing,
  extractLocalPairingId,
  getLocalAnswer,
  getLocalOffer,
  getLocalPairingInfo,
  isLocalPairingUrl,
  sendLocalAnswer,
  type LocalPairing,
} from './lib/localPairing.ts'
import type { PickedFile } from './lib/pickFiles.ts'
import { createSinkFactory, pickReceiveFolder, purgeOpfsInbox } from './lib/sinks.ts'
import { deviceLabel } from './lib/ua.ts'
import { BeamEngine, type BeamEvent, type TransferItem } from './lib/transfer.ts'

const EMPTY_ITEMS: TransferItem[] = []

type PairMode = 'choose' | 'host' | 'guest'

export default function App() {
  const { theme, toggle } = useTheme()
  const { settings, update } = useSettings()
  const { toasts, push, dismiss } = useToasts()

  const [pairMode, setPairMode] = useState<PairMode>('choose')
  const [guestAnswer, setGuestAnswer] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pairError, setPairError] = useState<string | null>(null)
  const [prefill, setPrefill] = useState<string | null>(null)
  const [localPairing, setLocalPairing] = useState<LocalPairing | null>(null)
  const [localAutoPair, setLocalAutoPair] = useState(false)

  const [engine, setEngine] = useState<BeamEngine | null>(null)
  const engineRef = useRef<BeamEngine | null>(null)
  const folderRef = useRef<FileSystemDirectoryHandle | null>(null)
  const [folderName, setFolderName] = useState<string | null>(null)

  const [peerLabel, setPeerLabel] = useState<string | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [samples, setSamples] = useState<Sample[]>([])

  const [scannerOpen, setScannerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const setEngineBoth = useCallback((next: BeamEngine | null) => {
    engineRef.current = next
    setEngine(next)
  }, [])

  const onEvent = useCallback(
    (event: BeamEvent) => {
      switch (event.type) {
        case 'peer-hello':
          setPeerLabel(event.label)
          break
        case 'file-done':
          push(`${event.item.name} ${event.item.direction === 'in' ? 'received' : 'sent'}.`, 'good')
          if (event.item.direction === 'in' && settingsRef.current.autoSave && event.item.location !== 'folder') {
            void engineRef.current?.saveReceived(event.item.id)
          }
          break
        case 'file-error':
          push(`${event.item.name} failed${event.item.error ? `: ${event.item.error}` : '.'}`, 'bad')
          break
        case 'text':
          setNotes((current) => [...current, { id: event.id, from: 'peer', body: event.body, at: event.at }])
          push('New text beamed in.', 'info')
          break
        case 'closed':
          break
      }
    },
    [push],
  )

  const onChannelOpen = useCallback(
    (channel: RTCDataChannel) => {
      const next = new BeamEngine(channel, {
        verify: settingsRef.current.verify,
        label: deviceLabel(),
        sinkFactory: createSinkFactory(() => folderRef.current),
        onEvent,
      })
      setEngineBoth(next)
      push(`Connected to the other device.`, 'good')
    },
    [onEvent, push, setEngineBoth],
  )

  const onChannelClosed = useCallback(
    (reason: string) => {
      if (!engineRef.current) return
      engineRef.current.dispose()
      setEngineBoth(null)
      push(reason, 'warn')
    },
    [push, setEngineBoth],
  )

  const peer = usePeer({
    settings: { allowRelay: settings.allowRelay },
    onChannelOpen,
    onChannelClosed,
  })
  const { acceptInvite, completeInvite, createInvite } = peer

  const items = useSyncExternalStore(
    useCallback((listener: () => void) => (engine ? engine.subscribe(listener) : () => {}), [engine]),
    useCallback(() => (engine ? engine.getSnapshot() : EMPTY_ITEMS), [engine]),
  )

  /* Roll a throughput history for the sparkline as stats tick in. */
  useEffect(() => {
    if (peer.phase !== 'connected') return
    setSamples((current) => [...current.slice(-89), { out: peer.stats.sendRate, in: peer.stats.recvRate }])
  }, [peer.stats, peer.phase])

  /* Dispose the engine whenever we leave the connected state. */
  useEffect(() => {
    if (peer.phase !== 'connected' && engineRef.current) {
      engineRef.current.dispose()
      setEngineBoth(null)
    }
    if (peer.phase === 'idle') {
      setPeerLabel(null)
      setNotes([])
      setSamples([])
    }
  }, [peer.phase, setEngineBoth])

  useEffect(() => {
    void purgeOpfsInbox()
  }, [])

  /* ------------------------------ actions ------------------------------ */

  const startHost = useCallback(async () => {
    setPairMode('host')
    setPairError(null)
    setGuestAnswer(null)
    setLocalAutoPair(false)
    setLocalPairing(null)
    setBusy(true)
    try {
      const code = await createInvite()
      try {
        const info = await getLocalPairingInfo()
        if (info) setLocalPairing(await createLocalPairing(code))
      } catch (error) {
        setPairError(
          `One-scan pairing could not start: ${error instanceof Error ? error.message : 'local service unavailable.'} You can still use the invite and response codes.`,
        )
      }
    } catch (error) {
      setPairError(error instanceof Error ? error.message : 'Could not create an invite.')
      setPairMode('choose')
    } finally {
      setBusy(false)
    }
  }, [createInvite])

  const startGuest = useCallback(() => {
    setPairMode('guest')
    setPairError(null)
    setGuestAnswer(null)
  }, [])

  const hostComplete = useCallback(
    async (code: string) => {
      setBusy(true)
      setPairError(null)
      try {
        await completeInvite(code)
      } catch (error) {
        setPairError(error instanceof Error ? error.message : 'That response code was not accepted.')
      } finally {
        setBusy(false)
      }
    },
    [completeInvite],
  )
  const hostCompleteRef = useRef(hostComplete)
  hostCompleteRef.current = hostComplete

  const guestAccept = useCallback(
    async (code: string) => {
      setPairMode('guest')
      setBusy(true)
      setPairError(null)
      try {
        const answer = await acceptInvite(code)
        setGuestAnswer(answer)
      } catch (error) {
        setPairError(error instanceof Error ? error.message : 'That invite code was not accepted.')
      } finally {
        setBusy(false)
      }
    },
    [acceptInvite],
  )

  const joinLocalPair = useCallback(
    async (id: string) => {
      setPairMode('guest')
      setPairError(null)
      setGuestAnswer(null)
      setLocalAutoPair(true)
      setBusy(true)
      try {
        const code = await getLocalOffer(id)
        const answer = await acceptInvite(code)
        try {
          await sendLocalAnswer(id, answer)
        } catch (error) {
          setGuestAnswer(answer)
          setLocalAutoPair(false)
          throw error
        }
      } catch (error) {
        setPairError(error instanceof Error ? error.message : 'Could not complete local pairing.')
        setLocalAutoPair(false)
      } finally {
        setBusy(false)
      }
    },
    [acceptInvite],
  )

  const localPairingId = localPairing?.id ?? null
  useEffect(() => {
    if (!localPairingId) return
    let active = true
    let inFlight = false
    let finished = false
    const poll = async () => {
      if (inFlight || finished) return
      inFlight = true
      try {
        const code = await getLocalAnswer(localPairingId)
        if (!active) return
        if (code) {
          finished = true
          await hostCompleteRef.current(code)
          if (active) setLocalPairing((current) => current?.id === localPairingId ? null : current)
        }
      } catch (error) {
        if (!active) return
        finished = true
        setPairError(error instanceof Error ? error.message : 'Could not receive the local pairing response.')
        setLocalPairing((current) => current?.id === localPairingId ? null : current)
      } finally {
        inFlight = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [localPairingId])

  const handleScanCode = useCallback(
    (raw: string) => {
      setScannerOpen(false)
      const pairingId = extractLocalPairingId(raw)
      if (pairingId) {
        try {
          const scannedUrl = new URL(raw)
          if (!isLocalPairingUrl(raw)) {
            setPairError('One-scan pairing links must point to an HTTP address on your local network.')
            setPairMode('guest')
            return
          }
          if (scannedUrl.origin !== window.location.origin) {
            window.location.assign(scannedUrl.href)
            return
          }
        } catch {
          // A local pairing ID can also be supplied without an absolute URL.
        }
        void joinLocalPair(pairingId)
        return
      }
      const code = extractCode(raw) ?? raw
      if (pairMode === 'host') void hostComplete(code)
      else void guestAccept(code)
    },
    [guestAccept, hostComplete, joinLocalPair, pairMode],
  )

  const handleDisconnect = useCallback(() => {
    engineRef.current?.dispose()
    setEngineBoth(null)
    peer.disconnect()
    setPairMode('choose')
    setGuestAnswer(null)
    setLocalAutoPair(false)
    if (localPairing) {
      void cancelLocalPairing(localPairing.id).catch((error: unknown) => {
        push(error instanceof Error ? error.message : 'Could not cancel local pairing.', 'warn')
      })
      setLocalPairing(null)
    }
    push('Disconnected.', 'info')
  }, [localPairing, peer, push, setEngineBoth])

  const handleSendFiles = useCallback(
    (picked: PickedFile[]) => {
      if (picked.length === 0) return
      if (!engineRef.current) {
        push('Connect to a device first.', 'warn')
        return
      }
      engineRef.current.enqueue(picked)
      push(`Queued ${picked.length} item${picked.length === 1 ? '' : 's'}.`, 'info')
    },
    [push],
  )

  const handleSendText = useCallback((text: string) => {
    engineRef.current?.sendText(text)
    setNotes((current) => [
      ...current,
      { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, from: 'me', body: text, at: Date.now() },
    ])
  }, [])

  const handlePickFolder = useCallback(async () => {
    const handle = await pickReceiveFolder()
    if (handle) {
      folderRef.current = handle
      setFolderName(handle.name)
      push(`Received files will save into “${handle.name}”.`, 'good')
    }
  }, [push])

  const handleCopyNote = useCallback(
    async (body: string) => {
      const ok = await copyText(body)
      push(ok ? 'Copied to clipboard.' : 'Copy failed.', ok ? 'good' : 'bad')
    },
    [push],
  )

  /* Paste images/files anywhere to queue them. */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length > 0 && engineRef.current) {
        event.preventDefault()
        engineRef.current.enqueue(files.map((file) => ({ file })))
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])

  /* Deep links: ?mode=send|receive (app shortcuts) and ?nb=<code> (invite). */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('nb')
    const pairingId = params.get('pair')
    const mode = params.get('mode')
    if (pairingId) {
      void joinLocalPair(pairingId)
    } else if (code) {
      setPairMode('guest')
      setPrefill(code)
      void guestAccept(code)
    } else if (mode === 'send') {
      void startHost()
    } else if (mode === 'receive') {
      setPairMode('guest')
    }
    if (code || pairingId || mode) window.history.replaceState(null, '', window.location.pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ------------------------------- render ------------------------------ */

  const connected = peer.phase === 'connected'
  const showPairPanel = !connected && peer.phase !== 'failed' && pairMode !== 'choose'

  return (
    <>
      <div className="app-bg" aria-hidden="true" />

      <Header
        phase={peer.phase}
        stats={peer.stats}
        peerLabel={peerLabel ?? peer.peerLabel}
        theme={theme}
        onToggleTheme={toggle}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
        onDisconnect={handleDisconnect}
      />

      <main className="app">
        <div className="shell">
          {connected ? (
            <Workspace
              items={items}
              stats={peer.stats}
              samples={samples}
              settings={settings}
              folderName={folderName}
              safetyCode={peer.safetyCode}
              peerLabel={peerLabel ?? peer.peerLabel}
              engine={engine}
              notes={notes}
              onSendFiles={handleSendFiles}
              onSendText={handleSendText}
              onPickFolder={() => void handlePickFolder()}
              onCopyNote={(body) => void handleCopyNote(body)}
              onClearNotes={() => setNotes([])}
              notify={push}
            />
          ) : showPairPanel ? (
            <PairPanel
              role={pairMode === 'host' ? 'host' : 'guest'}
              showCode={pairMode === 'host' ? peer.inviteCode : guestAnswer}
              showCodeKind={pairMode === 'host' ? 'invite' : 'response'}
              localPairUrl={localPairing?.inviteUrl ?? null}
              localAutoPair={localAutoPair}
              busy={busy}
              error={pairError}
              connected={connected}
              onScan={() => setScannerOpen(true)}
              onSubmitCode={(code) => (pairMode === 'host' ? hostComplete(code) : guestAccept(code))}
              onCancel={() => {
                peer.cancelPairing()
                setPairMode('choose')
                setGuestAnswer(null)
                setLocalAutoPair(false)
                if (localPairing) {
                  void cancelLocalPairing(localPairing.id).catch((error: unknown) => {
                    push(error instanceof Error ? error.message : 'Could not cancel local pairing.', 'warn')
                  })
                  setLocalPairing(null)
                }
              }}
              notify={push}
            />
          ) : peer.phase === 'failed' ? (
            <div className="card" style={{ display: 'grid', gap: 'var(--space-4)', justifyItems: 'center', textAlign: 'center' }}>
              <span style={{ color: 'var(--bad)' }}>
                <IconAlert size={34} />
              </span>
              <h2 style={{ fontSize: '1.2rem' }}>Connection problem</h2>
              <p style={{ color: 'var(--muted)', maxWidth: '46ch' }}>{peer.error}</p>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
                <button className="btn btn-primary" onClick={() => void startHost()}>
                  <IconRefresh size={16} />
                  Start a fresh invite
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    peer.cancelPairing()
                    setPairMode('choose')
                  }}
                >
                  Back to start
                </button>
              </div>
            </div>
          ) : (
            <Landing onSend={() => void startHost()} onReceive={startGuest} busy={busy} />
          )}

          {prefill && !connected && pairMode === 'guest' && !guestAnswer && (
            <p style={{ color: 'var(--muted)', fontSize: '0.82rem', textAlign: 'center' }}>
              An invite link was detected and is being connected automatically.
            </p>
          )}
        </div>
      </main>

      <footer className="footer">
        <div className="footer-inner">
          <span>NearBeam — direct, encrypted transfers between your own devices.</span>
          <span className="grow" />
          <span>No uploads · No accounts · Open source</span>
        </div>
      </footer>

      <ScannerSheet open={scannerOpen} onClose={() => setScannerOpen(false)} onCode={handleScanCode} />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onUpdate={update} connected={connected} />
      <AboutSheet open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  )
}

/* -------------------------------- landing -------------------------------- */

function Landing({ onSend, onReceive, busy }: { onSend: () => void; onReceive: () => void; busy: boolean }) {
  return (
    <section className="hero">
      <span className="hero-eyebrow">
        <IconWifi size={15} />
        Peer-to-peer over your local network
      </span>
      <h1 className="hero-title">
        Beam files at <span className="grad">LAN speed</span>.
      </h1>
      <p className="hero-sub">
        NearBeam opens a direct, encrypted channel between two nearby devices and streams files, folders and clipboard
        text straight across — no cloud, no size limits. Use the optional local service for one-scan pairing.
      </p>

      <div className="role-grid">
        <button className="role-card" onClick={onSend} disabled={busy}>
          <span className="role-icon">
            <IconUpload size={22} />
          </span>
          <h3>Send files</h3>
          <p>Create an invite QR on this device, then let the other device scan it to pair.</p>
        </button>
        <button className="role-card" onClick={onReceive} disabled={busy}>
          <span className="role-icon">
            <IconDownload size={22} />
          </span>
          <h3>Receive files</h3>
          <p>Scan a sender’s invite QR (or paste the code) and this device becomes the destination.</p>
        </button>
      </div>

      <div className="trust-strip">
        <span>
          <IconLock size={15} /> End-to-end encrypted
        </span>
        <span>
          <IconShield size={15} /> Nothing leaves your network
        </span>
        <span>
          <IconBolt size={15} /> Multi-gigabit capable
        </span>
        <span>
          <IconDevices size={15} /> Works offline once installed
        </span>
      </div>
    </section>
  )
}
