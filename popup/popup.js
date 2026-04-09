const tokenInput = document.getElementById('apiToken');
const modelSelect = document.getElementById('modelId');
const voiceSelect = document.getElementById('defaultVoice');
const speedSelect = document.getElementById('defaultSpeed');
const articleToggle = document.getElementById('articleMode');
const providerHint = document.getElementById('providerHint');
const modelHint = document.getElementById('modelHint');
const voiceHint = document.getElementById('voiceHint');
const statusEl = document.getElementById('status');
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
const MODEL_OPTIONS = [
  { value: 'eleven_flash_v2_5', label: 'Flash v2.5 (recommended)' },
  { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5' },
  { value: 'eleven_multilingual_v2', label: 'Multilingual v2' },
];
let statusTimer = 0;
let tokenSaveTimer = 0;

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
    chrome.storage.local.set({ modelId: effectiveModelId });
  }
  ensureVoiceOption(savedVoiceId || DEFAULT_VOICE_ID, 'Configured voice');
}

// Load saved settings
chrome.storage.local.get(
  ['apiKey', 'elApiKey', 'modelId', 'defaultVoice', 'defaultSpeed', 'articleMode'],
  (data) => {
    const savedApiKey = data.apiKey || data.elApiKey || '';
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
  chrome.storage.local.set({ [key]: value }, () => showStatus('Saved'));
}

function saveApiKey(value) {
  chrome.storage.local.set({ apiKey: value, elApiKey: value }, () => showStatus('Saved'));
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
  chrome.storage.local.set({ defaultVoice: voiceId }, () => showStatus('Saved'));
}

function loadVoices(selectedVoice) {
  chrome.runtime.sendMessage({ type: 'voices-request' }, (response) => {
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
