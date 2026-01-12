const zonesContainer = document.getElementById('zones');
const statusEl = document.getElementById('status');
const assetsContainer = document.getElementById('assetsTracks');
const assetsStatusEl = document.getElementById('assetsStatus');
const overlayTimeInput = document.getElementById('overlayTime');
const overlayCurveSelect = document.getElementById('overlayCurve');
const stopFadeInput = document.getElementById('stopFadeTime');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const stopServerBtn = document.getElementById('stopServer');
const appVersionEl = document.getElementById('appVersion');
const updateInfoEl = document.getElementById('updateInfo');
const updateMessageEl = document.getElementById('updateMessage');
const updateButton = document.getElementById('updateButton');
const updateStatusEl = document.getElementById('updateStatus');
const releaseLinkEl = document.getElementById('releaseLink');
const allowPrereleaseInput = document.getElementById('allowPrerelease');

const SETTINGS_KEYS = {
  overlayTime: 'player:overlayTime',
  overlayCurve: 'player:overlayCurve',
  layout: 'player:zones',
  stopFade: 'player:stopFade',
  sidebarOpen: 'player:sidebarOpen',
  allowPrerelease: 'player:allowPrerelease',
};

let currentAudio = null;
let currentTrack = null; // { file, basePath, key }
let fadeCancel = { cancelled: false };
let buttonsByFile = new Map();
let cardsByFile = new Map();
let progressByFile = new Map();
let progressRaf = null;
let progressAudio = null;
const MAX_ZONES = 5;
let layout = Array.from({ length: MAX_ZONES }, () => []); // array of zones -> array of filenames
let availableFiles = [];
let assetFiles = [];
let shutdownCountdownTimer = null;
const HOTKEY_ROWS = [
  ['1', '2', '3', '4', '5'],
  ['Q', 'W', 'E', 'R', 'T'],
  ['A', 'S', 'D', 'F', 'G'],
  ['Z', 'X', 'C', 'V', 'B'],
];
const HOTKEY_CODES = [
  ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'],
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT'],
  ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG'],
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB'],
];
const ASSET_HOTKEY_LABELS = ['0', '9', '8', '7', '6'];
const ASSET_HOTKEY_CODES = ['Digit0', 'Digit9', 'Digit8', 'Digit7', 'Digit6'];

