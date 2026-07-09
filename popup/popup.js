const voiceSelect = document.getElementById('defaultVoice');
const speedSlider = document.getElementById('defaultSpeed');
const speedValueEl = document.getElementById('speedValue');
const engineStatusEl = document.getElementById('engineStatus');
const articleToggle = document.getElementById('articleMode');
const statusEl = document.getElementById('status');
const copyDebugLogBtn = document.getElementById('copyDebugLog');
const clearDebugLogBtn = document.getElementById('clearDebugLog');
const testVoiceBtn = document.getElementById('testVoiceBtn');
const debugPreview = document.getElementById('debugPreview');
const DEFAULT_VOICE_ID = 'bf_emma';
const LOG_PREFIX = '[Highlighter Popup]';
const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
const ENGINE_POLL_MS = 1000;

let statusTimer = 0;
let enginePollTimer = 0;
let voicesLoadedFromEngine = false;

function logDebug(event, details = {}) {
  console.log(`${LOG_PREFIX} ${event}`, details);
  persistDebugEvent('popup', event, details);
}

function persistDebugEvent(source, event, details = {}) {
  chrome.runtime.sendMessage(
    {
      type: 'debug-event',
      entry: {
        ts: new Date().toISOString(),
        source,
        event,
        details,
      },
    },
    () => {
      // Suppress benign errors while the service worker is restarting.
      void chrome.runtime.lastError;
    }
  );
}

// ── Speed slider helpers ────────────────────────────────────────────
// Snap to one decimal in [0.5, 2.0] so storage stays clean even if the
// range input reports float drift (e.g. 0.7000000000000001).
function snapSpeed(value) {
  const raw = parseFloat(value);
  const safe = Number.isFinite(raw) ? raw : 1.0;
  const clamped = Math.max(SPEED_MIN, Math.min(SPEED_MAX, safe));
  return Math.round(clamped * 10) / 10;
}

function formatSpeedLabel(speed) {
  return `${speed.toFixed(1)}×`;
}

function renderSpeed(speed) {
  speedSlider.value = speed.toString();
  speedValueEl.textContent = formatSpeedLabel(speed);
}

// ── Load saved settings ─────────────────────────────────────────────
chrome.storage.local.get(['defaultVoice', 'defaultSpeed', 'articleMode'], (data) => {
  const storageError = chrome.runtime.lastError?.message || null;
  if (storageError) {
    logDebug('settings-load-failed', { error: storageError });
    showStatus('Could not load settings');
    return;
  }

  logDebug('settings-loaded', {
    defaultVoice: data.defaultVoice || null,
    defaultSpeed: data.defaultSpeed || null,
    articleMode: data.articleMode,
  });

  const effectiveVoice = data.defaultVoice || DEFAULT_VOICE_ID;
  renderSpeed(snapSpeed(data.defaultSpeed ?? 1.2));
  if (data.articleMode !== undefined) articleToggle.checked = data.articleMode;

  ensureVoiceOption(effectiveVoice, 'Saved voice');
  refreshEngineStatus();
  loadVoices(effectiveVoice);
});

function showStatus(msg) {
  statusEl.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = '';
    statusTimer = 0;
  }, 2000);
}

function save(key, value) {
  logDebug('save-setting', { key, value });
  chrome.storage.local.set({ [key]: value }, () => {
    const error = chrome.runtime.lastError?.message || null;
    showStatus(error ? 'Could not save setting' : 'Saved');
  });
}

function ensureVoiceOption(voiceId, label) {
  if (!voiceId) return;
  const existing = Array.from(voiceSelect.options).find((option) => option.value === voiceId);
  if (existing) {
    existing.textContent = label || existing.textContent;
    voiceSelect.value = voiceId;
    return;
  }

  const option = document.createElement('option');
  option.value = voiceId;
  option.textContent = label || voiceId;
  voiceSelect.appendChild(option);
  voiceSelect.value = voiceId;
}

