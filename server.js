const https = require('https');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { execSync, exec } = require('child_process');

// Generate self-signed cert if not exists
const certDir = path.join(__dirname, 'certs');
if (!fs.existsSync(certDir)) {
  fs.mkdirSync(certDir);
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout ${certDir}/key.pem -out ${certDir}/cert.pem -days 365 -nodes -subj "/CN=localhost"`,
    { stdio: 'pipe' }
  );
  console.log('Generated self-signed certificate');
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/recordings', express.static(path.join(__dirname, 'recordings')));

app.post('/save-recording', (req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    const filename = `recording-${Date.now()}.webm`;
    const savePath = path.join(__dirname, 'recordings', filename);
    fs.mkdirSync(path.join(__dirname, 'recordings'), { recursive: true });
    fs.writeFileSync(savePath, buffer);
    console.log(`Saved recording: ${savePath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    res.json({ filename, path: savePath });
  });
});

const server = https.createServer(
  { key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) },
  app
);

const wss = new WebSocketServer({ server });

let broadcaster = null;
const viewers = new Set();

// Timelapse state — multiple can run concurrently (one per viewer session)
// Map<id, { id, intervalSec, frameCount, lastCapture, dir, startTime, active }>
const timelapses = new Map();

// Recording state — multiple can run concurrently
// Map<id, { id, durationSec, frameCount, audioChunks, dir, startTime, active, timeout }>
const recordings = new Map();

function sendAll(obj) {
  const msg = JSON.stringify(obj);
  if (broadcaster && broadcaster.readyState === 1) broadcaster.send(msg);
  for (const v of viewers) if (v.readyState === 1) v.send(msg);
}

function tlSendAll(obj) {
  sendAll(obj);
}

function tlList() {
  return [...timelapses.values()].map(t => ({
    id: t.id,
    intervalSec: t.intervalSec,
    frameCount: t.frameCount,
    startTime: t.startTime,
    active: t.active,
  }));
}

function recList() {
  return [...recordings.values()].map(r => ({
    id: r.id,
    durationSec: r.durationSec,
    frameCount: r.frameCount,
    startTime: r.startTime,
    active: r.active,
    // Note: timeout is not sent to clients, only stored server-side
  }));
}

function encodeTimelapse(id) {
  const tl = timelapses.get(id);
  if (!tl) return;

  if (tl.frameCount === 0) {
    tlSendAll({ cmd: 'tl-error', id, msg: 'No frames were captured.' });
    if (tl.dir) fs.rmSync(tl.dir, { recursive: true, force: true });
    timelapses.delete(id);
    return;
  }

  fs.mkdirSync(path.join(__dirname, 'recordings'), { recursive: true });
  const outputFile = path.join(__dirname, 'recordings', `timelapse-${id}.mp4`);
  const inputPattern = path.join(tl.dir, 'frame-%06d.jpg');

  tlSendAll({ cmd: 'tl-encoding', id, frames: tl.frameCount });
  console.log(`Encoding timelapse ${id} (${tl.frameCount} frames)...`);

  exec(
    `ffmpeg -y -framerate 30 -i "${inputPattern}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${outputFile}"`,
    (err) => {
      if (err) {
        console.error(`Timelapse encoding failed: ${err.message}`);
        tlSendAll({ cmd: 'tl-error', id, msg: 'ffmpeg encoding failed — is ffmpeg installed? (brew install ffmpeg)' });
      } else {
        fs.rmSync(tl.dir, { recursive: true, force: true });
        const filename = path.basename(outputFile);
        console.log(`Timelapse saved: ${outputFile}`);
        tlSendAll({ cmd: 'tl-done', id, filename });
      }
      timelapses.delete(id);
    }
  );
}

function combineWAVChunks(chunks) {
  if (chunks.length === 0) return null;
  if (chunks.length === 1) return chunks[0];

  // Extract audio data from each WAV chunk (skip 44-byte header) and combine
  const audioDataParts = [];
  let sampleRate = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.length < 44) continue; // invalid WAV

    // Read sample rate from first chunk (bytes 24-27)
    if (i === 0) {
      sampleRate = chunk.readUInt32LE(24);
    }

    // Extract audio data (everything after the 44-byte header)
    audioDataParts.push(chunk.slice(44));
  }

  const audioData = Buffer.concat(audioDataParts);
  const totalSize = 36 + audioData.length;

  // Build new WAV header
  const wav = Buffer.alloc(44 + audioData.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(totalSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); // subchunk1 size
  wav.writeUInt16LE(1, 20); // audio format (PCM)
  wav.writeUInt16LE(1, 22); // channels (mono)
  wav.writeUInt32LE(sampleRate, 24); // sample rate
  wav.writeUInt32LE(sampleRate * 2, 28); // byte rate
  wav.writeUInt16LE(2, 32); // block align
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write('data', 36);
  wav.writeUInt32LE(audioData.length, 40);
  audioData.copy(wav, 44);

  return wav;
}

