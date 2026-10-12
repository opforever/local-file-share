#!/usr/bin/env node
/**
 * End-to-end smoke test: two real headless Chrome instances pair over WebRTC
 * and move a file plus a text note between them, entirely through the built
 * app in dist/. Run: node scripts/e2e.mjs
 */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer'

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const SIZE = 3 * 1024 * 1024
const MARKER = `e2e-${Date.now().toString(36)}`

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
}

/* ------------------------------ static server ---------------------------- */

// Mirror the headers vercel.json ships so the suite also proves the production
// Content-Security-Policy does not break the app.
function securityHeaders(ext, pathname) {
  const headers = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy':
      'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), interest-cohort=()',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  }
  if (pathname === '/sw.js') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
  return headers
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/index.html'
    const filePath = normalize(join(DIST, pathname))
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end()
      return
    }
    const body = await readFile(filePath)
    res.writeHead(200, securityHeaders(extname(filePath), filePath))
    res.end(body)
  } catch {
    try {
      const body = await readFile(join(DIST, 'index.html'))
      res.writeHead(200, { ...securityHeaders('.html', '/index.html') })
      res.end(body)
    } catch {
      res.writeHead(404).end()
    }
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/`
console.log(`serving dist at ${base}`)

/* --------------------------------- helpers -------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function launch() {
  return puppeteer.launch({
    headless: true,
    userDataDir: mkdtempSync(join(tmpdir(), 'nb-e2e-')),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      // Expose real host candidates so two local browsers can find each other.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
}

async function clickByText(page, selector, text) {
  const clicked = await page.evaluate(
    (sel, txt) => {
      const nodes = [...document.querySelectorAll(sel)]
      const target = nodes.find((node) => (node.textContent || '').trim().toLowerCase().includes(txt.toLowerCase()))
      if (!target) return false
      target.click()
      return true
    },
    selector,
    text,
  )
  if (!clicked) throw new Error(`Could not click "${text}" (${selector})`)
}

async function setControlledValue(page, selector, value) {
  await page.evaluate(
    (sel, val) => {
      const element = document.querySelector(sel)
      if (!element) throw new Error(`Missing ${sel}`)
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(element, val)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    },
    selector,
    value,
  )
}

const readCode = (page) =>
  page.evaluate(() => {
    const box = document.querySelector('button.code-box')
    return box ? box.textContent.replace(/\s+/g, '') : null
  })

const waitConnected = (page) => page.waitForFunction(() => Boolean(document.querySelector('.workspace')), { timeout: 30000 })

/* ---------------------------------- test ---------------------------------- */

let failures = 0
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

const browserA = await launch()
const browserB = await launch()
const pageA = await browserA.newPage()
const pageB = await browserB.newPage()

// Let B actually write received files to disk so we can hash-verify them.
const downloadDir = mkdtempSync(join(tmpdir(), 'nb-dl-'))
const browserSession = await browserB.target().createCDPSession()
await browserSession.send('Browser.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: downloadDir,
  eventsEnabled: true,
})
for (const page of [pageA, pageB]) {
  page.on('pageerror', (error) => console.error('  [pageerror]', error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('  [console.error]', message.text())
  })
}

try {
  await pageA.goto(base, { waitUntil: 'networkidle0' })
  await pageB.goto(base, { waitUntil: 'networkidle0' })
  check('app boots on both devices', (await pageA.title()).includes('NearBeam'))

  // A hosts, B joins.
  await clickByText(pageA, 'button.role-card', 'Send files')
  await pageA.waitForFunction(() => Boolean(document.querySelector('button.code-box')), { timeout: 15000 })
  const invite = await readCode(pageA)
  check('host produces an invite code', Boolean(invite) && invite.startsWith('NB'), `${invite?.length ?? 0} chars`)

  await clickByText(pageB, 'button.role-card', 'Receive files')
  await pageB.waitForSelector('textarea.code-box', { timeout: 10000 })
  await setControlledValue(pageB, 'textarea.code-box', invite)
  await clickByText(pageB, 'button.btn-primary', 'Connect')
  await pageB.waitForFunction(() => Boolean(document.querySelector('button.code-box')), { timeout: 20000 })
  const response = await readCode(pageB)
  check('guest produces a response code', Boolean(response) && response.startsWith('NB'), `${response?.length ?? 0} chars`)

  await setControlledValue(pageA, 'textarea.code-box', response)
  await clickByText(pageA, 'button.btn-primary', 'Connect')

  await waitConnected(pageA)
  await waitConnected(pageB)
  check('both devices reach the connected workspace', true)

  const readSafety = (page) =>
    page.waitForFunction(() => {
      const text = document.querySelector('.stat .sub.mono')?.textContent ?? ''
      return /code [0-9A-F]{4}-/.test(text) ? text : false
    }, { timeout: 15000 })
  const [handleA, handleB] = await Promise.all([readSafety(pageA), readSafety(pageB)])
  const safetyA = String(await handleA.jsonValue())
  const safetyB = String(await handleB.jsonValue())
  check('safety codes match on both ends', safetyA === safetyB && safetyA.length > 0, safetyA.trim())

  // Send a 3 MB file from A to B (payload known here so we can verify bytes).
  const payloadBytes = randomBytes(SIZE)
  const expectedHex = createHash('sha256').update(payloadBytes).digest('hex')
  const payloadB64 = payloadBytes.toString('base64')
  await pageA.evaluate((b64) => {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const file = new File([bytes], 'e2e-sample.bin', { type: 'application/octet-stream' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const input = document.querySelector('input[type=file]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, payloadB64)

  await pageB.waitForFunction(
    () => [...document.querySelectorAll('.status-chip')].some((chip) => /done|verified/.test(chip.textContent)),
    { timeout: 60000 },
  )
  await pageA.waitForFunction(
    () => [...document.querySelectorAll('.status-chip')].some((chip) => /done|verified/.test(chip.textContent)),
    { timeout: 60000 },
  )
  const receivedName = await pageB.evaluate(() => document.querySelector('.titem .tname')?.textContent ?? '')
  check('file arrives intact and is marked done', receivedName === 'e2e-sample.bin', receivedName)

  // auto-save should have written the file; hash it and compare byte-for-byte.
  const downloaded = join(downloadDir, 'e2e-sample.bin')
  let actualHex = null
  for (let attempt = 0; attempt < 60 && !actualHex; attempt++) {
    await sleep(250)
    try {
      const buffer = await readFile(downloaded)
      if (buffer.length === SIZE) actualHex = createHash('sha256').update(buffer).digest('hex')
    } catch {
      /* still downloading */
    }
  }
  check('received bytes hash-identical to source', actualHex === expectedHex, actualHex ? actualHex.slice(0, 12) : 'no file')

  const speedText = await pageA.evaluate(() => {
    const stats = [...document.querySelectorAll('.stat .value')].map((node) => node.textContent)
    return stats.join(' | ')
  })
  console.log(`      live stats: ${speedText}`)

  // Beam a text note.
  await setControlledValue(pageA, '.textbeam textarea', `hello from A ${MARKER}`)
  await clickByText(pageA, 'button.btn-primary', 'Beam text')
  await pageB.waitForFunction((mark) => document.body.innerText.includes(mark), { timeout: 15000 }, MARKER)
  check('text note beams across', true)

  await sleep(500)
} catch (error) {
  failures++
  console.error('FAIL  unexpected error:', error)
  for (const [name, page] of [['A', pageA], ['B', pageB]]) {
    const state = await page.evaluate(() => ({
      pill: document.querySelector('.pill')?.textContent,
      body: document.body.innerText.slice(0, 400),
    }))
    console.error(`--- page ${name} state ---\n${JSON.stringify(state, null, 2)}`)
  }
} finally {
  await browserA.close()
  await browserB.close()
  server.close()
}

console.log(failures === 0 ? '\nE2E: all checks passed.' : `\nE2E: ${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
