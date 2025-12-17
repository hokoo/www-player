const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const AUDIO_DIR = path.join(__dirname, 'audio');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);

function isAudioFile(filename) {
  return AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
  };
  return map[ext] || 'application/octet-stream';
}

function safePath(baseDir, requestPath) {
  const normalized = path.normalize(requestPath).replace(/^\\+|^\/+/, '');
  return path.join(baseDir, normalized);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': getContentType(filePath) });
    res.end(data);
  });
}

function handleApiAudio(req, res) {
  fs.readdir(AUDIO_DIR, (err, files) => {
    if (err) {
      sendJson(res, 500, { error: 'Failed to read audio directory' });
      return;
    }
    const audioFiles = files.filter((file) => isAudioFile(file));
    sendJson(res, 200, { files: audioFiles });
  });
}

function handleAudioFile(req, res, pathname) {
  const requested = pathname.replace(/^\/audio\//, '');
  const filePath = safePath(AUDIO_DIR, requested);
  if (!filePath.startsWith(AUDIO_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile() || !isAudioFile(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    serveStatic(res, filePath);
  });
}

function handlePublic(req, res, pathname) {
  let requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = safePath(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    serveStatic(res, filePath);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  if (pathname === '/api/audio') {
    handleApiAudio(req, res);
    return;
  }

  if (pathname.startsWith('/audio/')) {
    handleAudioFile(req, res, pathname);
    return;
  }

  handlePublic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
