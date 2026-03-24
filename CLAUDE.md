# NannyCam — Claude Context

## What this is
A two-role LAN streaming app: one **broadcaster** (computer with camera) streams live video + audio to one or more **viewers** (phones/other devices) over a local HTTPS WebSocket connection. Viewers can record clips server-side.

## How to run
```
npm start        # starts HTTPS server on port 3443
```
- Broadcaster opens: `https://localhost:3443`
- Viewer opens: `https://<local-ip>:3443` (IP printed on startup)
- Self-signed cert is auto-generated to `certs/` on first run (required for `getUserMedia` over HTTPS)
- Recordings saved to `recordings/` as timestamped `.webm` files

## Architecture — everything is in two files

### `server.js`
- HTTPS + WebSocket server (port 3443)
- Simple relay: broadcaster sends binary frames → server fans out to all viewers
- `POST /save-recording` — accepts raw WebM body, saves to `recordings/`
- Single broadcaster slot (`broadcaster` var), unlimited viewers (`viewers` Set)

### `public/index.html`
Single-page app, two modes selected at runtime:

**Broadcaster** (`startBroadcaster`):
- `getUserMedia({ video: {...}, audio: true })`
- Sends JPEG frames every 100ms (tag byte `0x01`)
- Sends audio via separate `MediaRecorder` (WebM/Opus) every 200ms (tag byte `0x02`)

**Viewer** (`startViewer`):
- `0x01` frames → draws to `<img>` tag via Blob URL
- `0x02` audio → Web Audio API (`decodeAudioData` → `BufferSource`)
- `audioDestNode` (`MediaStreamAudioDestinationNode`) captures all decoded audio for recordings
- `audioContext.resume()` called on first audio chunk (browser autoplay policy workaround)

**Recording** (`startRecording`):
- `canvas.captureStream(10)` for video + `audioDestNode.stream` audio track added to it
- `MediaRecorder` on the combined stream, VP8+Opus codec
- Max 30 seconds, uploaded via `POST /save-recording`

## Binary message protocol
```
[1 byte type] [payload bytes...]
0x01 = JPEG video frame
0x02 = WebM/Opus audio chunk
```

## Known constraints / gotchas
- No auth — anyone on the LAN can connect
- Only one broadcaster at a time (first one wins)
- Viewer recording audio requires the `audioDestNode` to exist (created in `startViewer`); recording started before any audio arrives will still work but may miss early audio
- Browser autoplay policy: `AudioContext` starts suspended; `resume()` is called lazily on first audio chunk
- Self-signed cert causes browser security warnings — users must accept manually on each device