function clampVolume(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function trackKey(file, basePath = '/audio') {
  return `${basePath}|${file}`;
}

function trackDisplayName(file, hotkeyLabel) {
  const name = stripExtension(file);
  return hotkeyLabel ? `${hotkeyLabel}: ${name}` : name;
}

function stripExtension(filename) {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return filename;
  return filename.slice(0, lastDot);
}

const easing = (t, type) => {
  switch (type) {
    case 'ease-in':
      return t * t;
    case 'ease-out':
      return t * (2 - t);
    case 'ease-in-out':
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    default:
      return t;
  }
};

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function setAssetsStatus(message) {
  if (assetsStatusEl) assetsStatusEl.textContent = message;
}

function loadSetting(key, fallback) {
  const value = localStorage.getItem(key);
  return value !== null ? value : fallback;
}

function saveSetting(key, value) {
  localStorage.setItem(key, value);
}

function loadBooleanSetting(key, fallback = false) {
  const value = localStorage.getItem(key);
  if (value === null) return fallback;
  return value === 'true';
}

function volumeKey(key) {
  return `player:volume:${key}`;
}

function loadVolume(file, basePath = '/audio') {
  const key = trackKey(file, basePath);
  const saved = localStorage.getItem(volumeKey(key));
  let parsed = saved !== null ? parseFloat(saved) : NaN;

  if (Number.isNaN(parsed) && basePath === '/audio') {
    const legacy = localStorage.getItem(`player:volume:${file}`);
    parsed = legacy !== null ? parseFloat(legacy) : NaN;
  }

  if (Number.isNaN(parsed)) return 1;
  return clampVolume(parsed);
}

function saveVolume(file, value, basePath = '/audio') {
  const key = trackKey(file, basePath);
  localStorage.setItem(volumeKey(key), clampVolume(value).toString());
}

function renderEmpty() {
  zonesContainer.innerHTML = '<div class="empty-state">В папке /audio не найдено аудиофайлов (mp3, wav, ogg, m4a, flac).</div>';
}

function setButtonPlaying(fileKey, isPlaying) {
  const btn = buttonsByFile.get(fileKey);
  const card = cardsByFile.get(fileKey);
  const progress = progressByFile.get(fileKey);
  if (btn) {
    btn.textContent = isPlaying ? '■' : '▶';
    btn.title = isPlaying ? 'Остановить' : 'Воспроизвести';
  }
  if (card) {
    card.classList.toggle('is-playing', isPlaying);
  }
  if (progress) {
    const { container, bar } = progress;
    container.classList.toggle('visible', isPlaying);
    if (!isPlaying && bar) {
      bar.style.width = '0%';
    }
  }
}

// Only trust the real duration reported by the browser.
function getDuration(audio) {
  const d = audio ? audio.duration : NaN;
  return Number.isFinite(d) && d > 0 ? d : null;
}

function updateProgress(fileKey, currentTime, duration) {
  const entry = progressByFile.get(fileKey);
  if (!entry) return;
  const { bar } = entry;

  if (!duration) {
    bar.style.width = '0%';
    return;
  }

  const safeTime = Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;
  const percent = Math.min(100, (safeTime / duration) * 100);
  bar.style.width = `${percent}%`;
}

function resetProgress(fileKey) {
  const entry = progressByFile.get(fileKey);
  if (!entry) return;
  entry.bar.style.width = '0%';
}

function bindProgress(audio, fileKey) {
  const update = () => updateProgress(fileKey, audio.currentTime, getDuration(audio));
  audio.addEventListener('timeupdate', update);
  audio.addEventListener('loadedmetadata', update);
  audio.addEventListener('seeking', update);
  audio.addEventListener('seeked', update);
  audio.addEventListener('durationchange', update);
}

function stopProgressLoop() {
  if (progressRaf !== null) {
    cancelAnimationFrame(progressRaf);
    progressRaf = null;
  }
  progressAudio = null;
}

function startProgressLoop(audio, fileKey) {
  stopProgressLoop();
  if (!audio) return;
  progressAudio = audio;

  const tick = () => {
    if (!progressAudio || progressAudio.paused) return;
    updateProgress(fileKey, progressAudio.currentTime, getDuration(progressAudio));
    progressRaf = requestAnimationFrame(tick);
  };

  tick();
}

function buildTrackCard(file, basePath = '/audio', { draggable = true, hotkeyLabel = null } = {}) {
  const key = trackKey(file, basePath);
  const card = document.createElement('div');
  card.className = 'track-card';
  card.draggable = draggable;
  card.dataset.file = file;
  card.dataset.basePath = basePath;
  cardsByFile.set(key, card);

  const info = document.createElement('div');
  const name = document.createElement('p');
  name.className = 'track-name';
  name.textContent = trackDisplayName(file, hotkeyLabel);
  info.appendChild(name);

  const controls = document.createElement('div');
  controls.className = 'controls';

  const playButton = document.createElement('button');
  playButton.className = 'play';
  playButton.textContent = '▶';
  playButton.title = 'Воспроизвести';
  playButton.addEventListener('click', () => handlePlay(file, playButton, basePath));
  buttonsByFile.set(key, playButton);

  const progress = document.createElement('div');
  progress.className = 'play-progress';
  const progressBar = document.createElement('div');
  progressBar.className = 'play-progress__bar';
  progress.append(progressBar);
  progressByFile.set(key, { container: progress, bar: progressBar });

  const playBlock = document.createElement('div');
  playBlock.className = 'play-block';
  playBlock.append(playButton, progress);

  const volumeWrap = document.createElement('label');
  volumeWrap.className = 'volume';
  const volumeRange = document.createElement('input');
  volumeRange.type = 'range';
  volumeRange.min = '0';
  volumeRange.max = '1';
  volumeRange.step = '0.01';
  volumeRange.value = loadVolume(file, basePath).toString();

  const enableDrag = () => {
    card.draggable = true;
  };
  const disableDrag = () => {
    card.draggable = false;
  };

  ['pointerdown', 'mousedown', 'touchstart'].forEach((event) => {
    volumeRange.addEventListener(event, disableDrag);
  });
  ['pointerup', 'mouseup', 'touchend', 'touchcancel', 'pointerleave'].forEach((event) => {
    volumeRange.addEventListener(event, enableDrag);
  });

  volumeRange.addEventListener('input', () => {
    const numeric = clampVolume(parseFloat(volumeRange.value));
    volumeRange.value = numeric.toString();
    saveVolume(file, numeric, basePath);
    if (currentTrack && currentTrack.key === key && currentAudio) {
      currentAudio.volume = numeric;
    }
  });

  volumeWrap.append(volumeRange);
  controls.append(playBlock, volumeWrap);
  card.append(info, controls);
  if (draggable) {
    attachDragHandlers(card);
  }
  return card;
}

function attachDragHandlers(card) {
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.file);
    card.classList.add('dragging');
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
  });
}