function setDefaultVoice(voiceId) {
  chrome.storage.local.set({ defaultVoice: voiceId }, () => {
    const error = chrome.runtime.lastError?.message || null;
    showStatus(error ? 'Could not save voice' : 'Saved');
  });
}

function loadVoices(selectedVoice) {
  const startedAt = performance.now();
  logDebug('voices-request-start', { selectedVoice });
  chrome.runtime.sendMessage({ type: 'voices-request' }, (response) => {
    logDebug('voices-response', {
      ok: Boolean(response?.ok),
      error: response?.error || null,
      voiceCount: response?.voices?.length || 0,
      elapsedMs: Math.round(performance.now() - startedAt),
      runtimeError: chrome.runtime.lastError?.message || null,
    });
    if (chrome.runtime.lastError || !response || !response.ok || !response.voices?.length) {
      // Model probably still downloading — the engine-status poll retries
      // loadVoices once the engine reports ready.
      ensureVoiceOption(selectedVoice || DEFAULT_VOICE_ID, 'Default voice');
      return;
    }

    const groups = new Map();
    for (const voice of response.voices) {
      const category = voice.category || 'Other';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(voice);
    }

    const fragment = document.createDocumentFragment();
    for (const [category, voices] of groups) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = category;
      for (const voice of voices) {
        const option = document.createElement('option');
        option.value = voice.voiceId;
        option.textContent = voice.name;
        optgroup.appendChild(option);
      }
      fragment.appendChild(optgroup);
    }

    voiceSelect.replaceChildren(fragment);
    voicesLoadedFromEngine = true;
    const effectiveVoiceId = Array.from(voiceSelect.options).some((option) => option.value === selectedVoice)
      ? selectedVoice
      : DEFAULT_VOICE_ID;
    voiceSelect.value = effectiveVoiceId;
    if (!voiceSelect.value && voiceSelect.options.length > 0) {
      voiceSelect.selectedIndex = 0;
    }
    if (effectiveVoiceId !== selectedVoice && effectiveVoiceId) {
      logDebug('stale-voice-reset', { from: selectedVoice, to: effectiveVoiceId });
      setDefaultVoice(effectiveVoiceId);
    }
  });
}

// ── Engine status ───────────────────────────────────────────────────
function scheduleEnginePoll() {
  clearTimeout(enginePollTimer);
  enginePollTimer = setTimeout(refreshEngineStatus, ENGINE_POLL_MS);
}

function refreshEngineStatus() {
  chrome.runtime.sendMessage({ type: 'engine-status-request' }, (resp) => {
    const runtimeError = chrome.runtime.lastError?.message || null;
    if (runtimeError || !resp || !resp.ok) {
      engineStatusEl.textContent = 'Engine unavailable — system voice will be used';
      logDebug('engine-status-failed', { error: runtimeError || resp?.error || 'no-response' });
      return;
    }
    switch (resp.status) {
      case 'downloading':
        engineStatusEl.textContent = `Downloading voice model — ${resp.progress || 0}%`;
        scheduleEnginePoll();
        break;
      case 'ready':
        engineStatusEl.textContent = resp.device === 'webgpu'
          ? 'Ready — on-device (GPU)'
          : 'Ready — on-device (CPU)';
        if (!voicesLoadedFromEngine) loadVoices(voiceSelect.value || DEFAULT_VOICE_ID);
        break;
      case 'error':
        engineStatusEl.textContent = `Engine error: ${resp.error || 'unknown'}`;
        break;
      default: // 'idle' — engine starts loading on first request
        engineStatusEl.textContent = 'Starting voice engine…';
        scheduleEnginePoll();
    }
  });
}

// ── Debug log actions ───────────────────────────────────────────────
function formatDebugEntries(entries) {
  return entries
    .map((entry) => {
      const details = entry.details ? ` ${JSON.stringify(entry.details)}` : '';
      return `${entry.ts} [${entry.source}] ${entry.event}${details}`;
    })
    .join('\n');
}

