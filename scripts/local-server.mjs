#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)))
if (!existsSync(root)) {
  console.error('The built app was not found. Run `npm run build` first.')
  process.exit(1)
}

const port = Number(process.env.PORT ?? 4173)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be a valid TCP port.')
  process.exit(1)
}

const pairings = new Map()
const lifetimeMs = 5 * 60 * 1000
const maxBodyBytes = 64 * 1024
const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), interest-cohort=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
}
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
])

function firstLanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    const address = addresses?.find((item) => item.family === 'IPv4' && !item.internal)
    if (address) return address.address
  }
  return '127.0.0.1'
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...securityHeaders,
  })
  response.end(JSON.stringify(value))
}

function sendEmpty(response, status) {
  response.writeHead(status, { 'Cache-Control': 'no-store' })
  response.end()
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBodyBytes) throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function validCode(value) {
  return typeof value === 'string' && value.length <= maxBodyBytes && /^NB[ZR]1:[A-Za-z0-9_-]+$/.test(value)
}

function getPairing(id) {
  const pairing = pairings.get(id)
  if (!pairing) return null
  if (pairing.expiresAt <= Date.now()) {
    pairings.delete(id)
    return null
  }
  return pairing
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/info') {
    return sendJson(response, 200, { available: true })
  }

  if (url.pathname !== '/api/pairings') return sendJson(response, 404, { error: 'Not found.' })
  const id = url.searchParams.get('id')
  const field = url.searchParams.get('field')
  if (request.method === 'POST' && id === null && field === null) {
    const newId = randomBytes(32).toString('base64url')
    pairings.set(newId, { offer: null, answer: null, expiresAt: Date.now() + lifetimeMs })
    const address = firstLanAddress()
    return sendJson(response, 201, {
      id: newId,
      inviteUrl: `http://${address}:${port}/?pair=${encodeURIComponent(newId)}`,
    })
  }
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) {
    return sendJson(response, 400, { error: 'A valid pairing ID is required.' })
  }
  if (field !== null && field !== 'offer' && field !== 'answer') {
    return sendJson(response, 400, { error: 'Pairing field must be offer or answer.' })
  }

  const pairing = getPairing(id)
  if (!pairing) return sendJson(response, 410, { error: 'This pairing has expired or was cancelled.' })

  if (request.method === 'GET' && field === null) {
    if (!pairing.offer) return sendEmpty(response, 204)
    return sendJson(response, 200, { code: pairing.offer })
  }

  if (request.method === 'GET' && field === 'answer') {
    if (!pairing.answer) return sendEmpty(response, 204)
    pairings.delete(id)
    return sendJson(response, 200, { code: pairing.answer })
  }

  if (request.method === 'POST' && (field === 'offer' || field === 'answer')) {
    if (pairing[field]) return sendJson(response, 409, { error: `A pairing ${field} was already received.` })
    let body
    try {
      body = await readJson(request)
    } catch (error) {
      return sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body.' })
    }
    if (!validCode(body?.code)) return sendJson(response, 400, { error: `A valid NearBeam ${field} code is required.` })
    pairing[field] = body.code
    return sendEmpty(response, 204)
  }

  if (request.method === 'DELETE' && field === null) {
    pairings.delete(id)
    return sendEmpty(response, 204)
  }

  return sendJson(response, 405, { error: 'Method not allowed.' })
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  if (url.pathname.startsWith('/api/')) {
    void handleApi(request, response, url).catch((error) => {
      console.error('Local signaling request failed:', error)
      if (!response.headersSent) sendJson(response, 500, { error: 'The local signaling request failed.' })
      else response.destroy()
    })
    return
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendEmpty(response, 405)
    return
  }

  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    sendEmpty(response, 400)
    return
  }
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const file = resolve(root, relativePath)
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    sendEmpty(response, 403)
    return
  }
  const target = existsSync(file) && statSync(file).isFile() ? file : resolve(root, 'index.html')
  const isServiceWorker = target.endsWith(`${sep}sw.js`)
  const isHashedAsset = target.startsWith(`${resolve(root, 'assets')}${sep}`)
  response.writeHead(200, {
    'Cache-Control': target.endsWith(`${sep}index.html`) || isServiceWorker
      ? 'no-cache, no-store, must-revalidate'
      : isHashedAsset
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
    'Content-Type': mimeTypes.get(extname(target)) ?? 'application/octet-stream',
    ...(isServiceWorker ? { 'Service-Worker-Allowed': '/' } : {}),
    ...securityHeaders,
  })
  if (request.method === 'HEAD') response.end()
  else createReadStream(target).pipe(response)
})

const cleanup = setInterval(() => {
  for (const [id, pairing] of pairings) {
    if (pairing.expiresAt <= Date.now()) pairings.delete(id)
  }
}, 60_000)
cleanup.unref()

server.listen(port, '0.0.0.0', () => {
  console.log(`NearBeam local service is ready:`)
  console.log(`  This device: http://localhost:${port}/`)
  console.log(`  Other devices: http://${firstLanAddress()}:${port}/`)
  console.log('Use "Receive files" here to show a QR; the sender scans it to pair.')
  console.log('Keep this process running until pairing is complete.')
})

server.on('error', (error) => {
  console.error('Could not start the NearBeam local service:', error)
  process.exitCode = 1
})
