# NearBeam

**Direct, encrypted file & text transfer between nearby devices — at full LAN speed.**

NearBeam opens a peer-to-peer WebRTC data channel between two browsers and streams files,
folders and clipboard text straight from one device to the other. Files are never uploaded
or stored. A short-lived signaling service exchanges connection details for one-scan
pairing; the file transfer itself stays peer-to-peer.

> The receiver shows the QR. The sender scans it. Pair over Vercel with the configured
> signaling store, or exchange two short codes manually without a signaling service.

| Desktop workspace | Mobile workspace | Mobile pairing |
| :--: | :--: | :--: |
| ![NearBeam workspace on desktop](docs/screenshots/workspace-desktop.png) | ![NearBeam workspace on mobile](docs/screenshots/workspace-mobile.png) | ![NearBeam pairing on mobile](docs/screenshots/pairing-mobile.png) |

---

## Features

- **Peer-to-peer over your local network** — with the default settings only on-LAN
  candidates are used, so bytes never leave your Wi‑Fi/Ethernet segment.
- **Built for speed** — 64 KiB chunked streaming with SCTP backpressure, a one-chunk
  read-ahead pipeline, and an application-level brake so a slow disk never blows up memory.
- **Multi-gigabyte friendly** — incoming files stream straight to disk: into a folder you
  pick (Chromium desktop) or into the browser's sandboxed OPFS (everywhere else, including
  iOS Safari). Small files stay in RAM for zero-copy speed.
- **Files, folders and text** — drag & drop whole directories, pick folders from the file
  dialog, paste images from the clipboard, or beam a snippet of text.
- **Optional integrity verification** — streaming SHA-256 on both ends, computed while the
  bytes flow (no second read), verified on arrival.
- **Pair however you like** — one-scan QR pairing with the hosted signaling service, or
  serverless QR/code exchange and shareable invite links. A matching "safety code" on both
  screens confirms you paired with the right device.
- **Installable & offline-capable PWA** — a build-time service worker precaches every asset,
  so an installed NearBeam keeps working on a LAN with no internet at all.
- **Responsive by design** — one codebase, tuned layouts for phones and desktops, dark and
  light themes, reduced-motion support.
- **Hardened hosting defaults** — strict CSP, permissions policy, immutable asset caching
  (see `vercel.json`).

## How pairing works

For one-scan pairing, the receiver displays a QR. The sender scans it, creates a WebRTC
offer, and the service returns the receiver's answer automatically. The signaling service
holds connection details for up to five minutes; file data still travels directly between
devices.

Without a signaling service, the two devices exchange the offer and answer codes manually:

```
  Device A (sender)                        Device B (receiver)
  ─────────────────                        ───────────────────
  createOffer + ICE gather
        │  invite code (QR / link / paste)
        ├────────────────────────────────────────▶  setRemoteDescription
        │                                          createAnswer + ICE gather
        │        response code (QR / paste)
        ◀────────────────────────────────────────┤
  setRemoteDescription
        │
        └────────────  DTLS-encrypted data channel, direct  ────────────┐
                                                                       │
                    files / folders / text stream A ⇄ B  ◀─────────────┘
```

The codes are gzip-compressed, base64url-encoded SDP (~600 characters), which is small
enough for a scannable QR code and short enough to paste.

## Quick start (local)

```bash
npm install
npm run dev        # http://localhost:5173
```

For one-scan pairing locally, run the companion service on the receiving device:

```bash
npm run local
```

Open the **Other devices** URL printed in the terminal on the receiving device and pick
**Receive files**. On the sending device, pick **Send files** and scan the receiver's QR
with its camera app; pairing completes automatically. Keep the terminal process running
until the other device connects. Both devices must be on the same Wi-Fi/network.

For development or serverless/manual pairing, `npm run dev` still works. Open the app on
both devices (or two tabs/windows), pick **Send** and **Receive**, then exchange the
invite and response codes as before.

## Deploy to Vercel

The Vercel deployment includes a small serverless signaling API. It needs a Redis database
so separate function instances can exchange the offer and answer; a static-only deployment
cannot do that. The signaling records expire after five minutes and contain no file data.