function ensureZoneCount(zones) {
  const normalized = Array.isArray(zones) ? zones.slice(0, MAX_ZONES) : [];
  while (normalized.length < MAX_ZONES) {
    normalized.push([]);
  }
  return normalized.map((zone) => (Array.isArray(zone) ? zone : []));
}

function resetTrackReferences() {
  buttonsByFile = new Map();
  cardsByFile = new Map();
  progressByFile = new Map();
}

function loadLayout(files) {
  availableFiles = files;
  const raw = localStorage.getItem(SETTINGS_KEYS.layout);
  let parsed = [];
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch (err) {
    parsed = [];
  }

  parsed = ensureZoneCount(
    parsed.slice(0, MAX_ZONES).map((zone) => (Array.isArray(zone) ? zone.filter((file) => files.includes(file)) : [])),
  );

  const used = new Set(parsed.flat());
  const missing = files.filter((f) => !used.has(f));

  const allZonesEmpty = parsed.every((zone) => zone.length === 0);
  if (allZonesEmpty) {
    parsed[0] = files.slice();
  } else if (missing.length) {
    parsed[0] = parsed[0].concat(missing);
  }

  layout = parsed;
  saveLayout();
}

function saveLayout() {
  localStorage.setItem(SETTINGS_KEYS.layout, JSON.stringify(layout));
}

function renderZones() {
  zonesContainer.innerHTML = '';
  layout = ensureZoneCount(layout);

  layout.forEach((zoneFiles, zoneIndex) => {
    const zone = document.createElement('div');
    zone.className = 'zone';
    zone.dataset.zoneIndex = zoneIndex.toString();

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => {
      zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', (e) => handleDrop(e, zoneIndex));

    const body = document.createElement('div');
    body.className = 'zone-body';

    zoneFiles.forEach((file, rowIndex) => {
      const hotkeyLabel = HOTKEY_ROWS[rowIndex]?.[zoneIndex] ?? null;
      body.appendChild(buildTrackCard(file, '/audio', { draggable: true, hotkeyLabel }));
    });

    zone.append(body);
    zonesContainer.appendChild(zone);
  });
}

function renderAssetTracks() {
  if (!assetsContainer) return;
  assetsContainer.innerHTML = '';

  if (!assetFiles.length) {
    assetsContainer.innerHTML = '<p class="assets-empty">В папке /assets/audio не найдено аудиофайлов.</p>';
    return;
  }

  assetFiles.forEach((file, index) => {
    const reversedIndex = assetFiles.length - 1 - index;
    const hotkeyLabel = ASSET_HOTKEY_LABELS[reversedIndex] ?? null;
    assetsContainer.appendChild(buildTrackCard(file, '/assets/audio', { draggable: false, hotkeyLabel }));
  });
}

function syncCurrentTrackState() {
  if (!currentTrack) return;
  setButtonPlaying(currentTrack.key, !!(currentAudio && !currentAudio.paused));
}

function handleDrop(event, targetZoneIndex) {
  event.preventDefault();
  const file = event.dataTransfer.getData('text/plain');
  const sourceZoneIndex = findZoneIndex(file);
  if (sourceZoneIndex === -1 || file === '') return;

  const targetZone = event.currentTarget;
  targetZone.classList.remove('drag-over');

  const zoneFiles = layout[targetZoneIndex];
  const dropTargetCard = event.target.closest('.track-card');
  const beforeFile = dropTargetCard ? dropTargetCard.dataset.file : null;

  moveFile(sourceZoneIndex, targetZoneIndex, file, beforeFile);
  renderZones();
  setStatus('Раскладка обновлена и сохранена.');
}

function moveFile(fromZone, toZone, file, beforeFile) {
  if (fromZone === -1 || toZone === -1) return;
  const normalizedLayout = ensureZoneCount(layout);
  const sourceList = normalizedLayout[fromZone];
  const idx = sourceList.indexOf(file);
  if (idx !== -1) {
    sourceList.splice(idx, 1);
  }
  const targetList = normalizedLayout[toZone];
  const insertIndex = beforeFile ? Math.max(0, targetList.indexOf(beforeFile)) : targetList.length;
  targetList.splice(insertIndex, 0, file);
  layout = ensureZoneCount(normalizedLayout);
  saveLayout();
}

function findZoneIndex(file) {
  return layout.findIndex((zone) => zone.includes(file));
}

async function fetchFileList(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Не удалось получить список файлов');
    const data = await res.json();
    return { files: Array.isArray(data.files) ? data.files : [], ok: true };
  } catch (err) {
    console.error(err);
    return { files: [], ok: false };
  }
}

