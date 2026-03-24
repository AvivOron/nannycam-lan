# 📷 NannyCam LAN

> Zero-setup live video + audio streaming over your local network. Point a camera, watch from your phone — and leave a timelapse running overnight.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-6366f1?style=flat-square)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-71717a?style=flat-square)

---

## What is it?

NannyCam LAN streams your webcam — live video and audio — to any device on the same Wi-Fi network. No accounts, no cloud, no latency. Just open a browser on both ends and go.

**Common uses:**
- Watch a sleeping baby from another room
- Monitor a space while you're away
- Leave a timelapse running overnight and wake up to a compressed video

---

## Features

- **Live video** — JPEG frames over WebSocket, ~10 fps
- **Live audio** — WAV/PCM streaming, works on iOS Safari & Chrome
- **Clip recording** — save up to 30s clips with audio, stored server-side as `.webm`
- **Timelapse** — server-side capture that survives the viewer disconnecting; encode to MP4 on demand
- **No install on viewer** — just open a URL in any mobile browser
- **HTTPS auto-setup** — self-signed cert generated on first run
- **LAN only** — your stream never leaves your network

---

## Quick Start

```bash
git clone https://github.com/AvivOron/nannycam-lan.git
cd nannycam-lan
npm install
npm start
```

The server prints two URLs:

```
NannyCam running!
  Broadcaster: https://localhost:3443
  Viewer:      https://192.168.x.x:3443
  Recordings:  /path/to/recordings
```

**On your computer** → open `https://localhost:3443` → click **Broadcast**

**On your phone** → open the LAN URL → click **Watch**

> ⚠️ Both devices must be on the same Wi-Fi network. Your browser will warn about the self-signed certificate — click "Advanced → Proceed" to continue.

---

## Timelapse

Pick how many hours of footage you want to compress and how long the output should be — the interval is calculated automatically.

```
9 hours → 30 seconds  =  1 frame every 36s  =  ~270MB temp / ~30MB final
```

- Start from the viewer, monitor and cancel from **both** the broadcaster and viewer
- Capture runs entirely on the server — close the viewer tab and it keeps going
- Hit **Save** when ready; the server encodes with ffmpeg and saves an MP4
- Temp frames are deleted automatically after encoding

**Requires ffmpeg:**
```bash
brew install ffmpeg   # macOS
```

**Disk usage at common settings (300KB/frame):**

| Footage | Output | Interval | Temp size |
|---------|--------|----------|-----------|
| 1 hour  | 30s    | 4s       | ~270MB    |
| 9 hours | 30s    | 36s      | ~270MB    |
| 9 hours | 1 min  | 18s      | ~540MB    |
| 24 hours| 30s    | 96s      | ~270MB    |

---

## How It Works

```
[Broadcaster]                         [Server]                    [Viewer]
  getUserMedia()                        relay frames
  → JPEG frames  ──── WebSocket ─────→  → fan out   ──────────→  → <img> tag
  → WAV audio    ──── WebSocket ─────→  → fan out   ──────────→  → Web Audio API
                                        ↓ timelapse
                                        save every Nth JPEG to disk
                                        ffmpeg encode on Stop
```

### Binary protocol (media frames)

| Byte 0 | Payload |
|--------|---------|
| `0x01` | JPEG video frame |
| `0x02` | WAV audio chunk (PCM mono, 8192 samples) |

### JSON protocol (control messages)

Timelapse is controlled via JSON text frames over the same WebSocket. Both broadcaster and viewer can send `tl-stop` and `tl-cancel`. Only viewers can send `tl-start`.

---

## Requirements

- Node.js 18+
- `openssl` in PATH (pre-installed on macOS/Linux)
- `ffmpeg` in PATH for timelapse encoding (`brew install ffmpeg`)
- Any modern browser on the broadcaster side
- Any modern mobile browser on the viewer (tested on iOS Chrome, iOS Safari, Android Chrome)

---

## Project Structure

```
nannycam-lan/
├── server.js          # HTTPS + WebSocket server, relay, timelapse capture + encoding
├── public/
│   └── index.html     # Entire frontend — broadcaster + viewer in one file
├── recordings/        # Saved clips and timelapse MP4s (git-ignored)
└── certs/             # Auto-generated TLS cert (git-ignored)
```

---

## License

MIT
