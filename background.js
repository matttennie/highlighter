'use strict';

// ── Constants ───────────────────────────────────────────────────────
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
const MAX_TEXT_LENGTH = 5000;
const FETCH_TIMEOUT_MS = 30000;
const BASE64_CHUNK_SIZE = 8192;
const LOG_PREFIX = '[Highlighter TTS]';
const SUPPORTED_MODEL_IDS = new Set([
  'eleven_flash_v2_5',
  'eleven_turbo_v2_5',
  'eleven_multilingual_v2',
]);

function isSelectableVoice(voice) {
  if (!voice || typeof voice !== 'object') return false;
  if (voice.category === 'premade') return true;
  if (voice.is_owner) return true;
  return false;
}

function getStorageSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiKey', 'elApiKey', 'modelId'], resolve);
  });
}

// ── Context menu setup ──────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create(
    {
      id: 'toggle-highlight-mode',
      title: 'Toggle Highlight Mode',
      contexts: ['page', 'selection'],
    },
    () => void chrome.runtime.lastError
  );
});

// ── Tab messaging helpers ───────────────────────────────────────────
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

// ── Context menu click ──────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'toggle-highlight-mode') sendToggle(tab?.id);
});

// ── Keyboard shortcut ───────────────────────────────────────────────
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-highlight-mode') sendToggleToActiveTab();
});

// ── Message router ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'tts-request') {
    handleTtsRequest(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async sendResponse
  }

  if (msg.type === 'voices-request') {
    handleVoicesRequest()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async sendResponse
  }

  return false;
});

// ── Fetch with timeout (FIX 3) ──────────────────────────────────────
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Parse ElevenLabs error responses (FIX 2) ────────────────────────
async function parseErrorDetail(res) {
  let detail = res.statusText;
  try {
    const body = await res.json();
    detail =
      body?.detail?.message ||
      body?.detail?.status ||
      body?.message ||
      JSON.stringify(body);
  } catch {
    try {
      detail = await res.text();
    } catch {
      /* use statusText */
    }
  }
  return detail;
}

// ── TTS request handler ─────────────────────────────────────────────
async function handleTtsRequest({ text, voice, speed }) {
  const data = await getStorageSettings();
  const apiKey = (data.apiKey || data.elApiKey || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'no-token' };
  }
  if (!apiKey.startsWith('sk_')) {
    return {
      ok: false,
      error: 'unsupported-provider',
      detail: 'Use an ElevenLabs API key that starts with sk_.',
    };
  }

  const normalizedText = typeof text === 'string' ? text.trim() : '';
  if (!normalizedText) {
    return { ok: false, error: 'empty-text' };
  }

  // FIX 5: Enforce text length limit
  if (normalizedText.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      error: 'text-too-long',
      detail: `Text is ${normalizedText.length} characters; maximum is ${MAX_TEXT_LENGTH}.`,
    };
  }

  // FIX 4: Validate voiceId — reject empty or whitespace-only values
  const rawVoiceId = typeof voice === 'string' ? voice.trim() : '';
  const voiceId = rawVoiceId || DEFAULT_VOICE_ID;
  if (!voiceId) {
    return { ok: false, error: 'invalid-voice', detail: 'Voice ID is empty.' };
  }

  const modelId = SUPPORTED_MODEL_IDS.has(data.modelId) ? data.modelId : DEFAULT_MODEL_ID;
  const normalizedSpeed = normalizeSpeed(speed);

  console.log(`${LOG_PREFIX} Request:`, {
    voiceId,
    modelId,
    textLength: normalizedText.length,
    speed: normalizedSpeed,
  });

  return requestElevenLabsTts({
    apiKey,
    modelId,
    normalizedSpeed,
    text: normalizedText,
    voiceId,
  });
}