async function loadTracks() {
  const [audioResult, assetResult] = await Promise.all([
    fetchFileList('/api/audio'),
    fetchFileList('/api/assets-audio'),
  ]);

  assetFiles = assetResult.files;
  resetTrackReferences();
  renderAssetTracks();

  if (assetResult.ok) {
    setAssetsStatus('');
  } else {
    setAssetsStatus('Ошибка загрузки списка файлов из /assets/audio.');
  }

  if (!audioResult.ok) {
    renderEmpty();
    syncCurrentTrackState();
    setStatus('Ошибка загрузки списка файлов. Проверьте сервер.');
    return;
  }

  availableFiles = audioResult.files;

  if (!availableFiles.length) {
    renderEmpty();
    syncCurrentTrackState();
    setStatus('Файлы не найдены. Добавьте аудио в папку /audio и обновите страницу.');
    return;
  }

  loadLayout(availableFiles);
  renderZones();
  syncCurrentTrackState();
  setStatus(`Найдено файлов: ${availableFiles.length}`);
}

function resetFadeState() {
  fadeCancel.cancelled = true;
  fadeCancel = { cancelled: false };
}

function fadeOutAndStop(audio, durationSeconds, curve, track) {
  return new Promise((resolve) => {
    let settled = false;
    const safeResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    if (!audio) return resolve();
    const duration = Math.max(0, durationSeconds || 0) * 1000;
    if (duration === 0) {
      audio.pause();
      audio.currentTime = 0;
      setButtonPlaying(track.key, false);
      stopProgressLoop();
      if (currentTrack && currentTrack.key === track.key) {
        currentAudio = null;
        currentTrack = null;
      }
      return safeResolve();
    }
    resetFadeState();
    const token = fadeCancel;
    const start = performance.now();
    const startVolume = clampVolume(audio.volume);

    function step(now) {
      if (token.cancelled) return safeResolve();
      const progress = Math.min((now - start) / duration, 1);
      const eased = easing(progress, curve);
      audio.volume = clampVolume(startVolume * (1 - eased));
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        audio.pause();
        audio.currentTime = 0;
        setButtonPlaying(track.key, false);
        stopProgressLoop();
        if (currentTrack && currentTrack.key === track.key) {
          currentAudio = null;
          currentTrack = null;
        }
        safeResolve();
      }
    }

    requestAnimationFrame(step);
  });
}

function createAudio(track) {
  const { file, basePath, key } = track;
  const encoded = encodeURIComponent(file);
  const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const audio = new Audio(`${normalizedBase}/${encoded}`);
  audio.preload = 'metadata';
  audio.load();

  audio.addEventListener('ended', () => {
    if (currentTrack && currentTrack.key === key) {
      setStatus(`Воспроизведение завершено: ${file}`);
      currentAudio = null;
      currentTrack = null;
    }
    setButtonPlaying(key, false);
    stopProgressLoop();
    resetProgress(key);
  });

  audio.addEventListener('error', () => {
    setStatus(`Ошибка воспроизведения: ${file}`);
    setButtonPlaying(key, false);
    stopProgressLoop();
    resetProgress(key);
    if (currentTrack && currentTrack.key === key) {
      currentAudio = null;
      currentTrack = null;
    }
  });

  bindProgress(audio, key);
  return audio;
}

