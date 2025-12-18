const zonesContainer = document.getElementById('zones');
const statusEl = document.getElementById('status');
const overlayTimeInput = document.getElementById('overlayTime');
const overlayCurveSelect = document.getElementById('overlayCurve');
const stopFadeInput = document.getElementById('stopFadeTime');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const stopServerBtn = document.getElementById('stopServer');

const SETTINGS_KEYS = {
  overlayTime: 'player:overlayTime',
  overlayCurve: 'player:overlayCurve',
  layout: 'player:zones',
  stopFade: 'player:stopFade',
  sidebarOpen: 'player:sidebarOpen',
};

let currentAudio = null;
let currentFile = null;
let fadeCancel = { cancelled: false };
let buttonsByFile = new Map();
const MAX_ZONES = 5;
let layout = Array.from({ length: MAX_ZONES }, () => []); // array of zones -> array of filenames
let availableFiles = [];

function clampVolume(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
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

function loadSetting(key, fallback) {
  const value = localStorage.getItem(key);
  return value !== null ? value : fallback;
}

function saveSetting(key, value) {
  localStorage.setItem(key, value);
}

function volumeKey(file) {
  return `player:volume:${file}`;
}

function loadVolume(file) {
  const saved = localStorage.getItem(volumeKey(file));
  const parsed = saved !== null ? parseFloat(saved) : NaN;
  if (Number.isNaN(parsed)) return 1;
  return clampVolume(parsed);
}

function saveVolume(file, value) {
  localStorage.setItem(volumeKey(file), clampVolume(value).toString());
}

function renderEmpty() {
  zonesContainer.innerHTML = '<div class="empty-state">В папке /audio не найдено аудиофайлов (mp3, wav, ogg, m4a, flac).</div>';
}

function setButtonPlaying(file, isPlaying) {
  const btn = buttonsByFile.get(file);
  if (!btn) return;
  btn.textContent = isPlaying ? '■' : '▶';
  btn.title = isPlaying ? 'Остановить' : 'Воспроизвести';
  btn.classList.toggle('is-playing', isPlaying);
}

function buildTrackCard(file) {
  const card = document.createElement('div');
  card.className = 'track-card';
  card.draggable = true;
  card.dataset.file = file;

  const info = document.createElement('div');
  const name = document.createElement('p');
  name.className = 'track-name';
  name.textContent = stripExtension(file);
  info.appendChild(name);

  const controls = document.createElement('div');
  controls.className = 'controls';

  const playButton = document.createElement('button');
  playButton.className = 'play';
  playButton.textContent = '▶';
  playButton.title = 'Воспроизвести';
  playButton.addEventListener('click', () => handlePlay(file, playButton));
  buttonsByFile.set(file, playButton);

  const volumeWrap = document.createElement('label');
  volumeWrap.className = 'volume';
  const volumeRange = document.createElement('input');
  volumeRange.type = 'range';
  volumeRange.min = '0';
  volumeRange.max = '1';
  volumeRange.step = '0.01';
  volumeRange.value = loadVolume(file).toString();

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
    saveVolume(file, numeric);
    if (currentFile === file && currentAudio) {
      currentAudio.volume = numeric;
    }
  });

  volumeWrap.append(volumeRange);
  controls.append(playButton, volumeWrap);
  card.append(info, controls);
  attachDragHandlers(card);
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
  buttonsByFile = new Map();
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

    zoneFiles.forEach((file) => body.appendChild(buildTrackCard(file)));

    zone.append(body);
    zonesContainer.appendChild(zone);
  });

  if (currentFile) {
    setButtonPlaying(currentFile, !!(currentAudio && !currentAudio.paused));
  }
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

async function fetchTracks() {
  try {
    const res = await fetch('/api/audio');
    if (!res.ok) throw new Error('Не удалось получить список файлов');
    const data = await res.json();
    const files = Array.isArray(data.files) ? data.files : [];
    if (!files.length) {
      renderEmpty();
      setStatus('Файлы не найдены. Добавьте аудио в папку /audio и обновите страницу.');
      return;
    }
    loadLayout(files);
    renderZones();
    setStatus(`Найдено файлов: ${files.length}`);
  } catch (err) {
    console.error(err);
    renderEmpty();
    setStatus('Ошибка загрузки списка файлов. Проверьте сервер.');
  }
}