1. Push this folder to a GitHub repository.
2. In Vercel: **Add New → Project → Import** that repository.
3. Create a Redis database in Upstash and add its REST URL and token to the Vercel project's
   Environment Variables as `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
4. Deploy (or redeploy) the project. Open the Vercel URL on both devices, choose **Receive
   files** on the receiver to display the QR, then choose **Send files** on the sender and
   scan it.

If these variables are missing, one-scan pairing reports that the hosted signaling store
isn't configured. Manual two-code pairing continues to work without it.

Prefer the CLI?

```bash
npm i -g vercel
vercel link && vercel --prod
```

### Other hosts

Manual two-code pairing works on any static host. One-scan pairing requires the Vercel
signaling API and Redis, or the companion local service:

- **Netlify** — build `npm run build`, publish `dist`, add a SPA rewrite to `/index.html`.
- **GitHub Pages** — set `base` in `vite.config.ts` to your repo path (e.g. `'/nearbeam/'`),
  build, and publish `dist`.
- **Your own box** — serve `dist/` with any web server over HTTPS (HTTPS is required for
  camera access and WebRTC on non-localhost origins).

## Browser support

Current Chrome, Edge, Firefox and Safari on desktop and mobile. Folder-pick and
stream-to-folder use the File System Access API where available (Chromium) and degrade
gracefully to sandboxed-disk or in-memory staging elsewhere.

## Performance notes

| Knob | Default | Why |
| --- | --- | --- |
| `CHUNK_SIZE` | 64 KiB | The well-tested sweet spot across engines; SCTP overhead is negligible at this size. |
| `HIGH_WATER` | 8 MiB | Send-buffer ceiling before we wait for `bufferedamountlow`. |
| `BRAKE_ON` / `BRAKE_OFF` | 32 / 8 MiB | Receiver asks the sender to pause when its unwritten queue grows (slow disk, phones). |
| `MEMORY_SINK_LIMIT` | 96 MiB | Above this, receives stage on disk instead of in RAM. |

All live in `src/lib/transfer.ts` and `src/lib/sinks.ts` if you want to tune them.

On a gigabit LAN with both devices wired or on 5 GHz Wi‑Fi, expect transfers limited by the
slowest link (disk or radio), not by NearBeam.

## Security & privacy model

- **Transport**: WebRTC data channels are DTLS/SRTP encrypted end to end. With the default
  empty ICE server list, candidates are host-only, so traffic stays on your LAN.
- **No backend**: nothing is uploaded, stored, or logged by a server. The deployed site is
  static files only.
- **Pairing authenticity**: both devices derive the same short "safety code" from the
  exchanged offer/answer pair; read it aloud to confirm you're paired with the intended
  device.
- **Filename hygiene**: received names are sanitised so a remote peer can't smuggle path
  separators into your downloads.
- **Hosting hardening**: strict Content-Security-Policy (no `unsafe-inline` scripts),
  `X-Frame-Options: DENY`, nosniff, referrer and permissions policies — see `vercel.json`.
- **Local-only state**: theme and settings live in `localStorage` on your device. Received
  OPFS staging files are purged on next launch.

## Project structure

```
src/
  lib/
    codec.ts      gzip+base64url invite-code encoding, URL/wrapped-code parsing
    rtc.ts        ICE config, gathering, stats, session safety code
    transfer.ts   the transfer engine (queue, chunking, backpressure, store)
    sinks.ts      where received bytes land (folder / OPFS / memory)
    sha256.ts     streaming SHA-256 (FIPS 180-4) for integrity checks
    format.ts     bytes/speed/duration formatting, filename sanitising
    pickFiles.ts  picker + drag&drop + folder-walk normalisation
    clipboard.ts  clipboard & Web Share helpers
    ua.ts         friendly device labels
  hooks/          usePeer (WebRTC lifecycle), useScanner, useSettings/useTheme, useToasts
  components/     UI: header, pairing, workspace, scanner, sheets, icons
  types/          ambient File System Access typings
scripts/
  make-icons.mjs  dependency-free PNG icon rasteriser (manifest icons)
  test-logic.mjs  unit tests: SHA-256 + codec vs Node reference impls
  e2e.mjs         two real headless Chromes pairing and transferring a file
```

## Scripts

```bash
npm run dev        # local dev server
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build
npm run lint       # oxlint
npm test           # logic unit tests (SHA-256, invite codec)
npm run icons      # regenerate PWA icons from the vector mark
npm run test:e2e   # full browser-to-browser transfer test (3 MiB, memory sink)
npm run test:large # 120 MiB transfer exercising the OPFS disk sink
```

`test:e2e` needs a one-time local install of Puppeteer (it is intentionally **not** a
project dependency, so deploys stay fast):

```bash
npm i -D puppeteer
npm run test:e2e
```

The suite launches two isolated headless Chrome instances, pairs them through the real UI,
pushes a 3 MiB file, and asserts the downloaded bytes are SHA-256 identical to the source —
all while serving `dist/` with the same CSP headers production uses. `test:large` repeats the
dance with a 120 MiB payload so the on-disk (OPFS) receive path and auto-save are covered too.

## License

MIT — see [LICENSE](./LICENSE).