function applyOverlay(oldAudio, newAudio, targetVolume, overlaySeconds, curve, newTrack, oldTrack) {
  const safeTargetVolume = clampVolume(targetVolume);
  const start = performance.now();
  const duration = overlaySeconds * 1000;
  const initialOldVolume = clampVolume(oldAudio ? oldAudio.volume : 1);
  resetFadeState();
  const token = fadeCancel;

  function step(now) {
    if (token.cancelled) return;
    const progress = Math.min((now - start) / duration, 1);
    const eased = easing(progress, curve);
    newAudio.volume = clampVolume(safeTargetVolume * eased);
    if (oldAudio) {
      oldAudio.volume = clampVolume(initialOldVolume * (1 - eased));
    }
    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      if (oldAudio) {
        oldAudio.pause();
        oldAudio.currentTime = 0;
        oldAudio.volume = initialOldVolume;
        if (oldTrack) setButtonPlaying(oldTrack.key, false);
      }
      currentAudio = newAudio;
      currentTrack = newTrack;
      setButtonPlaying(newTrack.key, true);
      startProgressLoop(newAudio, newTrack.key);
      setStatus(`Играет: ${newTrack.file}`);
    }
  }

  requestAnimationFrame(step);
}

async function handlePlay(file, button, basePath = '/audio') {
  const overlaySeconds = Math.max(0, parseFloat(overlayTimeInput.value) || 0);
  const curve = overlayCurveSelect.value;
  const stopFadeSeconds = Math.max(0, parseFloat(stopFadeInput.value) || 0);
  const targetVolume = clampVolume(loadVolume(file, basePath));
  const track = { file, basePath, key: trackKey(file, basePath) };

  button.disabled = true;

  if (currentTrack && currentTrack.key === track.key && currentAudio && !currentAudio.paused) {
    await fadeOutAndStop(currentAudio, stopFadeSeconds, curve, track);
    setStatus(`Остановлено: ${file}`);
    button.disabled = false;
    return;
  }

  const audio = createAudio(track);
  audio.dataset.filename = file;
  audio.volume = overlaySeconds > 0 && currentAudio && !currentAudio.paused ? 0 : targetVolume;

  try {
    await audio.play();

    if (currentAudio && !currentAudio.paused && overlaySeconds > 0) {
      const oldTrack = currentTrack;
      setButtonPlaying(track.key, true);
      startProgressLoop(audio, track.key);
      applyOverlay(currentAudio, audio, targetVolume, overlaySeconds, curve, track, oldTrack);
    } else {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        if (currentTrack) setButtonPlaying(currentTrack.key, false);
      }
      resetFadeState();
      audio.volume = targetVolume;
      currentAudio = audio;
      currentTrack = track;
      setButtonPlaying(track.key, true);
      startProgressLoop(audio, track.key);
      setStatus(`Играет: ${file}`);
    }
  } catch (err) {
    console.error(err);
    setStatus('Не удалось начать воспроизведение.');
    setButtonPlaying(track.key, false);
    stopProgressLoop();
    resetProgress(track.key);
  } finally {
    button.disabled = false;
  }
}

function initSettings() {
  overlayTimeInput.value = loadSetting(SETTINGS_KEYS.overlayTime, '0.3');
  overlayCurveSelect.value = loadSetting(SETTINGS_KEYS.overlayCurve, 'linear');
  stopFadeInput.value = loadSetting(SETTINGS_KEYS.stopFade, '0.4');

  overlayTimeInput.addEventListener('change', () => {
    const sanitized = Math.max(0, parseFloat(overlayTimeInput.value) || 0).toString();
    overlayTimeInput.value = sanitized;
    saveSetting(SETTINGS_KEYS.overlayTime, sanitized);
  });

  stopFadeInput.addEventListener('change', () => {
    const sanitized = Math.max(0, parseFloat(stopFadeInput.value) || 0).toString();
    stopFadeInput.value = sanitized;
    saveSetting(SETTINGS_KEYS.stopFade, sanitized);
  });

  overlayCurveSelect.addEventListener('change', () => {
    saveSetting(SETTINGS_KEYS.overlayCurve, overlayCurveSelect.value);
  });
}