function encodeRecording(id) {
  const rec = recordings.get(id);
  if (!rec) return;

  if (rec.frameCount === 0) {
    sendAll({ cmd: 'rec-error', id, msg: 'No frames were captured.' });
    if (rec.dir) fs.rmSync(rec.dir, { recursive: true, force: true });
    recordings.delete(id);
    return;
  }

  fs.mkdirSync(path.join(__dirname, 'recordings'), { recursive: true });
  const audioFile = path.join(rec.dir, 'audio.wav');
  const outputFile = path.join(__dirname, 'recordings', `recording-${id}.mp4`);
  const inputPattern = path.join(rec.dir, 'frame-%06d.jpg');

  sendAll({ cmd: 'rec-encoding', id, frames: rec.frameCount });
  console.log(`Encoding recording ${id} (${rec.frameCount} frames)...`);

  // Write audio buffer to WAV file if we have audio
  if (rec.audioChunks.length > 0) {
    const audioBuffer = combineWAVChunks(rec.audioChunks);
    if (audioBuffer) fs.writeFileSync(audioFile, audioBuffer);
    // ffmpeg: combine JPEG frames + WAV audio into MP4
    const cmd = `ffmpeg -y -framerate 10 -i "${inputPattern}" -i "${audioFile}" -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart "${outputFile}"`;
    exec(cmd, (err) => {
      if (err) {
        console.error(`Recording encoding failed: ${err.message}`);
        sendAll({ cmd: 'rec-error', id, msg: 'ffmpeg encoding failed' });
      } else {
        if (rec.dir) fs.rmSync(rec.dir, { recursive: true, force: true });
        const filename = path.basename(outputFile);
        const size = fs.statSync(outputFile).size;
        console.log(`Recording saved: ${outputFile} (${(size / 1024 / 1024).toFixed(2)} MB)`);
        sendAll({ cmd: 'rec-done', id, filename, size });
      }
      recordings.delete(id);
    });
  } else {
    // Video only (no audio)
    const cmd = `ffmpeg -y -framerate 10 -i "${inputPattern}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${outputFile}"`;
    exec(cmd, (err) => {
      if (err) {
        console.error(`Recording encoding failed: ${err.message}`);
        sendAll({ cmd: 'rec-error', id, msg: 'ffmpeg encoding failed' });
      } else {
        if (rec.dir) fs.rmSync(rec.dir, { recursive: true, force: true });
        const filename = path.basename(outputFile);
        const size = fs.statSync(outputFile).size;
        console.log(`Recording saved: ${outputFile} (${(size / 1024 / 1024).toFixed(2)} MB)`);
        sendAll({ cmd: 'rec-done', id, filename, size });
      }
      recordings.delete(id);
    });
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (message, isBinary) => {
    // Text message — role registration or JSON command
    if (!isBinary) {
      const str = message.toString('utf8');

      if (str === 'broadcaster') {
        broadcaster = ws;
        console.log('Broadcaster connected');
        ws.send(JSON.stringify({ cmd: 'tl-list', timelapses: tlList() }));
        ws.send(JSON.stringify({ cmd: 'rec-list', recordings: recList() }));
        return;
      }

      if (str === 'viewer') {
        viewers.add(ws);
        console.log(`Viewer connected (${viewers.size} total)`);
        ws.send(JSON.stringify({ cmd: 'tl-list', timelapses: tlList() }));
        ws.send(JSON.stringify({ cmd: 'rec-list', recordings: recList() }));
        return;
      }

      // JSON command
      let cmd;
      try { cmd = JSON.parse(str); } catch { return; }

      if (cmd.cmd === 'tl-start') {
        const id = `tl-${Date.now()}`;
        const intervalSec = Math.max(1, Math.round(cmd.intervalSec));
        const dir = path.join(__dirname, 'recordings', `tmp-${id}`);
        fs.mkdirSync(dir, { recursive: true });
        timelapses.set(id, { id, intervalSec, frameCount: 0, lastCapture: 0, dir, startTime: Date.now(), active: true });
        console.log(`Timelapse ${id} started (1 frame / ${intervalSec}s)`);
        tlSendAll({ cmd: 'tl-new', tl: timelapses.get(id) });
      }

      if (cmd.cmd === 'tl-stop') {
        const tl = timelapses.get(cmd.id);
        if (!tl || !tl.active) return;
        tl.active = false;
        console.log(`Timelapse ${cmd.id} stopped by viewer (${tl.frameCount} frames)`);
        encodeTimelapse(cmd.id);
      }

      if (cmd.cmd === 'tl-cancel') {
        const tl = timelapses.get(cmd.id);
        if (!tl) return;
        tl.active = false;
        if (tl.dir) fs.rmSync(tl.dir, { recursive: true, force: true });
        timelapses.delete(cmd.id);
        console.log(`Timelapse ${cmd.id} cancelled`);
        tlSendAll({ cmd: 'tl-cancelled', id: cmd.id });
      }

      if (cmd.cmd === 'rec-start') {
        const id = `rec-${Date.now()}`;
        const durationSec = Math.max(1, Math.min(600, Math.round(cmd.durationSec || 30))); // clamp 1-600s
        const dir = path.join(__dirname, 'recordings', `tmp-${id}`);
        fs.mkdirSync(dir, { recursive: true });
        const startTime = Date.now();
        const timeout = setTimeout(() => {
          const r = recordings.get(id);
          if (r && r.active) {
            r.active = false;
            console.log(`Recording ${id} auto-stopped after ${durationSec}s (${r.frameCount} frames)`);
            encodeRecording(id);
          }
        }, durationSec * 1000);
        recordings.set(id, { id, durationSec, frameCount: 0, audioChunks: [], dir, startTime, active: true, timeout });
        console.log(`Recording ${id} started (max ${durationSec}s)`);
        sendAll({ cmd: 'rec-new', rec: { id, durationSec, frameCount: 0, startTime, active: true } });
      }

      if (cmd.cmd === 'rec-stop') {
        const rec = recordings.get(cmd.id);
        if (!rec || !rec.active) return;
        rec.active = false;
        clearTimeout(rec.timeout);
        console.log(`Recording ${cmd.id} stopped by viewer (${rec.frameCount} frames)`);
        encodeRecording(cmd.id);
      }

      if (cmd.cmd === 'rec-cancel') {
        const rec = recordings.get(cmd.id);
        if (!rec) return;
        rec.active = false;
        clearTimeout(rec.timeout);
        if (rec.dir) fs.rmSync(rec.dir, { recursive: true, force: true });
        recordings.delete(cmd.id);
        console.log(`Recording ${cmd.id} cancelled`);
        sendAll({ cmd: 'rec-cancelled', id: cmd.id });
      }

      return;
    }

    // Binary frame from broadcaster — relay + timelapse + recording capture
    if (ws === broadcaster) {
      for (const viewer of viewers) {
        if (viewer.readyState === 1) viewer.send(message);
      }

      // Capture a frame for each active timelapse
      if (message[0] === 0x01) { // video frame (JPEG)
        const now = Date.now();
        for (const tl of timelapses.values()) {
          if (!tl.active) continue;
          if (now - tl.lastCapture < tl.intervalSec * 1000) continue;
          tl.lastCapture = now;
          const framePath = path.join(tl.dir, `frame-${String(tl.frameCount).padStart(6, '0')}.jpg`);
          fs.writeFile(framePath, message.slice(1), () => {}); // async, non-blocking
          tl.frameCount++;
          tlSendAll({ cmd: 'tl-status', id: tl.id, frames: tl.frameCount, estSec: +(tl.frameCount / 30).toFixed(1) });
        }

        // Capture every frame for active recordings
        for (const rec of recordings.values()) {
          if (!rec.active) continue;
          const framePath = path.join(rec.dir, `frame-${String(rec.frameCount).padStart(6, '0')}.jpg`);
          fs.writeFile(framePath, message.slice(1), () => {}); // async, non-blocking
          rec.frameCount++;
          sendAll({ cmd: 'rec-status', id: rec.id, frames: rec.frameCount });
        }
      } else if (message[0] === 0x02) { // audio chunk (WAV)
        // Capture audio for active recordings
        for (const rec of recordings.values()) {
          if (!rec.active) continue;
          rec.audioChunks.push(message.slice(1));
        }
      }
    }
  });

  ws.on('close', () => {
    if (ws === broadcaster) {
      broadcaster = null;
      console.log('Broadcaster disconnected');
    }
    viewers.delete(ws);
  });
});

const PORT = 3443;
server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log(`\nNannyCam running!`);
  console.log(`  Broadcaster: https://localhost:${PORT}`);
  console.log(`  Viewer:      https://${localIP}:${PORT}`);
  console.log(`  Recordings:  ${path.join(__dirname, 'recordings')}\n`);
});
