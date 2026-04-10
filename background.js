'use strict';

// ── Constants ───────────────────────────────────────────────────────
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
const MAX_TEXT_LENGTH = 5000;
const FETCH_TIMEOUT_MS = 30000;
const BASE64_CHUNK_SIZE = 8192;
const LOG_PREFIX = '[Highlighter TTS]';
const DEBUG_LOG_KEY = 'debugLog';
const DEBUG_LOG_LIMIT = 250;
let requestSeq = 0;
let debugWriteQueue = Promise.resolve();
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
    chrome.storage.local.get(['apiKey', 'elApiKey', 'modelId', 'defaultVoice'], (data) => {
      const error = chrome.runtime.lastError?.message || null;
      if (error) {
        logDebug('settings-load-failed', { error });
        resolve({});
        return;
      }
      resolve(data);
    });
  });
}

function redactDebugDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const copy = { ...details };
  for (const key of Object.keys(copy)) {
    if (/^(apiKey|elApiKey|token|secret|authorization|password)$/i.test(key)) {
      copy[key] = copy[key] ? '[redacted]' : copy[key];
    }
  }
  return copy;
}

function persistDebugEvent(source, event, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    source,
    event,
    details: redactDebugDetails(details),
  };
  debugWriteQueue = debugWriteQueue
    .catch(() => {})
    .then(() => appendDebugEntry(entry));
}

function logDebug(event, details = {}) {
  console.log(`${LOG_PREFIX} ${event}`, details);
  persistDebugEvent('background', event, details);
}

function appendDebugEntry(entry) {
  return new Promise((resolve) => {
    chrome.storage.local.get([DEBUG_LOG_KEY], (data) => {
      const getError = chrome.runtime.lastError?.message || null;
      if (getError) {
        resolve();
        return;
      }
      const current = Array.isArray(data[DEBUG_LOG_KEY]) ? data[DEBUG_LOG_KEY] : [];
      current.push(entry);
      const trimmed = current.slice(-DEBUG_LOG_LIMIT);
      chrome.storage.local.set({ [DEBUG_LOG_KEY]: trimmed }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  });
}

// ── Context menu setup ──────────────────────────────────────────────
function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    const removeError = chrome.runtime.lastError?.message || null;
    if (removeError) logDebug('context-menu-remove-failed', { error: removeError });
    chrome.contextMenus.create(
      {
        id: 'toggle-highlight-mode',
        title: 'Toggle Highlight Mode',
        contexts: ['page', 'selection'],
      },
      () => {
        const message = chrome.runtime.lastError?.message || null;
        logDebug('context-menu-created', { error: message });
      }
    );
  });
}

chrome.runtime.onInstalled.addListener(createContextMenu);
chrome.runtime.onStartup.addListener(createContextMenu);
createContextMenu();

// ── Tab messaging helpers ───────────────────────────────────────────
function canInjectIntoTab(tabId, url = '') {
  if (!Number.isInteger(tabId)) return false;
  if (!url || typeof url !== 'string') return true;
  return url.startsWith('http://') || url.startsWith('https://');
}

function injectContentScript(tabId, callback, url = '') {
  if (!canInjectIntoTab(tabId, url)) {
    logDebug('content-inject-skipped-restricted', { tabId, url });
    callback(false);
    return;
  }

  logDebug('content-inject-start', { tabId });
  chrome.scripting.insertCSS(
    {
      target: { tabId },
      files: ['content/content.css'],
    },
    () => {
      const cssError = chrome.runtime.lastError?.message || null;
      if (cssError) {
        logDebug('content-css-inject-failed', { tabId, error: cssError });
      }

      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: ['content/content.js'],
        },
        () => {
          const scriptError = chrome.runtime.lastError?.message || null;
          logDebug('content-inject-complete', { tabId, error: scriptError });
          callback(!scriptError);
        }
      );
    }
  );
}

function sendToggle(tabId, url = '', retrying = false, done = () => {}) {
  if (!Number.isInteger(tabId)) {
    done({ ok: false, error: 'tab-not-found' });
    return;
  }
  chrome.tabs.sendMessage(tabId, { action: 'toggleHighlightMode' }, () => {
    const error = chrome.runtime.lastError?.message || null;
    logDebug('toggle-message-sent', { tabId, retrying, error });
    if (!error) {
      done({ ok: true, error: null, tabId, retrying });
      return;
    }
    if (retrying) {
      done({ ok: false, error, tabId, retrying });
      return;
    }

    injectContentScript(tabId, (injected) => {
      if (!injected) {
        done({ ok: false, error: 'content-inject-failed', tabId, retrying });
        return;
      }
      sendToggle(tabId, url, true, done);
    }, url);
  });
}

function sendToggleToActiveTab(done = () => {}) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const error = chrome.runtime.lastError?.message || null;
    if (error) {
      logDebug('active-tab-query-failed', { error });
      done({ ok: false, error });
      return;
    }
    const tab = tabs?.[0];
    sendToggle(tab?.id, tab?.url, false, done);
  });
}

globalThis.__highlighterTestHooks = {
  toggleActiveTab() {
    return new Promise((resolve) => sendToggleToActiveTab(resolve));
  },
};

// ── Context menu click ──────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'toggle-highlight-mode') sendToggle(tab?.id, tab?.url);
});

// ── Keyboard shortcut ───────────────────────────────────────────────
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-highlight-mode') sendToggleToActiveTab();
});

