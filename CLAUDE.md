# NannyCam — Claude Context

## What this is
A two-role LAN streaming app: one **broadcaster** (computer with camera) streams live video + audio to one or more **viewers** (phones/other devices) over a local HTTPS WebSocket connection. Viewers can record clips and start server-side timelapses.

## How to run
```
npm start        # starts HTTPS server on port 3443
```
- Broadcaster opens: `https://localhost:3443`
- Viewer opens: `https://<local-ip>:3443` (IP printed on startup)
- Self-signed cert is auto-generated to `certs/` on first run (required for `getUserMedia` over HTTPS)
- Recordings and timelapse MP4s saved to `recordings/`
- Timelapse requires `ffmpeg` in PATH (`brew install ffmpeg`)

## Architecture — everything is in two files

### `server.js`
- HTTPS + WebSocket server (port 3443)
- Relay: broadcaster sends binary frames → server fans out to all viewers
- `POST /save-recording` — accepts raw WebM body, saves to `recordings/`
- Single broadcaster slot (`broadcaster` var), unlimited viewers (`viewers` Set)
- **Timelapse**: `Map<id, tl>` tracks concurrent timelapses; server intercepts broadcaster JPEG frames and writes every Nth one to `recordings/tmp-<id>/` as numbered JPEGs; on stop, encodes with `ffmpeg` (async `exec`) and cleans up temp dir
- Uses `isBinary` ws parameter to distinguish text (JSON commands) from binary (media frames)

### `public/index.html`
Single-page app, two modes selected at runtime. All WebSocket messages flow through one connection per role.

**Binary protocol** (broadcaster → server → viewers):
```
[1 byte type] [payload bytes...]
0x01 = JPEG video frame
0x02 = WAV audio chunk (PCM mono, 8192 samples)
```

**JSON protocol** (text frames, both directions):
```
Viewer/Broadcaster → Server:
  { cmd: 'tl-start', intervalSec }   start timelapse
  { cmd: 'tl-stop', id }             stop + encode
  { cmd: 'tl-cancel', id }           discard

Server → All:
  { cmd: 'tl-list', timelapses }     sent on connect
  { cmd: 'tl-new', tl }
  { cmd: 'tl-status', id, frames, estSec }
  { cmd: 'tl-encoding', id, frames }
  { cmd: 'tl-done', id, filename }
  { cmd: 'tl-error', id, msg }
  { cmd: 'tl-cancelled', id }
```

**Broadcaster** (`startBroadcaster`):
- `getUserMedia({ video: {...}, audio: true })`
- Sends JPEG frames every 100ms (tag `0x01`)
- Sends audio as WAV chunks via `ScriptProcessorNode` (8192 samples, tag `0x02`) — WAV chosen for iOS compatibility (`decodeAudioData` doesn't handle streaming WebM chunks)

**Viewer** (`startViewer`):
- `0x01` frames → `<img>` tag via Blob URL
- `0x02` WAV chunks → Web Audio API (`decodeAudioData` → scheduled `BufferSource`)
- `audioDestNode` (`MediaStreamAudioDestinationNode`) taps decoded audio for recordings
- `audioScheduledUntil` tracks playback schedule to avoid gaps/overlaps
- `AudioContext` starts suspended on iOS; `resume()` called on first chunk

**Recording** (`startRecording`):
- `canvas.captureStream(10)` for video + `audioDestNode.stream` audio track
- `new MediaStream([...tracks])` — do NOT use `addTrack()` on canvas stream (causes silent MediaRecorder failure)
- VP8+Opus if audio available, VP8-only fallback
- Max 30 seconds, uploaded via `POST /save-recording`

**Timelapse** (viewer-initiated, server-side execution):
- Viewer picks footage duration + output length → interval auto-calculated: `(hours × 3600) / (outSec × 30)`
- Sends `tl-start` → server captures frames to disk
- Both broadcaster and viewer see the timelapse list with Save/Cancel buttons
- Timelapse survives viewer disconnecting — runs entirely on server
- Disk usage: frames ~300KB each; 9h at 1f/36s ≈ 270MB temp, deleted after encode

## Known constraints / gotchas
- No auth — anyone on the LAN can connect
- Only one broadcaster at a time (first one wins)
- `ScriptProcessorNode` is deprecated but used for broad iOS compatibility
- Self-signed cert causes browser security warnings — accept manually on each device
- ffmpeg must be installed for timelapse encoding; graceful error message if missing
- Timelapse state is in-memory; server restart loses active timelapse state (temp frames on disk become orphaned in `recordings/tmp-*/`)
