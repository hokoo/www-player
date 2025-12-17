const tracksContainer = document.getElementById('tracks');
const statusEl = document.getElementById('status');
const overlayTimeInput = document.getElementById('overlayTime');
const overlayCurveSelect = document.getElementById('overlayCurve');

const SETTINGS_KEYS = {
  overlayTime: 'player:overlayTime',
  overlayCurve: 'player:overlayCurve',
};

let currentAudio = null;
let currentFile = null;
let fadeCancel = { cancelled: false };
let buttonsByFile = new Map();

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
  tracksContainer.innerHTML = '<div class="empty-state">В папке /audio не найдено аудиофайлов (mp3, wav, ogg, m4a, flac).</div>';
}

function setButtonPlaying(file, isPlaying) {
  const btn = buttonsByFile.get(file);
  if (!btn) return;
  btn.textContent = isPlaying ? '■' : '▶';
  btn.title = isPlaying ? 'Остановить' : 'Воспроизвести';
  btn.classList.toggle('is-playing', isPlaying);
}

function createTrackRow(file) {
  const card = document.createElement('div');
  card.className = 'track-card';

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
  return card;
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
    tracksContainer.innerHTML = '';
    buttonsByFile = new Map();
    files.forEach((file) => tracksContainer.appendChild(createTrackRow(file)));
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
    currentAudio.pause();
    currentAudio.currentTime = 0;
    resetFadeState();
    setButtonPlaying(file, false);
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

initSettings();
fetchTracks();