function copyDebugLog() {
  chrome.runtime.sendMessage({ type: 'debug-log-request' }, async (response) => {
    const runtimeError = chrome.runtime.lastError?.message || null;
    if (runtimeError || !response?.ok) {
      debugPreview.style.display = 'block';
      debugPreview.textContent = runtimeError || response?.error || 'Debug log unavailable.';
      showStatus('Debug log unavailable');
      return;
    }
    const entries = Array.isArray(response?.entries) ? response.entries : [];
    const text = formatDebugEntries(entries);
    debugPreview.style.display = 'block';
    debugPreview.textContent = text || 'No debug entries yet.';
    try {
      await navigator.clipboard.writeText(text || 'No debug entries yet.');
      showStatus(`Copied ${entries.length} debug entries`);
    } catch {
      showStatus(`Showing ${entries.length} debug entries`);
    }
  });
}

function clearDebugLog() {
  chrome.runtime.sendMessage({ type: 'debug-log-clear' }, (response) => {
    const runtimeError = chrome.runtime.lastError?.message || null;
    if (runtimeError || !response?.ok) {
      showStatus('Could not clear debug log');
      return;
    }
    debugPreview.style.display = 'none';
    debugPreview.textContent = '';
    showStatus('Debug log cleared');
  });
}

function showInPreview(lines) {
  debugPreview.style.display = 'block';
  debugPreview.textContent = lines.join('\n');
}

// ── Test voice ──────────────────────────────────────────────────────
function testVoice() {
  testVoiceBtn.disabled = true;
  testVoiceBtn.textContent = 'Synthesizing…';
  const voice = voiceSelect.value || DEFAULT_VOICE_ID;
  const speed = snapSpeed(speedSlider.value);
  const startedAt = performance.now();
  chrome.runtime.sendMessage(
    { type: 'tts-request', text: 'This is your Kokoro voice.', voice, speed },
    (resp) => {
      const runtimeError = chrome.runtime.lastError?.message || null;
      testVoiceBtn.disabled = false;
      testVoiceBtn.textContent = 'Test Voice';
      if (runtimeError || !resp?.ok || !resp.audioDataUrl) {
        const reason = resp?.error === 'model-loading'
          ? `Model still downloading (${resp.progress || 0}%).`
          : (resp?.detail || resp?.error || runtimeError || 'no response');
        showInPreview([`Test failed: ${reason}`]);
        showStatus('Test failed');
        refreshEngineStatus();
        return;
      }
      showInPreview([
        `Synthesized in ${Math.round(performance.now() - startedAt)} ms`,
        `Voice: ${voice}  Speed: ${formatSpeedLabel(speed)}`,
        `Audio: ${Math.round(resp.audioDataUrl.length / 1024)} KB (base64 WAV)`,
      ]);
      new Audio(resp.audioDataUrl).play().catch((err) => {
        showStatus(`Playback failed: ${err?.message || err}`);
      });
      showStatus('Playing test voice');
    }
  );
}

// ── Event wiring ────────────────────────────────────────────────────
voiceSelect.addEventListener('change', () => save('defaultVoice', voiceSelect.value));
speedSlider.addEventListener('input', () => {
  speedValueEl.textContent = formatSpeedLabel(snapSpeed(speedSlider.value));
});
speedSlider.addEventListener('change', () => {
  const snapped = snapSpeed(speedSlider.value);
  renderSpeed(snapped);
  save('defaultSpeed', snapped.toString());
});
articleToggle.addEventListener('change', () => save('articleMode', articleToggle.checked));
copyDebugLogBtn.addEventListener('click', copyDebugLog);
clearDebugLogBtn.addEventListener('click', clearDebugLog);
testVoiceBtn.addEventListener('click', testVoice);
