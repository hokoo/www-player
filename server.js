const http = require('http');
const path = require('path');
const fs = require('fs');
const { version: appVersion } = require('./package.json');

const PORT = process.env.PORT || 3000;
const AUDIO_DIR = path.join(__dirname, 'audio');
const ASSETS_AUDIO_DIR = path.join(__dirname, 'assets', 'audio');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);

const AUDIO_DIR_RESOLVED = path.resolve(AUDIO_DIR);
const ASSETS_AUDIO_DIR_RESOLVED = path.resolve(ASSETS_AUDIO_DIR);
const PUBLIC_DIR_RESOLVED = path.resolve(PUBLIC_DIR);

let shuttingDown = false;

function isAudioFile(filenameOrPath) {
  return AUDIO_EXTENSIONS.has(path.extname(filenameOrPath).toLowerCase());
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function isInside(baseResolved, targetResolved) {
  const rel = path.relative(baseResolved, targetResolved);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function safeResolve(baseDirResolved, requestPath) {
  // requestPath must be without leading slashes
  const resolved = path.resolve(baseDirResolved, requestPath);
  return isInside(baseDirResolved, resolved) ? resolved : null;
}

function serveFile(req, res, filePath, contentType) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const headers = {
      'Content-Type': contentType,
      'Content-Length': stat.size,
    };

    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveAudioWithRange(req, res, filePath, contentType) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const total = stat.size;
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;

    // No Range: serve the entire file.
    if (!range) {
      const headers = {
        'Content-Type': contentType,
        'Content-Length': total,
      };

      if (req.method === 'HEAD') {
        res.writeHead(200, headers);
        res.end();
        return;
      }

      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // Range: bytes=start-end
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    end = Math.min(end, total - 1);

    const chunkSize = end - start + 1;

    const headers = {
      'Content-Type': contentType,
      'Content-Length': chunkSize,
      'Content-Range': `bytes ${start}-${end}/${total}`,
    };

    if (req.method === 'HEAD') {
      res.writeHead(206, headers);
      res.end();
      return;
    }

    res.writeHead(206, headers);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
}

function readAudioDirectory(directory, res) {
  fs.readdir(directory, { withFileTypes: true }, (err, entries) => {
    if (err) {
      if (err.code === 'ENOENT') {
        sendJson(res, 200, { files: [] });
      } else {
        sendJson(res, 500, { error: 'Failed to read audio directory' });
      }
      return;
    }

    const audioFiles = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => isAudioFile(name));

    sendJson(res, 200, { files: audioFiles });
  });
}

function handleApiAudio(req, res) {
  readAudioDirectory(AUDIO_DIR, res);
}

function handleApiAssetsAudio(req, res) {
  readAudioDirectory(ASSETS_AUDIO_DIR, res);
}

function handleApiVersion(req, res) {
  sendJson(res, 200, { version: appVersion });
}

function handleShutdown(req, res) {
  if (shuttingDown) {
    sendJson(res, 409, { message: 'Server is already stopping' });
    return;
  }

  shuttingDown = true;
  sendJson(res, 200, { message: 'Server is stopping' });
  console.log('Shutdown requested. Stopping server...');

  const exit = () => process.exit(0);
  server.close(exit);
  setTimeout(exit, 1000).unref();
}

function handleAudioFile(req, res, pathname, baseResolved, basePrefix) {
  const prefix = basePrefix.endsWith('/') ? basePrefix : `${basePrefix}/`;
  const requested = pathname.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '').replace(/^\/+/, '');
  const filePath = safeResolve(baseResolved, requested);

  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!isAudioFile(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  serveAudioWithRange(req, res, filePath, getContentType(filePath));
}

function handlePublic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = safeResolve(PUBLIC_DIR_RESOLVED, requested);

  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  serveFile(req, res, filePath, getContentType(filePath));
}

const server = http.createServer((req, res) => {
  let pathname = '/';

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    pathname = decodeURIComponent(url.pathname);
  } catch (e) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (pathname === '/api/shutdown') {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    handleShutdown(req, res);
    return;
  }

  if (pathname === '/api/audio') {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    handleApiAudio(req, res);
    return;
  }

  if (pathname === '/api/assets-audio') {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    handleApiAssetsAudio(req, res);
    return;
  }

  if (pathname === '/api/version') {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    handleApiVersion(req, res);
    return;
  }

  if (pathname.startsWith('/audio/')) {
    // Allow GET and HEAD for proper metadata fetching.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    handleAudioFile(req, res, pathname, AUDIO_DIR_RESOLVED, '/audio/');
    return;
  }

  if (pathname.startsWith('/assets/audio/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    handleAudioFile(req, res, pathname, ASSETS_AUDIO_DIR_RESOLVED, '/assets/audio/');
    return;
  }

  // Public files: allow GET and HEAD.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  handlePublic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
