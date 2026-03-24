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

function tlSendAll(obj) {
  const msg = JSON.stringify(obj);
  if (broadcaster && broadcaster.readyState === 1) broadcaster.send(msg);
  for (const v of viewers) if (v.readyState === 1) v.send(msg);
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

wss.on('connection', (ws) => {
  ws.on('message', (message, isBinary) => {
    // Text message — role registration or JSON command
    if (!isBinary) {
      const str = message.toString('utf8');

      if (str === 'broadcaster') {
        broadcaster = ws;
        console.log('Broadcaster connected');
        ws.send(JSON.stringify({ cmd: 'tl-list', timelapses: tlList() }));
        return;
      }

      if (str === 'viewer') {
        viewers.add(ws);
        console.log(`Viewer connected (${viewers.size} total)`);
        ws.send(JSON.stringify({ cmd: 'tl-list', timelapses: tlList() }));
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

      return;
    }

    // Binary frame from broadcaster — relay + timelapse capture
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
