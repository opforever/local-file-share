# NearBeam

**Direct file & text transfer between nearby devices — on your LAN.**

NearBeam opens a peer-to-peer WebRTC data channel between two browsers and streams files,
folders and clipboard text straight from one device to the other. Files are never uploaded
or stored. For one-scan pairing, a small companion service on the receiving device exchanges
temporary connection details on your local network; file transfer stays peer-to-peer.

> The receiver shows the QR. The sender scans it. Pairing and file transfer stay on your LAN.

| Desktop workspace | Mobile workspace | Mobile pairing |
| :--: | :--: | :--: |
| ![NearBeam workspace on desktop](docs/screenshots/workspace-desktop.png) | ![NearBeam workspace on mobile](docs/screenshots/workspace-mobile.png) | ![NearBeam pairing on mobile](docs/screenshots/pairing-mobile.png) |

---

## Features

- **LAN-only peer-to-peer** — no cloud signaling, STUN or TURN servers.
- **Built for speed** — up to 256 KiB chunks with SCTP backpressure, a one-chunk
  read-ahead pipeline, and an application-level brake so a slow disk never blows up memory.
- **Multi-gigabyte friendly** — incoming files stream straight to disk: into a folder you
  pick (Chromium desktop) or into the browser's sandboxed OPFS (everywhere else, including
  iOS Safari). Small files stay in RAM for zero-copy speed.
- **Files, folders and text** — drag & drop whole directories, pick folders from the file
  dialog, paste images from the clipboard, or beam a snippet of text.
- **One-scan pairing** — the receiver shows a QR and the sender scans it; ephemeral signaling
  stays in the local companion process and expires after five minutes.
- **Installable & offline-capable PWA** — a build-time service worker precaches every asset,
  so an installed NearBeam keeps working on a LAN with no internet at all.
- **Responsive by design** — one codebase, tuned layouts for phones and desktops, dark and
  light themes, reduced-motion support.
- **Hardened hosting defaults** — strict CSP, permissions policy, immutable asset caching
  (see `vercel.json`).

## How pairing works

For one-scan pairing, the receiver displays a QR from the local companion service. The sender
scans it, creates a WebRTC offer, and the service returns the receiver's answer automatically.
Connection details live only in the receiving device's memory for up to five minutes; file
data travels directly between devices.

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

For development/manual pairing, `npm run dev` still works. Open the app on both devices
(or two tabs/windows), pick **Send** and **Receive**, then exchange the invite and response
codes.

## Hosting

The static app may be hosted anywhere, but one-scan pairing is deliberately disabled on
public hosts. For a fully local session, run `npm run local` on the receiving device and use
the LAN URL it prints. No Redis account or cloud environment variables are needed. Manual
two-code pairing also works on a static host, but both peers must still be able to connect
directly on the LAN.

## Browser support

Current Chrome, Edge, Firefox and Safari on desktop and mobile. Folder-pick and
stream-to-folder use the File System Access API where available (Chromium) and degrade
gracefully to sandboxed-disk or in-memory staging elsewhere.

## Performance notes

| Knob | Default | Why |
| --- | --- | --- |
| `CHUNK_SIZE` | 256 KiB | Capped by each browser's negotiated SCTP message limit. |
| `HIGH_WATER` | 8 MiB | Send-buffer ceiling before we wait for `bufferedamountlow`. |
| `BRAKE_ON` / `BRAKE_OFF` | 32 / 8 MiB | Receiver asks the sender to pause when its unwritten queue grows (slow disk, phones). |
| `MEMORY_SINK_LIMIT` | 96 MiB | Above this, receives stage on disk instead of in RAM. |

All live in `src/lib/transfer.ts` and `src/lib/sinks.ts` if you want to tune them.

5 GHz is only a radio band, not a speed guarantee. A rate around 600 KB/s is far below a
healthy local Wi‑Fi link; check that both devices are on the same non-guest network, disable
VPNs, and compare each device's Wi‑Fi link rate. A slow receive disk or browser can also limit
the transfer.

## Security & privacy model

- **Transport**: browsers require WebRTC transport encryption; the app cannot disable it.
- **LAN-only**: host ICE candidates are used with no STUN/TURN servers. Pairing records exist
  only in the local companion process and expire after five minutes.
- **No file hash checks**: transfers do not compute or compare file digests.
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
    rtc.ts        LAN-only ICE config, gathering and stats
    transfer.ts   the transfer engine (queue, chunking, backpressure, store)
    sinks.ts      where received bytes land (folder / OPFS / memory)
    format.ts     bytes/speed/duration formatting, filename sanitising
    pickFiles.ts  picker + drag&drop + folder-walk normalisation
    clipboard.ts  clipboard & Web Share helpers
    ua.ts         friendly device labels
  hooks/          usePeer (WebRTC lifecycle), useScanner, useSettings/useTheme, useToasts
  components/     UI: header, pairing, workspace, scanner, sheets, icons
  types/          ambient File System Access typings
scripts/
  make-icons.mjs  dependency-free PNG icon rasteriser (manifest icons)
  test-logic.mjs  unit tests: codec and local pairing URL validation
  e2e.mjs         two real headless Chromes pairing and transferring a file
```

## Scripts

```bash
npm run dev        # local dev server
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build
npm run lint       # oxlint
npm test           # logic unit tests (invite codec, pairing URLs)
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
pushes a 3 MiB file, and compares the downloaded bytes with the source in the test —
all while serving `dist/` with the same CSP headers production uses. `test:large` repeats the
dance with a 120 MiB payload so the on-disk (OPFS) receive path and auto-save are covered too.

## License

MIT — see [LICENSE](./LICENSE).
