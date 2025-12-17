const tracksContainer = document.getElementById('tracks');
const statusEl = document.getElementById('status');
const overlayTimeInput = document.getElementById('overlayTime');
const overlayCurveSelect = document.getElementById('overlayCurve');
const fileInput = document.getElementById('fileInput');

const SETTINGS_KEYS = {
  overlayTime: 'player:overlayTime',
  overlayCurve: 'player:overlayCurve',
};

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);

let currentAudio = null;
let currentTrack = null;
let fadeCancel = { cancelled: false };
let objectUrls = [];
let tracks = [];

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

function volumeKey(track) {
  return `player:volume:${track.id}`;
}

function loadVolume(track) {
  const saved = localStorage.getItem(volumeKey(track));
  const parsed = saved !== null ? parseFloat(saved) : NaN;
  if (Number.isNaN(parsed)) return 1;
  return Math.max(0, Math.min(1, parsed));
}

function saveVolume(track, value) {
  localStorage.setItem(volumeKey(track), value.toString());
}

function renderEmpty() {
  tracksContainer.innerHTML = '<div class="empty-state">Выберите папку или файлы, чтобы показать треки.</div>';
}

function resetFadeState() {
  fadeCancel.cancelled = true;
  fadeCancel = { cancelled: false };
}

function createAudio(track) {
  const audio = new Audio(track.url);
  audio.dataset.trackId = track.id;
  audio.addEventListener('ended', () => {
    if (currentTrack && currentTrack.id === track.id) {
      setStatus(`Воспроизведение завершено: ${track.label}`);
    }
  });
  return audio;
}

function applyOverlay(oldAudio, newAudio, targetVolume, overlaySeconds, curve, track) {
  const start = performance.now();
  const duration = overlaySeconds * 1000;
  const initialOldVolume = oldAudio ? oldAudio.volume : 1;
  resetFadeState();
  const token = fadeCancel;

  function step(now) {
    if (token.cancelled) return;
    const progress = Math.min((now - start) / duration, 1);
    const eased = easing(progress, curve);
    newAudio.volume = targetVolume * eased;
    if (oldAudio) {
      oldAudio.volume = initialOldVolume * (1 - eased);
    }
    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      if (oldAudio) {
        oldAudio.pause();
        oldAudio.currentTime = 0;
        oldAudio.volume = initialOldVolume;
      }
      currentAudio = newAudio;
      currentTrack = track;
      setStatus(`Играет: ${track.label}`);
    }
  }

  requestAnimationFrame(step);
}

async function handlePlay(track, button) {
  const overlaySeconds = Math.max(0, parseFloat(overlayTimeInput.value) || 0);
  const curve = overlayCurveSelect.value;
  const targetVolume = loadVolume(track);

  button.disabled = true;
  const audio = createAudio(track);
  audio.volume = overlaySeconds > 0 && currentAudio && !currentAudio.paused ? 0 : targetVolume;

  try {
    await audio.play();
    if (currentAudio && !currentAudio.paused && overlaySeconds > 0) {
      applyOverlay(currentAudio, audio, targetVolume, overlaySeconds, curve, track);
    } else {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
      }
      resetFadeState();
      audio.volume = targetVolume;
      currentAudio = audio;
      currentTrack = track;
      setStatus(`Играет: ${track.label}`);
    }
  } catch (err) {
    console.error(err);
    setStatus('Не удалось начать воспроизведение.');
  } finally {
    button.disabled = false;
  }
}

function createTrackRow(track) {
  const card = document.createElement('div');
  card.className = 'track-card';

  const info = document.createElement('div');
  const name = document.createElement('p');
  name.className = 'track-name';
  name.textContent = track.label;
  info.appendChild(name);

  const controls = document.createElement('div');
  controls.className = 'controls';

  const playButton = document.createElement('button');
  playButton.className = 'play';
  playButton.textContent = '▶ Воспроизвести';
  playButton.addEventListener('click', () => handlePlay(track, playButton));

  const volumeWrap = document.createElement('label');
  volumeWrap.className = 'volume';
  const volumeRange = document.createElement('input');
  volumeRange.type = 'range';
  volumeRange.min = '0';
  volumeRange.max = '1';
  volumeRange.step = '0.01';
  volumeRange.value = loadVolume(track).toString();
  const volumeValue = document.createElement('span');
  volumeValue.textContent = Math.round(parseFloat(volumeRange.value) * 100) + '%';

  volumeRange.addEventListener('input', () => {
    const numeric = parseFloat(volumeRange.value);
    saveVolume(track, numeric);
    volumeValue.textContent = Math.round(numeric * 100) + '%';
    if (currentTrack && currentTrack.id === track.id && currentAudio) {
      currentAudio.volume = numeric;
    }
  });

  volumeWrap.append(volumeRange, volumeValue);
  controls.append(playButton, volumeWrap);

  card.append(info, controls);
  return card;
}

function renderTracks() {
  if (!tracks.length) {
    renderEmpty();
    return;
  }
  tracksContainer.innerHTML = '';
  tracks.forEach((track) => tracksContainer.appendChild(createTrackRow(track)));
  setStatus(`Найдено файлов: ${tracks.length}`);
}

function isAudioFile(file) {
  const ext = file.name.split('.').pop();
  if (!ext) return false;
  return AUDIO_EXTENSIONS.has(`.${ext.toLowerCase()}`);
}

function revokeObjectUrls() {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls = [];
}

function handleFilesSelected(fileList) {
  revokeObjectUrls();
  tracks = Array.from(fileList)
    .filter((f) => isAudioFile(f))
    .map((file) => {
      const url = URL.createObjectURL(file);
      objectUrls.push(url);
      const label = file.webkitRelativePath || file.name;
      const id = `${file.name}-${file.size}-${file.lastModified}`;
      return { id, url, label };
    });

  if (!tracks.length) {
    renderEmpty();
    setStatus('Аудиофайлы не найдены в выбранных элементах.');
    return;
  }
  renderTracks();
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

function initPicker() {
  fileInput.addEventListener('change', (event) => {
    const files = event.target.files || [];
    handleFilesSelected(files);
  });
}

initSettings();
initPicker();
renderEmpty();
setStatus('Выберите аудио-файлы или папку, чтобы начать.');
