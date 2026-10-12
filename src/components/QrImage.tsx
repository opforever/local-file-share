import { useEffect, useState } from 'react'

interface QrResult {
  forValue: string
  svg: string | null
  failed: boolean
}

/** Renders an invite/response code as an inline SVG QR code (lazy-loaded). */
export function QrImage({ value, label }: { value: string; label: string }) {
  const [result, setResult] = useState<QrResult>({ forValue: '', svg: null, failed: false })
  const loading = result.forValue !== value

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const { toString } = await import('qrcode')
        const markup = await toString(value, {
          type: 'svg',
          margin: 1,
          errorCorrectionLevel: 'M',
          color: { dark: '#0b1220', light: '#ffffff' },
        })
        if (live) setResult({ forValue: value, svg: markup, failed: false })
      } catch {
        if (live) setResult({ forValue: value, svg: null, failed: true })
      }
    })()
    return () => {
      live = false
    }
  }, [value])

  return (
    <div className="qr-frame">
      {loading ? (
        <span
          className="spin"
          style={{ width: 26, height: 26, border: '3px solid #94a3b8', borderTopColor: 'transparent', borderRadius: '50%' }}
        />
      ) : result.failed ? (
        <p style={{ color: '#33415c', fontSize: '0.85rem', padding: 12 }}>
          QR rendering unavailable here — share the code text instead.
        </p>
      ) : (
        <span role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: result.svg ?? '' }} />
      )}
    </div>
  )
}
