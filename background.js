// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'toggle-highlight-mode',
    title: 'Toggle Highlight Mode',
    contexts: ['page', 'selection']
  }, () => void chrome.runtime.lastError);
});

function sendToggle(tabId) {
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.sendMessage(tabId, { action: 'toggleHighlightMode' }, () => {
    // Suppress "receiving end does not exist" on pages without the content script
    void chrome.runtime.lastError;
  });
}

function sendToggleToActiveTab() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    sendToggle(tabs?.[0]?.id);
  });
}

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'toggle-highlight-mode') sendToggle(tab?.id);
});

// Handle keyboard shortcut (Chrome passes only the command string here)
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-highlight-mode') sendToggleToActiveTab();
});

// ── TTS request handler ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'tts-request') {
    handleTtsRequest(msg)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async sendResponse
  }

  if (msg.type === 'voices-request') {
    handleVoicesRequest()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async sendResponse
  }

  return false;
});

async function handleTtsRequest({ text, voice, speed }) {
  const data = await new Promise(r =>
    chrome.storage.local.get(['elApiKey', 'modelId'], r)
  );

  const normalizedText = typeof text === 'string' ? text.trim() : '';
  const apiKey = (data.elApiKey || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'no-token' };
  }
  if (!normalizedText) {
    return { ok: false, error: 'empty-text' };
  }

  const voiceId = voice || '21m00Tcm4TlvDq8ikWAM';
  const modelId = data.modelId || 'eleven_turbo_v2_5';
  const normalizedSpeed = normalizeSpeed(speed);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;

  console.log('[Highlighter TTS] Request:', {
    url, voiceId, modelId, textLength: normalizedText.length, speed: normalizedSpeed,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text: normalizedText,
      model_id: modelId,
    }),
  });

  if (!res.ok) {
    let detail = res.statusText;
    try { detail = await res.text(); } catch { /* use statusText */ }
    console.error('[Highlighter TTS] API error:', {
      status: res.status, detail, url,
    });
    if (res.status === 401) return { ok: false, error: 'auth-failed', detail };
    if (res.status === 402) return { ok: false, error: 'billing-required', detail };
    if (res.status === 429) return { ok: false, error: 'rate-limited', detail };
    return { ok: false, error: 'api-error', status: res.status, detail };
  }

  const buffer = await res.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);

  return { ok: true, audioDataUrl: `data:audio/mpeg;base64,${base64}` };
}

function normalizeSpeed(speed) {
  const parsed = parseFloat(speed);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0.5, Math.min(2, parsed));
}

async function handleVoicesRequest() {
  const data = await new Promise(r =>
    chrome.storage.local.get(['elApiKey'], r)
  );

  const apiKey = (data.elApiKey || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'no-token' };
  }

  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    method: 'GET',
    headers: {
      'xi-api-key': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    let detail = res.statusText;
    try { detail = await res.text(); } catch { /* use statusText */ }
    console.error('[Highlighter TTS] Voices API error:', {
      status: res.status, detail,
    });
    if (res.status === 401) return { ok: false, error: 'voices-auth-failed', detail };
    return { ok: false, error: 'voices-api-error', status: res.status, detail };
  }

  const payload = await res.json();
  const voices = Array.isArray(payload.voices)
    ? payload.voices.map((voice) => ({
        voiceId: voice.voice_id,
        name: voice.name || voice.voice_id,
        category: voice.category || 'Other',
      }))
    : [];

  return { ok: true, voices };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}
