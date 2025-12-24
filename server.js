const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { version: appVersion } = require('./package.json');

const PORT = process.env.PORT || 3000;
const AUDIO_DIR = path.join(__dirname, 'audio');
const ASSETS_AUDIO_DIR = path.join(__dirname, 'assets', 'audio');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);
const REPO_OWNER = 'hokoo';
const REPO_NAME = 'www-player';
const GITHUB_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;

const execFileAsync = promisify(execFile);
const pipelineAsync = promisify(pipeline);

const AUDIO_DIR_RESOLVED = path.resolve(AUDIO_DIR);
const ASSETS_AUDIO_DIR_RESOLVED = path.resolve(ASSETS_AUDIO_DIR);
const PUBLIC_DIR_RESOLVED = path.resolve(PUBLIC_DIR);

let shuttingDown = false;
let updateInProgress = false;

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

function normalizeVersion(version) {
  if (typeof version !== 'string') return null;
  return version.replace(/^v/i, '').trim();
}

function parseBooleanParam(url, name) {
  const value = url.searchParams.get(name);
  if (value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function compareVersions(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);

  if (!left || !right) return 0;

  const leftParts = left.split('.').map((p) => parseInt(p, 10) || 0);
  const rightParts = right.split('.').map((p) => parseInt(p, 10) || 0);
  const maxLen = Math.max(leftParts.length, rightParts.length);

  for (let i = 0; i < maxLen; i += 1) {
    const l = leftParts[i] || 0;
    const r = rightParts[i] || 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }

  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'www-player-updater' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(fetchJson(res.headers.location));
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`GitHub API responded with status ${res.statusCode}`));
          res.resume();
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    request.on('error', reject);
  });
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);

    const handleResponse = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        https.get(res.headers.location, { headers: { 'User-Agent': 'www-player-updater' } }, handleResponse).on(
          'error',
          reject
        );
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Download failed with status ${res.statusCode}`));
        res.resume();
        return;
      }

      pipelineAsync(res, file)
        .then(resolve)
        .catch((err) => {
          fs.unlink(destination, () => reject(err));
        });
    };

    https
      .get(url, { headers: { 'User-Agent': 'www-player-updater' } }, handleResponse)
      .on('error', (err) => {
        fs.unlink(destination, () => reject(err));
      });
  });
}

function parseReleaseVersion(release) {
  if (!release) return null;
  const candidates = [release.tag_name, release.name];

  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const match = /v(\d+(?:\.\d+)*)/i.exec(value);
    if (match) return match[1];
  }

  return null;
}

async function fetchLatestPrerelease() {
  const releases = await fetchJson(`${GITHUB_API_URL}/releases?per_page=20`);
  if (!Array.isArray(releases)) return null;

  return releases.find((rel) => rel && !rel.draft && rel.prerelease) || null;
}

async function getLatestReleaseInfo(currentVersion, allowPrerelease = false) {
  const release = await fetchJson(`${GITHUB_API_URL}/releases/latest`);
  const releaseVersion = parseReleaseVersion(release);

  if (releaseVersion && compareVersions(releaseVersion, currentVersion) > 0) {
    return {
      latestVersion: releaseVersion,
      tarballUrl: release && release.tarball_url,
      htmlUrl: release && release.html_url,
      isPrerelease: false,
      releaseName: release && release.name,
    };
  }

  if (allowPrerelease) {
    const prerelease = await fetchLatestPrerelease();
    const prereleaseVersion = parseReleaseVersion(prerelease);

    if (prerelease && prereleaseVersion && compareVersions(prereleaseVersion, currentVersion) > 0) {
      return {
        latestVersion: prereleaseVersion,
        tarballUrl: prerelease && prerelease.tarball_url,
        htmlUrl: prerelease && prerelease.html_url,
        isPrerelease: true,
        releaseName: prerelease && prerelease.name,
      };
    }
  }

  return {
    latestVersion: releaseVersion,
    tarballUrl: release && release.tarball_url,
    htmlUrl: release && release.html_url,
    isPrerelease: false,
    releaseName: release && release.name,
  };
}

async function extractTarball(archivePath, targetDir) {
  await execFileAsync('tar', ['-xzf', archivePath, '-C', targetDir]);
}

async function findExtractedRoot(tempDir) {
  const entries = await fs.promises.readdir(tempDir, { withFileTypes: true });
  const folder = entries.find((entry) => entry.isDirectory());
  if (!folder) {
    throw new Error('Не удалось найти содержимое распакованного архива');
  }
  return path.join(tempDir, folder.name);
}

async function copyReleaseContents(sourceDir, targetDir) {
  await fs.promises.cp(sourceDir, targetDir, { recursive: true, force: true });
}

function scheduleRestart() {
  const exit = () => process.exit(0);
  server.close(exit);
  setTimeout(exit, 1000).unref();
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

async function handleUpdateCheck(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const allowPrerelease = parseBooleanParam(url, 'allowPrerelease');
    const { latestVersion, htmlUrl, isPrerelease, releaseName } = await getLatestReleaseInfo(appVersion, allowPrerelease);
    const comparableLatest = latestVersion || null;
    const hasUpdate = comparableLatest ? compareVersions(comparableLatest, appVersion) > 0 : false;

    sendJson(res, 200, {
      currentVersion: appVersion,
      latestVersion: comparableLatest,
      hasUpdate,
      releaseUrl: htmlUrl || null,
      isPrerelease: Boolean(isPrerelease),
      releaseName: releaseName || null,
    });
  } catch (err) {
    console.error('Update check failed', err);
    sendJson(res, 500, { error: 'Не удалось проверить наличие обновлений', details: err.message });
  }
}

async function handleUpdateApply(req, res) {
  if (updateInProgress) {
    sendJson(res, 409, { message: 'Обновление уже выполняется' });
    return;
  }

  updateInProgress = true;

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const allowPrerelease = parseBooleanParam(url, 'allowPrerelease');
    const { latestVersion, tarballUrl } = await getLatestReleaseInfo(appVersion, allowPrerelease);
    const comparableLatest = latestVersion || null;
    const hasUpdate = comparableLatest ? compareVersions(comparableLatest, appVersion) > 0 : false;

    if (!hasUpdate) {
      sendJson(res, 200, { message: 'Установлена последняя версия приложения' });
      return;
    }

    if (!tarballUrl) {
      throw new Error('Не удалось найти архив релиза для загрузки');
    }

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'www-player-update-'));
    const archivePath = path.join(tempDir, 'release.tar.gz');

    await downloadFile(tarballUrl, archivePath);
    await extractTarball(archivePath, tempDir);
    const extractedRoot = await findExtractedRoot(tempDir);
    await copyReleaseContents(extractedRoot, __dirname);

    sendJson(res, 200, { message: 'Обновление установлено. Сервер будет перезапущен.' });
    setTimeout(scheduleRestart, 500);
  } catch (err) {
    console.error('Update apply failed', err);
    sendJson(res, 500, { error: 'Не удалось выполнить обновление', details: err.message });
  } finally {
    updateInProgress = false;
  }
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

  if (pathname === '/api/update/check') {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    handleUpdateCheck(req, res);
    return;
  }

  if (pathname === '/api/update/apply') {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    handleUpdateApply(req, res);
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