// ── Voices request handler ──────────────────────────────────────────
async function handleVoicesRequest() {
  const data = await getStorageSettings();
  const apiKey = (data.apiKey || data.elApiKey || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'no-token' };
  }
  if (!apiKey.startsWith('sk_')) {
    return {
      ok: false,
      error: 'unsupported-provider',
      detail: 'Use an ElevenLabs API key that starts with sk_.',
    };
  }

  let res;
  try {
    res = await fetchWithTimeout('https://api.elevenlabs.io/v1/voices', {
      method: 'GET',
      headers: {
        'xi-api-key': apiKey,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`${LOG_PREFIX} Voices request timed out after ${FETCH_TIMEOUT_MS}ms`);
      return { ok: false, error: 'timeout', detail: 'Request timed out.' };
    }
    throw err;
  }

  if (!res.ok) {
    // FIX 2: Parse JSON error body for human-readable message
    const detail = await parseErrorDetail(res);
    console.error(`${LOG_PREFIX} Voices API error:`, {
      status: res.status,
      detail,
    });

    if (res.status === 401) return { ok: false, error: 'auth-failed', detail };
    if (res.status === 429) return { ok: false, error: 'rate-limited', detail };
    return { ok: false, error: 'api-error', status: res.status, detail };
  }

  const payload = await res.json();
  const voices = Array.isArray(payload.voices)
    ? payload.voices
        .filter(isSelectableVoice)
        .map((v) => ({
          voiceId: v.voice_id,
          name: v.name || v.voice_id,
          category: v.category || 'Other',
        }))
    : [];

  return { ok: true, voices };
}

async function requestElevenLabsTts({ apiKey, modelId, normalizedSpeed, text, voiceId }) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { speed: normalizedSpeed },
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`${LOG_PREFIX} Request timed out after ${FETCH_TIMEOUT_MS}ms`);
      return { ok: false, error: 'timeout', detail: 'Request timed out.' };
    }
    throw err;
  }

  return audioResponseFromHttp(res, url, 'audio/mpeg');
}

async function requestOpenRouterTts({ apiKey, modelId, text, voiceId }) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'HTTP-Referer': 'https://chrome-extension.local/highlighter',
        'X-OpenRouter-Title': 'Highlighter TTS',
      },
      body: JSON.stringify({
        model: modelId || OPENROUTER_DEFAULT_MODEL,
        messages: [{ role: 'user', content: text }],
        modalities: ['text', 'audio'],
        audio: {
          voice: voiceId || OPENROUTER_DEFAULT_VOICE,
          format: 'pcm16',
        },
        stream: true,
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`${LOG_PREFIX} Request timed out after ${FETCH_TIMEOUT_MS}ms`);
      return { ok: false, error: 'timeout', detail: 'Request timed out.' };
    }
    throw err;
  }

  if (!res.ok) {
    return mapHttpError(res, url);
  }

  const fullAudioBase64 = await readOpenRouterAudioStream(res);
  if (!fullAudioBase64) {
    return {
      ok: false,
      error: 'api-error',
      status: 502,
      detail: 'OpenRouter returned no audio chunks.',
    };
  }

  return {
    ok: true,
    audioDataUrl: pcm16Base64ToWavDataUrl(fullAudioBase64, OPENROUTER_PCM_SAMPLE_RATE),
  };
}

async function mapHttpError(res, url) {
  const detail = await parseErrorDetail(res);
  console.error(`${LOG_PREFIX} API error:`, {
    status: res.status,
    detail,
    url,
  });

  if (res.status === 401) return { ok: false, error: 'auth-failed', detail };
  if (res.status === 402) return { ok: false, error: 'billing-required', detail };
  if (res.status === 429) return { ok: false, error: 'rate-limited', detail };
  return { ok: false, error: 'api-error', status: res.status, detail };
}

async function audioResponseFromHttp(res, url, mimeType) {
  if (!res.ok) {
    return mapHttpError(res, url);
  }

  const buffer = await res.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  return { ok: true, audioDataUrl: `data:${mimeType};base64,${base64}` };
}

// ── Utility: normalize speed to ElevenLabs-supported [0.7, 1.2] ────
function normalizeSpeed(speed) {
  const parsed = parseFloat(speed);
  if (!Number.isFinite(parsed)) return 1.0;
  return Math.max(0.7, Math.min(1.2, parsed));
}

// ── Utility: ArrayBuffer → base64 (chunked) ────────────────────────
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + BASE64_CHUNK_SIZE, bytes.length))
    );
  }
  return btoa(binary);
}
