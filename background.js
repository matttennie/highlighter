'use strict';

// ── Constants ───────────────────────────────────────────────────────
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5';
const MAX_TEXT_LENGTH = 5000;
const FETCH_TIMEOUT_MS = 30000;
const BASE64_CHUNK_SIZE = 8192;
const LOG_PREFIX = '[Highlighter TTS]';

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
  const data = await new Promise((r) =>
    chrome.storage.local.get(['elApiKey', 'modelId'], r)
  );

  const apiKey = (data.elApiKey || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'no-token' };
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

  const modelId = data.modelId || DEFAULT_MODEL_ID;
  const normalizedSpeed = normalizeSpeed(speed);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;

  console.log(`${LOG_PREFIX} Request:`, {
    url,
    voiceId,
    modelId,
    textLength: normalizedText.length,
    speed: normalizedSpeed,
  });

  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      // FIX 1: Include speed in voice_settings
      body: JSON.stringify({
        text: normalizedText,
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

  if (!res.ok) {
    // FIX 2: Parse JSON error body for human-readable message
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

  const buffer = await res.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);

  return { ok: true, audioDataUrl: `data:audio/mpeg;base64,${base64}` };
}

// ── Voices request handler ──────────────────────────────────────────
async function handleVoicesRequest() {
  const data = await new Promise((r) =>
    chrome.storage.local.get(['elApiKey'], r)
  );

  const apiKey = (data.elApiKey || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'no-token' };
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
    ? payload.voices.map((v) => ({
        voiceId: v.voice_id,
        name: v.name || v.voice_id,
        category: v.category || 'Other',
      }))
    : [];

  return { ok: true, voices };
}

// ── Utility: normalize speed to [0.5, 2.0] ─────────────────────────
function normalizeSpeed(speed) {
  const parsed = parseFloat(speed);
  if (!Number.isFinite(parsed)) return 1.0;
  return Math.max(0.5, Math.min(2.0, parsed));
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
