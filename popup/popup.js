const inworldTokenInput = document.getElementById('inworldApiToken');
const modelSelect = document.getElementById('modelId');
const voiceSelect = document.getElementById('defaultVoice');
const speedSelect = document.getElementById('defaultSpeed');
const articleToggle = document.getElementById('articleMode');
const statusEl = document.getElementById('status');
const copyDebugLogBtn = document.getElementById('copyDebugLog');
const clearDebugLogBtn = document.getElementById('clearDebugLog');
const testApiBtn = document.getElementById('testApiBtn');
const debugPreview = document.getElementById('debugPreview');
const DEFAULT_VOICE_ID = 'Ashley';
const DEFAULT_MODEL_ID = 'inworld-tts-1.5-max';
const LOG_PREFIX = '[Highlighter Popup]';
const DEBUG_LOG_KEY = 'debugLog';
const INWORLD_KEY_NAME = 'inworld_Highlighter_API_Key';
const SUPPORTED_MODEL_IDS = new Set([
  'inworld-tts-1.5-max',
  'inworld-tts-1.5-mini',
]);

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

function isSupportedModelId(modelId) {
  return SUPPORTED_MODEL_IDS.has(modelId);
}

// Legacy ElevenLabs voice IDs were long 20-char hashes; Inworld voices are short names.
// If storage still holds a stale ElevenLabs hash, swap it for the default Inworld voice.
function looksLikeLegacyVoiceId(voiceId) {
  return typeof voiceId === 'string' && voiceId.length > 15;
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

    const effectiveModelId = isSupportedModelId(data.modelId) ? data.modelId : DEFAULT_MODEL_ID;
    modelSelect.value = effectiveModelId;
    if (data.modelId && data.modelId !== effectiveModelId) {
      logDebug('stale-model-reset', { from: data.modelId, to: effectiveModelId });
      chrome.storage.local.set({ modelId: effectiveModelId });
    }

    let effectiveVoice = data.defaultVoice || DEFAULT_VOICE_ID;
    if (looksLikeLegacyVoiceId(effectiveVoice)) {
      logDebug('stale-voice-reset-on-load', { from: data.defaultVoice, to: DEFAULT_VOICE_ID });
      effectiveVoice = DEFAULT_VOICE_ID;
      chrome.storage.local.set({ defaultVoice: effectiveVoice });
    }

    if (data.defaultSpeed) speedSelect.value = data.defaultSpeed;
    if (data.articleMode !== undefined) articleToggle.checked = data.articleMode;

    ensureVoiceOption(effectiveVoice, 'Default Voice');
    loadVoices(effectiveVoice);
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

    const groups = new Map();
    for (const voice of response.voices) {
      const category = voice.category || 'Global';
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
    if (!voiceSelect.value && voiceSelect.options.length > 0) {
      voiceSelect.selectedIndex = 0;
    }
    if (effectiveVoiceId !== selectedVoice && effectiveVoiceId) {
      logDebug('stale-voice-reset', { from: selectedVoice, to: effectiveVoiceId });
      setDefaultVoice(effectiveVoiceId);
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

function describeVoiceCount(voicesResponse) {
  if (!voicesResponse?.ok) return 'voices: error';
  const count = voicesResponse.voices?.length || 0;
  return `voices: ${count}`;
}

function showInPreview(lines) {
  debugPreview.style.display = 'block';
  debugPreview.textContent = lines.join('\n');
}

async function runApiSelfTest() {
  const startedAt = performance.now();
  testApiBtn.disabled = true;
  testApiBtn.textContent = 'Testing...';
  showInPreview(['Running Inworld API self-test...']);
  showStatus('Testing Inworld API');

  const apiKey = inworldTokenInput.value.trim();
  if (!apiKey) {
    showInPreview([
      'No API key set.',
      'Enter your Inworld key first (Studio → API Keys, base64-encoded).',
    ]);
    showStatus('No API key');
    testApiBtn.disabled = false;
    testApiBtn.textContent = 'Test Inworld API';
    return;
  }

  const voicesResponse = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'voices-request' }, (resp) => {
      resolve(resp || { ok: false, error: chrome.runtime.lastError?.message || 'no-response' });
    });
  });

  let voiceForTest = voiceSelect.value || DEFAULT_VOICE_ID;
  if (voicesResponse?.ok && voicesResponse.voices?.length) {
    const englishVoice = voicesResponse.voices.find(
      (v) => (v.category || '').toLowerCase().startsWith('en')
    );
    if (englishVoice) voiceForTest = englishVoice.voiceId;
  }

  const ttsResponse = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'tts-request', text: 'Inworld self-test ok.', voice: voiceForTest, speed: 1 },
      (resp) => resolve(resp || { ok: false, error: chrome.runtime.lastError?.message || 'no-response' })
    );
  });

  const lines = [
    `Elapsed: ${Math.round(performance.now() - startedAt)} ms`,
    `Model: ${modelSelect.value}`,
    `Voice tried: ${voiceForTest}`,
    '',
    `Voices fetch: ${voicesResponse?.ok ? 'OK' : 'FAIL'} — ${describeVoiceCount(voicesResponse)}`,
  ];
  if (!voicesResponse?.ok) {
    lines.push(`  error: ${voicesResponse?.error || 'unknown'}`);
    if (voicesResponse?.status) lines.push(`  http: ${voicesResponse.status}`);
    if (voicesResponse?.detail) lines.push(`  detail: ${voicesResponse.detail}`);
  } else if (voicesResponse.voices?.length) {
    lines.push(`  sample: ${voicesResponse.voices.slice(0, 5).map((v) => v.voiceId).join(', ')}`);
  }
  lines.push('');
  lines.push(`TTS synth: ${ttsResponse?.ok ? 'OK' : 'FAIL'}`);
  if (!ttsResponse?.ok) {
    lines.push(`  error: ${ttsResponse?.error || 'unknown'}`);
    if (ttsResponse?.status) lines.push(`  http: ${ttsResponse.status}`);
    if (ttsResponse?.detail) lines.push(`  detail: ${ttsResponse.detail}`);
  } else {
    const head = (ttsResponse.audioDataUrl || '').slice(0, 48);
    lines.push(`  audio prefix: ${head}...`);
    lines.push(`  base64 length: ${(ttsResponse.audioDataUrl?.length || 0)}`);
  }

  showInPreview(lines);
  showStatus(ttsResponse?.ok ? 'Inworld API OK' : 'Inworld API failed');
  testApiBtn.disabled = false;
  testApiBtn.textContent = 'Test Inworld API';
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
speedSelect.addEventListener('change', () => {
  // Snap to nearest 0.05 detent in [0.5, 1.5] so storage stays clean
  // even when the user types a value the spinner wouldn't have stopped at.
  const raw = parseFloat(speedSelect.value);
  const safe = Number.isFinite(raw) ? raw : 1.0;
  const clamped = Math.max(0.5, Math.min(1.5, safe));
  const snapped = Math.round(clamped * 20) / 20;
  speedSelect.value = snapped.toString();
  save('defaultSpeed', snapped.toString());
});
articleToggle.addEventListener('change', () => save('articleMode', articleToggle.checked));
copyDebugLogBtn.addEventListener('click', copyDebugLog);
clearDebugLogBtn.addEventListener('click', clearDebugLog);
testApiBtn.addEventListener('click', runApiSelfTest);
