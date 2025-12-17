const zonesContainer = document.getElementById('zones');
const addZoneBtn = document.getElementById('addZone');
const statusEl = document.getElementById('status');
const overlayTimeInput = document.getElementById('overlayTime');
const overlayCurveSelect = document.getElementById('overlayCurve');

const SETTINGS_KEYS = {
  overlayTime: 'player:overlayTime',
  overlayCurve: 'player:overlayCurve',
  layout: 'player:zones',
};

let currentAudio = null;
let currentFile = null;
let fadeCancel = { cancelled: false };
let buttonsByFile = new Map();
let layout = [[]]; // array of zones -> array of filenames
let availableFiles = [];
const MAX_ZONES = 5;

function clampVolume(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
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
  statusEl.textContent = message;
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
  name.textContent = file;
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
  const volumeValue = document.createElement('span');
  volumeValue.textContent = Math.round(parseFloat(volumeRange.value) * 100) + '%';

  volumeRange.addEventListener('input', () => {
    const numeric = clampVolume(parseFloat(volumeRange.value));
    volumeRange.value = numeric.toString();
    saveVolume(file, numeric);
    volumeValue.textContent = Math.round(numeric * 100) + '%';
    if (currentFile === file && currentAudio) {
      currentAudio.volume = numeric;
    }
  });

  volumeWrap.append(volumeRange, volumeValue);
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

function loadLayout(files) {
  availableFiles = files;
  const raw = localStorage.getItem(SETTINGS_KEYS.layout);
  let parsed = [];
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch (err) {
    parsed = [];
  }

  // filter to existing files
  parsed = parsed
    .slice(0, MAX_ZONES)
    .map((zone) => zone.filter((file) => files.includes(file)))
    .filter((zone) => zone.length);

  const used = new Set(parsed.flat());
  const missing = files.filter((f) => !used.has(f));

  if (!parsed.length) {
    parsed = [files];
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

  updateAddZoneState();
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
  const sourceList = layout[fromZone];
  const idx = sourceList.indexOf(file);
  if (idx !== -1) {
    sourceList.splice(idx, 1);
  }
  const targetList = layout[toZone];
  const insertIndex = beforeFile ? Math.max(0, targetList.indexOf(beforeFile)) : targetList.length;
  targetList.splice(insertIndex, 0, file);
  layout = layout.filter((z) => z.length); // drop empty zones
  if (!layout.length) layout = [[]];
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
  const targetVolume = clampVolume(loadVolume(file));

  button.disabled = true;

  if (currentFile === file && currentAudio && !currentAudio.paused) {
    await fadeOutAndStop(currentAudio, overlaySeconds, curve, file);
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

  overlayTimeInput.addEventListener('change', () => {
    const sanitized = Math.max(0, parseFloat(overlayTimeInput.value) || 0).toString();
    overlayTimeInput.value = sanitized;
    saveSetting(SETTINGS_KEYS.overlayTime, sanitized);
  });

  overlayCurveSelect.addEventListener('change', () => {
    saveSetting(SETTINGS_KEYS.overlayCurve, overlayCurveSelect.value);
  });
}

function initZonesControls() {
  addZoneBtn.addEventListener('click', () => {
    if (layout.length >= MAX_ZONES) {
      setStatus(`Максимум полей: ${MAX_ZONES}`);
      updateAddZoneState();
      return;
    }
    layout.push([]);
    saveLayout();
    renderZones();
  });

  updateAddZoneState();
}

function updateAddZoneState() {
  if (!addZoneBtn) return;
  const disabled = layout.length >= MAX_ZONES;
  addZoneBtn.disabled = disabled;
}

initSettings();
initZonesControls();
fetchTracks();
