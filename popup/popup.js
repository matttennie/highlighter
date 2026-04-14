const inworldTokenInput = document.getElementById('inworldApiToken');
const modelSelect = document.getElementById('modelId');
const voiceSelect = document.getElementById('defaultVoice');
const speedSelect = document.getElementById('defaultSpeed');
const articleToggle = document.getElementById('articleMode');
const statusEl = document.getElementById('status');
const copyDebugLogBtn = document.getElementById('copyDebugLog');
const clearDebugLogBtn = document.getElementById('clearDebugLog');
const debugPreview = document.getElementById('debugPreview');
const DEFAULT_VOICE_ID = 'Sarah';
const DEFAULT_MODEL_ID = 'inworld-tts-1.5-max';
const LOG_PREFIX = '[Highlighter Popup]';
const DEBUG_LOG_KEY = 'debugLog';
const INWORLD_KEY_NAME = 'inworld_Highlighter_API_Key';

let statusTimer = 0;
let inworldTokenSaveTimer = 0;

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

// Load saved settings
chrome.storage.local.get(
  ['modelId', 'defaultVoice', 'defaultSpeed', 'articleMode', INWORLD_KEY_NAME],
  (data) => {
    const storageError = chrome.runtime.lastError?.message || null;
    if (storageError) {
      logDebug('settings-load-failed', { error: storageError });
      showStatus('Could not load settings');
      return;
    }
    const savedInworldKey = data[INWORLD_KEY_NAME] || '';

    logDebug('settings-loaded', {
      hasInworldKey: Boolean(savedInworldKey),
      modelId: data.modelId || null,
      defaultVoice: data.defaultVoice || null,
      defaultSpeed: data.defaultSpeed || null,
      articleMode: data.articleMode,
    });
    if (savedInworldKey) inworldTokenInput.value = savedInworldKey;

    if (data.modelId) modelSelect.value = data.modelId;
    else modelSelect.value = DEFAULT_MODEL_ID;

    if (data.defaultSpeed) speedSelect.value = data.defaultSpeed;
    if (data.articleMode !== undefined) articleToggle.checked = data.articleMode;
    
    ensureVoiceOption(data.defaultVoice || DEFAULT_VOICE_ID, 'Default Voice');
    loadVoices(data.defaultVoice || DEFAULT_VOICE_ID);
  }
);

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

function saveInworldApiKey(value) {
  logDebug('save-inworld-api-key', { hasInworldKey: Boolean(value) });
  chrome.storage.local.set({ [INWORLD_KEY_NAME]: value }, () => {
    const error = chrome.runtime.lastError?.message || null;
    showStatus(error ? 'Could not save Inworld API key' : 'Saved');
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
      status: response?.status || null,
      voiceCount: response?.voices?.length || 0,
      elapsedMs: Math.round(performance.now() - startedAt),
      runtimeError: chrome.runtime.lastError?.message || null,
    });
    if (chrome.runtime.lastError || !response || !response.ok || !response.voices?.length) {
      ensureVoiceOption(selectedVoice || DEFAULT_VOICE_ID, 'Default Voice');
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const voice of response.voices) {
      const option = document.createElement('option');
      option.value = voice.voiceId;
      option.textContent = voice.name;
      fragment.appendChild(option);
    }

    voiceSelect.replaceChildren(fragment);
    const effectiveVoiceId = Array.from(voiceSelect.options).some((option) => option.value === selectedVoice)
      ? selectedVoice
      : DEFAULT_VOICE_ID;
    voiceSelect.value = effectiveVoiceId;
    if (!voiceSelect.value && voiceSelect.options.length > 0) {
      voiceSelect.selectedIndex = 0;
    }
  });
}

function saveInworldTokenSoon() {
  clearTimeout(inworldTokenSaveTimer);
  inworldTokenSaveTimer = setTimeout(() => {
    saveInworldApiKey(inworldTokenInput.value.trim());
    inworldTokenSaveTimer = 0;
  }, 250);
}

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

inworldTokenInput.addEventListener('input', saveInworldTokenSoon);
inworldTokenInput.addEventListener('blur', () => {
  clearTimeout(inworldTokenSaveTimer);
  saveInworldApiKey(inworldTokenInput.value.trim());
  inworldTokenSaveTimer = 0;
  loadVoices(voiceSelect.value || DEFAULT_VOICE_ID);
});

modelSelect.addEventListener('change', () => save('modelId', modelSelect.value));
voiceSelect.addEventListener('change', () => save('defaultVoice', voiceSelect.value));
speedSelect.addEventListener('change', () => save('defaultSpeed', speedSelect.value));
articleToggle.addEventListener('change', () => save('articleMode', articleToggle.checked));
copyDebugLogBtn.addEventListener('click', copyDebugLog);
clearDebugLogBtn.addEventListener('click', clearDebugLog);
