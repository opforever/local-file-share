#!/usr/bin/env node
/**
 * Large-transfer test: pushes a 120 MiB file so the receiver exercises the
 * OPFS disk sink (used above MEMORY_SINK_LIMIT) and the auto-save download,
 * then hash-compares the landed bytes against the source.
 * Run: node scripts/e2e-large.mjs
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer'

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const SIZE = 120 * 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/index.html'
    const body = await readFile(normalize(join(DIST, pathname)))
    res.writeHead(200, { 'Content-Type': MIME[extname(pathname)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    const body = await readFile(join(DIST, 'index.html'))
    res.writeHead(200, { 'Content-Type': MIME['.html'] })
    res.end(body)
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch() {
  return puppeteer.launch({
    headless: true,
    userDataDir: mkdtempSync(join(tmpdir(), 'nb-big-')),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  })
}

const clickByText = (page, selector, text) =>
  page.evaluate(
    (sel, txt) => {
      const target = [...document.querySelectorAll(sel)].find((n) =>
        (n.textContent || '').trim().toLowerCase().includes(txt.toLowerCase()),
      )
      target?.click()
    },
    selector,
    text,
  )

const setValue = (page, selector, value) =>
  page.evaluate(
    (sel, val) => {
      const el = document.querySelector(sel)
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    },
    selector,
    value,
  )

const readCode = (page) => page.evaluate(() => document.querySelector('button.code-box')?.textContent.replace(/\s+/g, '') ?? null)

const browserA = await launch()
const browserB = await launch()
const pageA = await browserA.newPage()
const pageB = await browserB.newPage()

const downloadDir = mkdtempSync(join(tmpdir(), 'nb-big-dl-'))
const session = await browserB.target().createCDPSession()
await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true })

let failed = 0
try {
  await pageA.goto(base, { waitUntil: 'networkidle0' })
  await pageB.goto(base, { waitUntil: 'networkidle0' })

  await clickByText(pageA, 'button.role-card', 'Send files')
  await pageA.waitForFunction(() => Boolean(document.querySelector('button.code-box')), { timeout: 15000 })
  const invite = await readCode(pageA)
  await clickByText(pageB, 'button.role-card', 'Receive files')
  await pageB.waitForSelector('textarea.code-box', { timeout: 10000 })
  await setValue(pageB, 'textarea.code-box', invite)
  await clickByText(pageB, 'button.btn-primary', 'Connect')
  await pageB.waitForFunction(() => Boolean(document.querySelector('button.code-box')), { timeout: 20000 })
  const response = await readCode(pageB)
  await setValue(pageA, 'textarea.code-box', response)
  await clickByText(pageA, 'button.btn-primary', 'Connect')
  for (const page of [pageA, pageB]) {
    await page.waitForFunction(() => Boolean(document.querySelector('.workspace')), { timeout: 30000 })
  }
  console.log('connected; starting 120 MiB transfer…')

  const started = Date.now()
  const sourceHex = await pageA.evaluate(async (size) => {
    const bytes = new Uint8Array(size)
    for (let offset = 0; offset < size; offset += 65536) {
      crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, size)))
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'large-sample.bin', { type: 'application/octet-stream' }))
    const input = document.querySelector('input[type=file]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return hex
  }, SIZE)

  for (const page of [pageA, pageB]) {
    await page.waitForFunction(
      () => [...document.querySelectorAll('.status-chip')].some((c) => /done|verified/.test(c.textContent)),
      { timeout: 600000 },
    )
  }
  const seconds = (Date.now() - started) / 1000
  console.log(`transfer completed in ${seconds.toFixed(1)}s (${(SIZE / 1e6 / seconds).toFixed(1)} MB/s effective)`)

  const target = join(downloadDir, 'large-sample.bin')
  let landedHex = null
  for (let attempt = 0; attempt < 240 && !landedHex; attempt++) {
    await sleep(500)
    try {
      const buffer = await readFile(target)
      if (buffer.length === SIZE) landedHex = createHash('sha256').update(buffer).digest('hex')
    } catch {
      /* still landing */
    }
  }
  if (landedHex === sourceHex) console.log('PASS  120 MiB received byte-identical via OPFS sink + auto-save')
  else {
    failed++
    console.error(`FAIL  hash mismatch (landed=${landedHex ?? 'none'}, source=${sourceHex})`)
  }
} catch (error) {
  failed++
  console.error('FAIL  unexpected error:', error)
} finally {
  await browserA.close()
  await browserB.close()
  server.close()
}
process.exit(failed === 0 ? 0 : 1)
