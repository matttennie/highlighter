const tokenInput = document.getElementById('apiToken');
const modelSelect = document.getElementById('modelId');
const voiceSelect = document.getElementById('defaultVoice');
const speedSelect = document.getElementById('defaultSpeed');
const articleToggle = document.getElementById('articleMode');
const providerHint = document.getElementById('providerHint');
const modelHint = document.getElementById('modelHint');
const voiceHint = document.getElementById('voiceHint');
const statusEl = document.getElementById('status');
const copyDebugLogBtn = document.getElementById('copyDebugLog');
const clearDebugLogBtn = document.getElementById('clearDebugLog');
const debugPreview = document.getElementById('debugPreview');
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
const LOG_PREFIX = '[Highlighter Popup]';
const DEBUG_LOG_KEY = 'debugLog';
const MODEL_OPTIONS = [
  { value: 'eleven_flash_v2_5', label: 'Flash v2.5 (recommended)' },
  { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5' },
  { value: 'eleven_multilingual_v2', label: 'Multilingual v2' },
];
let statusTimer = 0;
let tokenSaveTimer = 0;

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

function isSupportedModelId(modelId) {
  return MODEL_OPTIONS.some((model) => model.value === modelId);
}

function syncElevenLabsUi(savedModelId, savedVoiceId) {
  providerHint.textContent = 'Enter an ElevenLabs key that starts with sk_.';
  modelHint.textContent = 'Model options for ElevenLabs.';
  voiceHint.textContent = 'The dropdown shows API-returned ElevenLabs voices when available; otherwise it falls back to the configured voice.';

  const modelFragment = document.createDocumentFragment();
  for (const model of MODEL_OPTIONS) {
    const option = document.createElement('option');
    option.value = model.value;
    option.textContent = model.label;
    modelFragment.appendChild(option);
  }
  modelSelect.replaceChildren(modelFragment);
  const effectiveModelId = isSupportedModelId(savedModelId) ? savedModelId : DEFAULT_MODEL_ID;
  modelSelect.value = effectiveModelId;
  if (savedModelId && savedModelId !== effectiveModelId) {
    logDebug('stale-model-reset', { from: savedModelId, to: effectiveModelId });
    chrome.storage.local.set({ modelId: effectiveModelId });
  }
  ensureVoiceOption(savedVoiceId || DEFAULT_VOICE_ID, 'Configured voice');
}

// Load saved settings
chrome.storage.local.get(
  ['apiKey', 'elApiKey', 'modelId', 'defaultVoice', 'defaultSpeed', 'articleMode'],
  (data) => {
    const storageError = chrome.runtime.lastError?.message || null;
    if (storageError) {
      logDebug('settings-load-failed', { error: storageError });
      showStatus('Could not load settings');
      return;
    }
    const savedApiKey = data.apiKey || data.elApiKey || '';
    logDebug('settings-loaded', {
      hasApiKey: Boolean(savedApiKey),
      modelId: data.modelId || null,
      defaultVoice: data.defaultVoice || null,
      defaultSpeed: data.defaultSpeed || null,
      articleMode: data.articleMode,
    });
    if (savedApiKey) tokenInput.value = savedApiKey;
    syncElevenLabsUi(data.modelId, data.defaultVoice);
    if (data.defaultSpeed) speedSelect.value = data.defaultSpeed;
    if (data.articleMode !== undefined) articleToggle.checked = data.articleMode;
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

function saveApiKey(value) {
  logDebug('save-api-key', { hasApiKey: Boolean(value) });
  chrome.storage.local.set({ apiKey: value, elApiKey: value }, () => {
    const error = chrome.runtime.lastError?.message || null;
    showStatus(error ? 'Could not save API key' : 'Saved');
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
      ensureVoiceOption(selectedVoice || DEFAULT_VOICE_ID, 'Configured voice');
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
    const effectiveVoiceId = Array.from(voiceSelect.options).some((option) => option.value === selectedVoice)
      ? selectedVoice
      : DEFAULT_VOICE_ID;
    voiceSelect.value = effectiveVoiceId;
    if (!voiceSelect.value) {
      ensureVoiceOption(DEFAULT_VOICE_ID, 'Configured voice');
      voiceSelect.value = DEFAULT_VOICE_ID;
    }
    if (effectiveVoiceId !== selectedVoice && effectiveVoiceId) {
      logDebug('stale-voice-reset', { from: selectedVoice, to: effectiveVoiceId });
      setDefaultVoice(effectiveVoiceId);
    }
  });
}

function saveTokenSoon() {
  clearTimeout(tokenSaveTimer);
  tokenSaveTimer = setTimeout(() => {
    saveApiKey(tokenInput.value.trim());
    tokenSaveTimer = 0;
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

tokenInput.addEventListener('input', saveTokenSoon);
tokenInput.addEventListener('blur', () => {
  clearTimeout(tokenSaveTimer);
  saveApiKey(tokenInput.value.trim());
  tokenSaveTimer = 0;
  loadVoices(voiceSelect.value || DEFAULT_VOICE_ID);
});
modelSelect.addEventListener('change', () => save('modelId', modelSelect.value));
voiceSelect.addEventListener('change', () => save('defaultVoice', voiceSelect.value));
speedSelect.addEventListener('change', () => save('defaultSpeed', speedSelect.value));
articleToggle.addEventListener('change', () => save('articleMode', articleToggle.checked));
copyDebugLogBtn.addEventListener('click', copyDebugLog);
clearDebugLogBtn.addEventListener('click', clearDebugLog);