function setSidebarOpen(isOpen) {
  if (!sidebar || !sidebarToggle) return;
  sidebar.classList.toggle('collapsed', !isOpen);
  sidebarToggle.textContent = isOpen ? '⟨' : '☰';
  saveSetting(SETTINGS_KEYS.sidebarOpen, isOpen ? '1' : '0');
}

function initSidebarToggle() {
  const saved = loadSetting(SETTINGS_KEYS.sidebarOpen, '1');
  setSidebarOpen(saved !== '0');
  sidebarToggle.addEventListener('click', () => {
    const openNow = !sidebar.classList.contains('collapsed');
    setSidebarOpen(!openNow);
  });
}

async function stopServer() {
  if (!stopServerBtn) return;
  stopServerBtn.disabled = true;
  setStatus('Останавливаем сервер...');

  try {
    const res = await fetch('/api/shutdown', { method: 'POST' });
    if (!res.ok) {
      throw new Error('Request failed');
    }
    setStatus('Сервер останавливается. Окно будет закрыто.');
    setTimeout(() => {
      try {
        window.open('', '_self');
        window.close();
      } catch (err) {
        console.error('Не удалось закрыть окно', err);
      }
    }, 300);
  } catch (err) {
    console.error(err);
    setStatus('Не удалось остановить сервер. Попробуйте ещё раз.');
    stopServerBtn.disabled = false;
  }
}

function initServerControls() {
  if (!stopServerBtn) return;
  stopServerBtn.addEventListener('click', stopServer);
}

function initUpdater() {
  if (allowPrereleaseInput) {
    allowPrereleaseInput.checked = loadBooleanSetting(SETTINGS_KEYS.allowPrerelease, false);
    allowPrereleaseInput.addEventListener('change', () => {
      saveSetting(SETTINGS_KEYS.allowPrerelease, allowPrereleaseInput.checked ? 'true' : 'false');
      checkForUpdates();
    });
  }

  if (updateButton) {
    updateButton.addEventListener('click', applyUpdate);
  }
  checkForUpdates();
}

async function loadVersion() {
  if (!appVersionEl) return;

  try {
    const res = await fetch('/api/version');
    if (!res.ok) {
      throw new Error('Request failed');
    }
    const data = await res.json();
    if (data && data.version) {
      appVersionEl.textContent = `Версия: ${data.version}`;
    } else {
      appVersionEl.textContent = 'Версия: неизвестна';
    }
  } catch (err) {
    console.error('Не удалось загрузить версию приложения', err);
    appVersionEl.textContent = 'Версия: неизвестна';
  }
}

function showUpdateBlock(isVisible) {
  if (!updateInfoEl) return;
  updateInfoEl.hidden = !isVisible;
}

function resetUpdateUi() {
  setUpdateMessage('');
  setUpdateStatus('');
  setReleaseLink(null);
  if (updateButton) {
    updateButton.disabled = true;
  }
  showUpdateBlock(false);
}

function setReleaseLink(url, label = 'Релиз') {
  if (!releaseLinkEl) return;
  if (url) {
    releaseLinkEl.href = url;
    releaseLinkEl.textContent = label;
    releaseLinkEl.style.display = 'inline';
  } else {
    releaseLinkEl.style.display = 'none';
  }
}

function setUpdateMessage(text) {
  if (!updateMessageEl) return;
  updateMessageEl.textContent = text;
}

function setUpdateStatus(text) {
  if (!updateStatusEl) return;
  updateStatusEl.textContent = text;
}

function startShutdownCountdown(seconds = 20) {
  let remaining = Math.max(0, Math.floor(seconds));

  if (shutdownCountdownTimer) {
    clearTimeout(shutdownCountdownTimer);
    shutdownCountdownTimer = null;
  }

  const tick = () => {
    if (remaining <= 0) {
      shutdownCountdownTimer = null;
      if (stopServerBtn) {
        stopServerBtn.click();
      } else {
        stopServer();
      }
      return;
    }

    setUpdateMessage(`Приложение будет закрыто через ${remaining} с.`);
    remaining -= 1;
    shutdownCountdownTimer = setTimeout(tick, 1000);
  };

  tick();
}

