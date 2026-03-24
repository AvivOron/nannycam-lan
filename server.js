const https = require('https');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { execSync } = require('child_process');

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

// Save recording endpoint
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
  {
    key: fs.readFileSync(path.join(certDir, 'key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
  },
  app
);

const wss = new WebSocketServer({ server });

let broadcaster = null;
const viewers = new Set();

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    const str = message.toString();

    if (str === 'broadcaster') {
      broadcaster = ws;
      console.log('Broadcaster connected');
      return;
    }

    if (str === 'viewer') {
      viewers.add(ws);
      console.log(`Viewer connected (${viewers.size} total)`);
      return;
    }

    // Relay frames from broadcaster to all viewers
    if (ws === broadcaster) {
      for (const viewer of viewers) {
        if (viewer.readyState === 1) {
          viewer.send(message);
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
      if (net.family === 'IPv4' && !net.internal) {
        localIP = net.address;
        break;
      }
    }
  }
  console.log(`\nWebcam server running (sleep prevented via caffeinate)!`);
  console.log(`  Computer (broadcaster): https://localhost:${PORT}`);
  console.log(`  Phone (viewer):         https://${localIP}:${PORT}`);
  console.log(`\nRecordings saved to: ${path.join(__dirname, 'recordings')}\n`);
});
