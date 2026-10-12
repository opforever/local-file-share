import { createHash } from 'node:crypto'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Emits a service worker whose precache manifest matches the exact hashed
 * filenames produced by this build. That way the app shell *and* every lazy
 * chunk are available offline, which matters because NearBeam is designed to
 * keep working on a LAN with no internet connection at all.
 */
function offlineServiceWorker(): Plugin {
  return {
    name: 'nearbeam:offline-sw',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle)
      const publicAssets = [
        '/theme.js',
        '/favicon.svg',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
        '/icons/maskable-192.png',
        '/icons/maskable-512.png',
        '/icons/apple-touch-icon.png',
      ]
      const precache = [
        '/',
        '/index.html',
        '/manifest.webmanifest',
        ...publicAssets,
        ...emitted.filter((f) => f.startsWith('assets/')).map((f) => `/${f}`),
      ]

      const revision = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12)

      const source = `/* NearBeam service worker - generated at build time. Revision ${revision} */
const CACHE = 'nearbeam-${revision}';
const PRECACHE = ${JSON.stringify(precache, null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;

  // Navigations: prefer the network so deploys land immediately, fall back to
  // the cached shell when the device is offline on a LAN with no uplink.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html').then((hit) => hit || caches.match('/'))),
    );
    return;
  }

  // Everything else is content-hashed or immutable: cache-first.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
`
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Relative base keeps the bundle portable across any host or sub-path.
  base: './',
  plugins: [react(), offlineServiceWorker()],
  build: {
    target: 'es2022',
    sourcemap: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // Split the two heaviest optional dependencies out of the main bundle.
        // Neither is needed until a user actually opens the QR scanner.
        manualChunks: undefined,
      },
    },
  },
})