// ── Message router ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'debug-event') {
    const entry = msg.entry || {};
    persistDebugEvent(entry.source || 'unknown', entry.event || 'unknown', entry.details || {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'toggle-active-tab') {
    sendToggleToActiveTab(sendResponse);
    return true;
  }

  if (msg.type === 'tts-request') {
    const requestId = ++requestSeq;
    logDebug('message-received', {
      requestId,
      type: msg.type,
      textLength: typeof msg.text === 'string' ? msg.text.length : 0,
      voice: msg.voice || null,
      speed: msg.speed || null,
    });
    handleTtsRequest(msg, requestId)
      .then(sendResponse)
      .catch((err) => {
        console.error(`${LOG_PREFIX} Unhandled TTS error:`, {
          requestId,
          message: err.message,
          stack: err.stack,
        });
        sendResponse({ ok: false, error: err.message });
      });
    return true; // keep channel open for async sendResponse
  }

  if (msg.type === 'voices-request') {
    const requestId = ++requestSeq;
    logDebug('message-received', { requestId, type: msg.type });
    handleVoicesRequest(requestId)
      .then(sendResponse)
      .catch((err) => {
        console.error(`${LOG_PREFIX} Unhandled voices error:`, {
          requestId,
          message: err.message,
          stack: err.stack,
        });
        sendResponse({ ok: false, error: err.message });
      });
    return true; // keep channel open for async sendResponse
  }

  if (msg.type === 'debug-log-request') {
    chrome.storage.local.get([DEBUG_LOG_KEY], (data) => {
      const error = chrome.runtime.lastError?.message || null;
      if (error) {
        sendResponse({ ok: false, error });
        return;
      }
      sendResponse({ ok: true, entries: Array.isArray(data[DEBUG_LOG_KEY]) ? data[DEBUG_LOG_KEY] : [] });
    });
    return true;
  }

  if (msg.type === 'debug-log-clear') {
    chrome.storage.local.set({ [DEBUG_LOG_KEY]: [] }, () => {
      const error = chrome.runtime.lastError?.message || null;
      if (error) {
        sendResponse({ ok: false, error });
        return;
      }
      sendResponse({ ok: true });
    });
    return true;
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
async function handleTtsRequest({ text, voice, speed }, requestId = ++requestSeq) {
  const startedAt = performance.now();
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
  const storedVoiceId = typeof data.defaultVoice === 'string' ? data.defaultVoice.trim() : '';
  const voiceId = rawVoiceId || storedVoiceId || DEFAULT_VOICE_ID;
  if (!voiceId) {
    return { ok: false, error: 'invalid-voice', detail: 'Voice ID is empty.' };
  }

  const modelId = SUPPORTED_MODEL_IDS.has(data.modelId) ? data.modelId : DEFAULT_MODEL_ID;
  const normalizedSpeed = normalizeSpeed(speed);

  logDebug('tts-normalized', {
    requestId,
    voiceId,
    modelId,
    textLength: normalizedText.length,
    speed: normalizedSpeed,
  });

  const result = await requestElevenLabsTts({
    apiKey,
    modelId,
    normalizedSpeed,
    requestId,
    text: normalizedText,
    voiceId,
  });
  logDebug('tts-complete', {
    requestId,
    ok: Boolean(result.ok),
    error: result.error || null,
    status: result.status || null,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  return result;
}

// ── Voices request handler ──────────────────────────────────────────
async function handleVoicesRequest() {
  const requestId = arguments[0] ?? ++requestSeq;
  const startedAt = performance.now();
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
    logDebug('voices-fetch-start', { requestId });
    res = await fetchWithTimeout('https://api.elevenlabs.io/v1/voices', {
      method: 'GET',
      headers: {
        'xi-api-key': apiKey,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`${LOG_PREFIX} Voices request timed out after ${FETCH_TIMEOUT_MS}ms`, { requestId });
      return { ok: false, error: 'timeout', detail: 'Request timed out.' };
    }
    throw err;
  }

  logDebug('voices-fetch-response', {
    requestId,
    status: res.status,
    ok: res.ok,
    elapsedMs: Math.round(performance.now() - startedAt),
  });

  if (!res.ok) {
    // FIX 2: Parse JSON error body for human-readable message
    const detail = await parseErrorDetail(res);
    console.error(`${LOG_PREFIX} Voices API error:`, {
      requestId,
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

async function requestElevenLabsTts({ apiKey, modelId, normalizedSpeed, requestId, text, voiceId }) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
  const startedAt = performance.now();
  let res;
  try {
    logDebug('tts-fetch-start', {
      requestId,
      voiceId,
      modelId,
      textLength: text.length,
      speed: normalizedSpeed,
    });
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
      console.error(`${LOG_PREFIX} Request timed out after ${FETCH_TIMEOUT_MS}ms`, { requestId });
      return { ok: false, error: 'timeout', detail: 'Request timed out.' };
    }
    throw err;
  }

  logDebug('tts-fetch-response', {
    requestId,
    status: res.status,
    ok: res.ok,
    elapsedMs: Math.round(performance.now() - startedAt),
  });

  return audioResponseFromHttp(res, url, 'audio/mpeg', requestId);
}

async function mapHttpError(res, url, requestId) {
  const detail = await parseErrorDetail(res);
  console.error(`${LOG_PREFIX} API error:`, {
    requestId,
    status: res.status,
    detail,
    url,
  });

  if (res.status === 401) return { ok: false, error: 'auth-failed', detail };
  if (res.status === 402) return { ok: false, error: 'billing-required', detail };
  if (res.status === 429) return { ok: false, error: 'rate-limited', detail };
  return { ok: false, error: 'api-error', status: res.status, detail };
}

async function audioResponseFromHttp(res, url, mimeType, requestId) {
  if (!res.ok) {
    return mapHttpError(res, url, requestId);
  }

  const buffer = await res.arrayBuffer();
  logDebug('tts-audio-buffered', {
    requestId,
    byteLength: buffer.byteLength,
  });
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
