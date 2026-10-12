#!/usr/bin/env node
/**
 * Captures product screenshots (desktop + mobile) from the built app.
 * Requires a local, non-committed Puppeteer install: npm i -D puppeteer
 * Run: node scripts/screenshots.mjs
 */
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import puppeteer from 'puppeteer'

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const OUT = join(ROOT, 'docs', 'screenshots')
const SIZE = 2 * 1024 * 1024

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
    const filePath = normalize(join(DIST, pathname))
    const body = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    const body = await readFile(join(DIST, 'index.html'))
    res.writeHead(200, { 'Content-Type': MIME['.html'] })
    res.end(body)
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/`

await mkdir(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch(viewport) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  })
  const page = await browser.newPage()
  await page.setViewport(viewport)
  return { browser, page }
}

async function clickByText(page, selector, text) {
  await page.evaluate(
    (sel, txt) => {
      const target = [...document.querySelectorAll(sel)].find((n) =>
        (n.textContent || '').trim().toLowerCase().includes(txt.toLowerCase()),
      )
      target?.click()
    },
    selector,
    text,
  )
}

async function setControlledValue(page, selector, value) {
  await page.evaluate(
    (sel, val) => {
      const el = document.querySelector(sel)
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    },
    selector,
    value,
  )
}

const readCode = (page) =>
  page.evaluate(() => document.querySelector('button.code-box')?.textContent.replace(/\s+/g, '') ?? null)

const desktop = await launch({ width: 1440, height: 900, deviceScaleFactor: 2 })
const mobile = await launch({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })

await desktop.page.goto(base, { waitUntil: 'networkidle0' })
await mobile.page.goto(base, { waitUntil: 'networkidle0' })
await sleep(400)
await desktop.page.screenshot({ path: join(OUT, 'landing-desktop.png') })
await mobile.page.screenshot({ path: join(OUT, 'landing-mobile.png') })

// Pair desktop (host) with mobile (guest), then show the live workspace.
await clickByText(desktop.page, 'button.role-card', 'Send files')
await desktop.page.waitForFunction(() => Boolean(document.querySelector('button.code-box')), { timeout: 15000 })
const invite = await readCode(desktop.page)
await desktop.page.screenshot({ path: join(OUT, 'pairing-desktop.png') })

await clickByText(mobile.page, 'button.role-card', 'Receive files')
await mobile.page.waitForSelector('textarea.code-box', { timeout: 10000 })
await setControlledValue(mobile.page, 'textarea.code-box', invite)
await clickByText(mobile.page, 'button.btn-primary', 'Connect')
await mobile.page.waitForFunction(() => Boolean(document.querySelector('button.code-box')), { timeout: 20000 })
const response = await readCode(mobile.page)
await mobile.page.screenshot({ path: join(OUT, 'pairing-mobile.png') })

await setControlledValue(desktop.page, 'textarea.code-box', response)
await clickByText(desktop.page, 'button.btn-primary', 'Connect')
for (const page of [desktop.page, mobile.page]) {
  await page.waitForFunction(() => Boolean(document.querySelector('.workspace')), { timeout: 30000 })
}

// Kick off a transfer so the workspace shows live progress/results.
await desktop.page.evaluate((size) => {
  const bytes = new Uint8Array(size)
  for (let offset = 0; offset < size; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, size)))
  }
  const transfer = new DataTransfer()
  transfer.items.add(new File([bytes], 'quarterly-report.pdf', { type: 'application/pdf' }))
  transfer.items.add(new File([bytes.subarray(0, 400_000)], 'cover-art.png', { type: 'image/png' }))
  const input = document.querySelector('input[type=file]')
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}, SIZE)

await desktop.page.waitForFunction(
  () => [...document.querySelectorAll('.status-chip')].filter((c) => /done|verified/.test(c.textContent)).length >= 2,
  { timeout: 60000 },
)
await mobile.page.waitForFunction(
  () => [...document.querySelectorAll('.status-chip')].filter((c) => /done|verified/.test(c.textContent)).length >= 2,
  { timeout: 60000 },
)
await sleep(600)
await desktop.page.screenshot({ path: join(OUT, 'workspace-desktop.png') })
await mobile.page.screenshot({ path: join(OUT, 'workspace-mobile.png') })

await desktop.browser.close()
await mobile.browser.close()
server.close()
console.log('screenshots written to docs/screenshots/')
