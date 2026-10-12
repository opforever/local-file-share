import { useCallback, useEffect, useRef, useState } from 'react'

export type ScannerState = 'idle' | 'starting' | 'scanning' | 'denied' | 'unsupported' | 'error'

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>
}

/**
 * Camera-based QR scanning. Prefers the platform `BarcodeDetector`
 * (Android/Chrome) and transparently falls back to the bundled pure-JS
 * jsQR decoder everywhere else. Frames are downsampled before decoding so
 * scanning stays cheap on phones.
 */
export function useScanner(onCode: (code: string) => void) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const detectorRef = useRef<BarcodeDetectorLike | null | undefined>(undefined)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runningRef = useRef(false)
  const onCodeRef = useRef(onCode)
  useEffect(() => {
    onCodeRef.current = onCode
  }, [onCode])

  const [state, setState] = useState<ScannerState>('idle')

  const stop = useCallback(() => {
    runningRef.current = false
    if (timerRef.current) clearTimeout(timerRef.current)
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setState('idle')
  }, [])

  useEffect(() => stop, [stop])

  const decodeFrame = useCallback(async (): Promise<string | null> => {
    const video = videoRef.current
    if (!video || video.readyState < 2) return null

    if (detectorRef.current === undefined) {
      const Ctor = (window as unknown as { BarcodeDetector?: new (opts: unknown) => BarcodeDetectorLike }).BarcodeDetector
      if (Ctor) {
        try {
          detectorRef.current = new Ctor({ formats: ['qr_code'] })
        } catch {
          detectorRef.current = null
        }
      } else {
        detectorRef.current = null
      }
    }

    if (detectorRef.current) {
      try {
        const results = await detectorRef.current.detect(video)
        if (results[0]?.rawValue) return results[0].rawValue
      } catch {
        /* fall through to the JS decoder */
      }
    }

    const maxWidth = 480
    const sourceWidth = video.videoWidth || maxWidth
    const sourceHeight = video.videoHeight || maxWidth
    const scale = Math.min(1, maxWidth / sourceWidth)
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))

    if (!canvasRef.current) canvasRef.current = document.createElement('canvas')
    const canvas = canvasRef.current
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, width, height)
    const image = ctx.getImageData(0, 0, width, height)

    const { default: jsQR } = await import('jsqr')
    return jsQR(image.data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null
  }, [])

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('unsupported')
      return
    }
    setState('starting')
    detectorRef.current = undefined
    canvasRef.current = null
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })
      streamRef.current = stream
      const video = videoRef.current
      if (!video) throw new Error('Camera view is not mounted yet')
      video.srcObject = stream
      video.setAttribute('playsinline', 'true')
      await video.play()
      runningRef.current = true
      setState('scanning')

      const tick = async () => {
        if (!runningRef.current) return
        try {
          const code = await decodeFrame()
          if (code) {
            runningRef.current = false
            onCodeRef.current(code)
            return
          }
        } catch {
          /* transient decode hiccup: keep scanning */
        }
        timerRef.current = setTimeout(() => void tick(), 90)
      }
      void tick()
    } catch (error) {
      const name = (error as DOMException)?.name
      setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error')
    }
  }, [decodeFrame])

  return { videoRef, state, start, stop }
}
