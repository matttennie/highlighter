const tokenInput = document.getElementById('apiToken');
const modelSelect = document.getElementById('modelId');
const voiceSelect = document.getElementById('defaultVoice');
const speedSelect = document.getElementById('defaultSpeed');
const articleToggle = document.getElementById('articleMode');
const statusEl = document.getElementById('status');
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
let statusTimer = 0;
let tokenSaveTimer = 0;

// Load saved settings
chrome.storage.local.get(
  ['elApiKey', 'modelId', 'defaultVoice', 'defaultSpeed', 'articleMode'],
  (data) => {
    if (data.elApiKey) tokenInput.value = data.elApiKey;
    if (data.modelId) {
      modelSelect.value = data.modelId;
      if (!modelSelect.value) {
        // Stale model — clear storage so default is used
        chrome.storage.local.remove('modelId');
      }
    }
    ensureVoiceOption(data.defaultVoice || DEFAULT_VOICE_ID, 'Configured voice');
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
    voiceSelect.value = selectedVoice || DEFAULT_VOICE_ID;
    if (!voiceSelect.value) ensureVoiceOption(selectedVoice || DEFAULT_VOICE_ID, 'Configured voice');
  });
}

function saveTokenSoon() {
  clearTimeout(tokenSaveTimer);
  tokenSaveTimer = setTimeout(() => {
    save('elApiKey', tokenInput.value.trim());
    tokenSaveTimer = 0;
  }, 250);
}

tokenInput.addEventListener('input', saveTokenSoon);
tokenInput.addEventListener('blur', () => {
  clearTimeout(tokenSaveTimer);
  save('elApiKey', tokenInput.value.trim());
  tokenSaveTimer = 0;
  loadVoices(voiceSelect.value || DEFAULT_VOICE_ID);
});
modelSelect.addEventListener('change', () => save('modelId', modelSelect.value));
voiceSelect.addEventListener('change', () => save('defaultVoice', voiceSelect.value));
speedSelect.addEventListener('change', () => save('defaultSpeed', speedSelect.value));
articleToggle.addEventListener('change', () => save('articleMode', articleToggle.checked));