async function checkForUpdates() {
  if (!updateInfoEl || !updateMessageEl || !updateButton) return;

  resetUpdateUi();

  const allowPrerelease = allowPrereleaseInput ? allowPrereleaseInput.checked : false;

  try {
    const res = await fetch(`/api/update/check?allowPrerelease=${allowPrerelease ? 'true' : 'false'}`);
    if (!res.ok) {
      throw new Error('Request failed');
    }
    const data = await res.json();

    if (data && data.currentVersion && appVersionEl) {
      appVersionEl.textContent = `Версия: ${data.currentVersion}`;
    }

    if (data && data.hasUpdate && data.latestVersion) {
      const releaseLabel = data.releaseName || `v${data.latestVersion}`;
      setUpdateMessage(`Доступен релиз: ${releaseLabel}`);
      setReleaseLink(data.releaseUrl || null, releaseLabel);
      updateButton.disabled = false;
      showUpdateBlock(true);
    }
  } catch (err) {
    console.error('Не удалось проверить обновления', err);
    resetUpdateUi();
  }
}

async function applyUpdate() {
  if (!updateButton) return;

  updateButton.disabled = true;
  setUpdateStatus('Скачиваем и устанавливаем обновление...');

  const allowPrerelease = allowPrereleaseInput ? allowPrereleaseInput.checked : false;

  try {
    const res = await fetch(`/api/update/apply?allowPrerelease=${allowPrerelease ? 'true' : 'false'}`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const message = data && (data.error || data.message);
      throw new Error(message || 'Не удалось выполнить запрос');
    }

    const message = (data && (data.message || data.error)) || 'Обновление выполнено';
    const installed = res.ok && typeof message === 'string' && message.toLowerCase().includes('обновление установлено');

    if (installed) {
      setUpdateStatus('Обновление установлено.');
      startShutdownCountdown(20);
      return;
    }

    setUpdateStatus(message);
  } catch (err) {
    console.error('Ошибка при обновлении', err);
    setUpdateStatus(err.message);
    updateButton.disabled = false;
  }
}

function isEditableTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName ? target.tagName.toLowerCase() : '';
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

function handleHotkey(event) {
  if (event.repeat) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isEditableTarget(event.target)) return;

  const { code } = event;
  if (code === 'Space') {
    if (currentAudio && currentTrack) {
      event.preventDefault();
      const stopFadeSeconds = Math.max(0, parseFloat(stopFadeInput.value) || 0);
      const curve = overlayCurveSelect.value;
      fadeOutAndStop(currentAudio, stopFadeSeconds, curve, currentTrack).then(() => {
        setStatus(`Остановлено: ${currentTrack ? currentTrack.file : ''}`.trim());
      });
    }
    return;
  }
  const rowIndex = HOTKEY_CODES.findIndex((row) => row.includes(code));
  if (rowIndex === -1) {
    const assetIndex = ASSET_HOTKEY_CODES.indexOf(code);
    if (assetIndex === -1) return;
    const reversedIndex = assetFiles.length - 1 - assetIndex;
    const file = assetFiles[reversedIndex];
    if (!file) return;
    const fileKey = trackKey(file, '/assets/audio');
    const button = buttonsByFile.get(fileKey);
    if (!button) return;
    event.preventDefault();
    handlePlay(file, button, '/assets/audio');
    return;
  }
  const zoneIndex = HOTKEY_CODES[rowIndex].indexOf(code);
  const zoneFiles = layout[zoneIndex];
  if (!zoneFiles || zoneFiles.length <= rowIndex) return;
  const file = zoneFiles[rowIndex];
  if (!file) return;

  const fileKey = trackKey(file, '/audio');
  const button = buttonsByFile.get(fileKey);
  if (!button) return;
  event.preventDefault();
  handlePlay(file, button, '/audio');
}

initSettings();
initSidebarToggle();
initServerControls();
initUpdater();
loadTracks();
loadVersion();
document.addEventListener('keydown', handleHotkey);