function resetFadeState() {
  fadeCancel.cancelled = true;
  fadeCancel = { cancelled: false };
}

function fadeOutAndStop(audio, durationSeconds, curve, file) {
  return new Promise((resolve) => {
    if (!audio) return resolve();
    const duration = Math.max(0, durationSeconds || 0) * 1000;
    if (duration === 0) {
      audio.pause();
      audio.currentTime = 0;
      setButtonPlaying(file, false);
      if (currentFile === file) {
        currentAudio = null;
        currentFile = null;
      }
      return resolve();
    }
    resetFadeState();
    const token = fadeCancel;
    const start = performance.now();
    const startVolume = clampVolume(audio.volume);

    function step(now) {
      if (token.cancelled) return;
      const progress = Math.min((now - start) / duration, 1);
      const eased = easing(progress, curve);
      audio.volume = clampVolume(startVolume * (1 - eased));
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        audio.pause();
        audio.currentTime = 0;
        setButtonPlaying(file, false);
        if (currentFile === file) {
          currentAudio = null;
          currentFile = null;
        }
        resolve();
      }
    }

    requestAnimationFrame(step);
  });
}

function createAudio(file) {
  const encoded = encodeURIComponent(file);
  const audio = new Audio(`/audio/${encoded}`);
  audio.addEventListener('ended', () => {
    if (currentFile === file) {
      setStatus(`Воспроизведение завершено: ${file}`);
      setButtonPlaying(file, false);
    }
  });
  return audio;
}

function applyOverlay(oldAudio, newAudio, targetVolume, overlaySeconds, curve, newFile, oldFile) {
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
        if (oldFile) setButtonPlaying(oldFile, false);
      }
      currentAudio = newAudio;
      currentFile = newFile;
      setButtonPlaying(newFile, true);
      setStatus(`Играет: ${newFile}`);
    }
  }

  requestAnimationFrame(step);
}

async function handlePlay(file, button) {
  const overlaySeconds = Math.max(0, parseFloat(overlayTimeInput.value) || 0);
  const curve = overlayCurveSelect.value;
  const stopFadeSeconds = Math.max(0, parseFloat(stopFadeInput.value) || 0);
  const targetVolume = clampVolume(loadVolume(file));

  button.disabled = true;

  if (currentFile === file && currentAudio && !currentAudio.paused) {
    await fadeOutAndStop(currentAudio, stopFadeSeconds, curve, file);
    setStatus(`Остановлено: ${file}`);
    button.disabled = false;
    return;
  }

  const audio = createAudio(file);
  audio.dataset.filename = file;
  audio.volume = overlaySeconds > 0 && currentAudio && !currentAudio.paused ? 0 : targetVolume;

  try {
    await audio.play();
    if (currentAudio && !currentAudio.paused && overlaySeconds > 0) {
      const oldFile = currentFile;
      setButtonPlaying(file, true);
      applyOverlay(currentAudio, audio, targetVolume, overlaySeconds, curve, file, oldFile);
    } else {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        if (currentFile) setButtonPlaying(currentFile, false);
      }
      resetFadeState();
      audio.volume = targetVolume;
      currentAudio = audio;
      currentFile = file;
      setButtonPlaying(file, true);
      setStatus(`Играет: ${file}`);
    }
  } catch (err) {
    console.error(err);
    setStatus('Не удалось начать воспроизведение.');
  } finally {
    button.disabled = false;
  }
}

function initSettings() {
  overlayTimeInput.value = loadSetting(SETTINGS_KEYS.overlayTime, '1.5');
  overlayCurveSelect.value = loadSetting(SETTINGS_KEYS.overlayCurve, 'linear');
  stopFadeInput.value = loadSetting(SETTINGS_KEYS.stopFade, '0.5');

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
    // Попытка закрыть вкладку/окно после успешной остановки
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

initSettings();
initSidebarToggle();
initServerControls();
fetchTracks();
