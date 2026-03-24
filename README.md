# 📷 NannyCam LAN

> Zero-setup live video + audio streaming over your local network. Point a camera, watch from your phone.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-6366f1?style=flat-square)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-71717a?style=flat-square)

---

## What is it?

NannyCam LAN lets you stream your webcam — live video and audio — to any device on the same Wi-Fi network. No accounts, no cloud, no latency. Just open a browser on both ends and go.

Built as a lightweight Node.js server with a single-page frontend. Everything runs locally.

**Common uses:**
- Watch a sleeping baby from another room
- Monitor a space while you're elsewhere in the house
- Quick wireless webcam for a second screen setup

---

## Features

- **Live video** — JPEG frames over WebSocket, ~10 fps
- **Live audio** — PCM/WAV streaming, works on iOS Safari & Chrome
- **Recordings** — save clips server-side as `.webm` files (up to 30s)
- **No install on viewer** — just open a URL in any mobile browser
- **HTTPS auto-setup** — self-signed cert generated on first run (required for camera access)
- **LAN only** — your stream never leaves your network

---

## Quick Start

```bash
git clone https://github.com/AvivOron/nannycam-lan.git
cd nannycam-lan
npm install
npm start
```

The server will print two URLs:

```
Webcam server running!
  Computer (broadcaster): https://localhost:3443
  Phone (viewer):         https://192.168.x.x:3443
```

**On your computer** → open `https://localhost:3443` → click **Broadcast**

**On your phone** → open the LAN URL → click **Watch**

> ⚠️ Both devices must be on the same Wi-Fi network. Your browser will warn about the self-signed certificate — click "Advanced → Proceed" to continue.

---

## How It Works

```
[Broadcaster]                        [Viewer]
  getUserMedia()                       WebSocket
  → JPEG frames  ──── WebSocket ────→  → <img> tag
  → WAV audio    ──── WebSocket ────→  → Web Audio API
```

The server is a simple relay — it receives binary frames from the broadcaster and fans them out to all connected viewers. No transcoding, no storage (except recordings).

### Binary protocol

Each WebSocket message is a tagged binary frame:

| Byte 0 | Payload |
|--------|---------|
| `0x01` | JPEG video frame |
| `0x02` | WAV audio chunk (PCM mono, 8192 samples) |

---

## Recordings

Clips are saved to `./recordings/` on the machine running the server, named `recording-<timestamp>.webm`. The viewer triggers the recording — video is captured from the incoming stream, audio is captured via Web Audio API.

---

## Requirements

- Node.js 18+
- `openssl` in PATH (for cert generation — pre-installed on macOS/Linux)
- A browser that supports `getUserMedia` on the broadcaster side
- Any modern mobile browser on the viewer side (tested on iOS Chrome & Safari, Android Chrome)

---

## Project Structure

```
nannycam-lan/
├── server.js          # HTTPS + WebSocket server, recording endpoint
├── public/
│   └── index.html     # Entire frontend (broadcaster + viewer, single file)
├── recordings/        # Saved clips (git-ignored)
└── certs/             # Auto-generated TLS cert (git-ignored)
```

---

## License

MIT
