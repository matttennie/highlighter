'use strict';

// ── Constants ───────────────────────────────────────────────────────
const DEFAULT_VOICE_ID = 'Ashley';
const DEFAULT_MODEL_ID = 'inworld-tts-1.5-max';
// Inworld /tts/v1/voice rejects payloads above 2,000 characters per request.
const MAX_TEXT_LENGTH = 2000;
const FETCH_TIMEOUT_MS = 30000;
const LOG_PREFIX = '[Highlighter TTS]';
const DEBUG_LOG_KEY = 'debugLog';
const DEBUG_LOG_LIMIT = 250;
const LOG_FLUSH_INTERVAL_MS = 2000;
const INWORLD_KEY_NAME = 'inworld_Highlighter_API_Key';
const INWORLD_VOICES_URL = 'https://api.inworld.ai/tts/v1/voices';
const INWORLD_TTS_URL = 'https://api.inworld.ai/tts/v1/voice';

let requestSeq = 0;
let debugLogBuffer = [];
let isFlushPending = false;

const SUPPORTED_MODEL_IDS = new Set([
  'inworld-tts-1.5-max',
  'inworld-tts-1.5-mini',
]);

function isSelectableVoice(voice) {
  // Any voice entry with an identifier is selectable.
  return !!(voice && (voice.voiceId || voice.voice_id || voice.name || voice.displayName));
}

function getStorageSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([INWORLD_KEY_NAME, 'modelId', 'defaultVoice'], (data) => {
      const error = chrome.runtime.lastError?.message || null;
      if (error) {
        logDebug('settings-load-failed', { error });
        resolve({});
        return;
      }
      resolve({
        apiKey: data[INWORLD_KEY_NAME] || '',
        modelId: data.modelId,
        defaultVoice: data.defaultVoice,
      });
    });
  });
}

function redactDebugDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const copy = { ...details };
  for (const key of Object.keys(copy)) {
    if (/^(apiKey|inworld_Highlighter_API_Key|token|secret|authorization|password)$/i.test(key)) {
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
  debugLogBuffer.push(entry);
  scheduleLogFlush();
}

function scheduleLogFlush() {
  if (isFlushPending || debugLogBuffer.length === 0) return;
  isFlushPending = true;
  setTimeout(flushLogsToStorage, LOG_FLUSH_INTERVAL_MS);
}

function flushLogsToStorage() {
  if (debugLogBuffer.length === 0) {
    isFlushPending = false;
    return;
  }

  const toPersist = [...debugLogBuffer];
  debugLogBuffer = [];

  chrome.storage.local.get([DEBUG_LOG_KEY], (data) => {
    void chrome.runtime.lastError;
    const current = Array.isArray(data[DEBUG_LOG_KEY]) ? data[DEBUG_LOG_KEY] : [];
    const updated = [...current, ...toPersist].slice(-DEBUG_LOG_LIMIT);
    chrome.storage.local.set({ [DEBUG_LOG_KEY]: updated }, () => {
      void chrome.runtime.lastError;
      isFlushPending = false;
      if (debugLogBuffer.length > 0) scheduleLogFlush();
    });
  });
}

function logDebug(event, details = {}) {
  // JSON round-trip ensures objects serialize cleanly instead of logging as "[object Object]".
  const safeDetails = (details && typeof details === 'object') ? JSON.parse(JSON.stringify(details)) : details;
  console.log(`${LOG_PREFIX} ${event}`, safeDetails);
  persistDebugEvent('background', event, safeDetails);
}

// ── Context menu setup ──────────────────────────────────────────────
function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      {
        id: 'toggle-highlight-mode',
        title: 'Toggle Highlight Mode',
        contexts: ['page', 'selection'],
      },
      () => {
        const error = chrome.runtime.lastError?.message || null;
        logDebug('context-menu-created', { error });
      }
    );
  });
}

chrome.runtime.onInstalled.addListener(() => {
  logDebug('extension-installed');
  createContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  logDebug('extension-startup');
  createContextMenu();
});

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
    return true;
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

// ── Fetch with timeout ──────────────────────────────────────────────
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

// ── Parse upstream error responses ──────────────────────────────────
// Inworld errors usually arrive as JSON, e.g.
//   { "error": { "code": 16, "message": "Authentication required.", "status": "UNAUTHENTICATED" } }
// or, for Google-style envelopes,
//   { "code": 401, "message": "...", "status": "UNAUTHENTICATED" }
async function parseErrorDetail(res) {
  let detail = res.statusText;
  try {
    const body = await res.json();
    if (body && typeof body === 'object') {
      const err = body.error;
      if (err && typeof err === 'object') {
        detail = [err.message, err.status, err.code]
          .filter((piece) => piece !== undefined && piece !== null && piece !== '')
          .join(' — ');
      } else if (typeof err === 'string') {
        detail = err;
      } else if (body.message) {
        detail = [body.message, body.status, body.code]
          .filter((piece) => piece !== undefined && piece !== null && piece !== '')
          .join(' — ');
      } else {
        detail = JSON.stringify(body);
      }
    }
  } catch {
    try {
      const text = await res.text();
      if (text) detail = text;
    } catch {
      /* fall through to statusText */
    }
  }
  return detail || res.statusText;
}

// ── TTS request handler ─────────────────────────────────────────────
async function handleTtsRequest({ text, voice, speed }, requestId = ++requestSeq) {
  const startedAt = performance.now();
  const data = await getStorageSettings();
  const apiKey = (data.apiKey || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'no-token' };
  }

  const normalizedText = typeof text === 'string' ? text.trim() : '';
  if (!normalizedText) {
    return { ok: false, error: 'empty-text' };
  }

  if (normalizedText.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      error: 'text-too-long',
      detail: `Text is ${normalizedText.length} characters; maximum is ${MAX_TEXT_LENGTH}.`,
    };
  }

  const rawVoiceId = typeof voice === 'string' ? voice.trim() : '';
  const storedVoiceId = typeof data.defaultVoice === 'string' ? data.defaultVoice.trim() : '';
  // Reject legacy 20-char hash-shaped voice IDs that may still be in storage from the
  // pre-Inworld build. Inworld voice IDs are short human names like "Sarah".
  const safeCaller = rawVoiceId.length > 15 ? '' : rawVoiceId;
  const safeStored = storedVoiceId.length > 15 ? '' : storedVoiceId;
  if (rawVoiceId && !safeCaller) {
    logDebug('legacy-voice-id-dropped', { from: rawVoiceId, to: DEFAULT_VOICE_ID });
  }
  if (storedVoiceId && !safeStored) {
    logDebug('legacy-voice-id-cleared', { from: storedVoiceId, to: DEFAULT_VOICE_ID });
    chrome.storage.local.set({ defaultVoice: DEFAULT_VOICE_ID });
  }
  const voiceId = safeCaller || safeStored || DEFAULT_VOICE_ID;

  const modelId = SUPPORTED_MODEL_IDS.has(data.modelId) ? data.modelId : DEFAULT_MODEL_ID;
  const normalizedSpeed = normalizeSpeed(speed);

  logDebug('tts-normalized', {
    requestId,
    voiceId,
    modelId,
    textLength: normalizedText.length,
    speed: normalizedSpeed,
  });

  const result = await requestInworldTts({
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
  const apiKey = (data.apiKey || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'no-token' };
  }

  let res;
  try {
    logDebug('voices-fetch-start', { requestId });
    res = await fetchWithTimeout(INWORLD_VOICES_URL, {
      method: 'GET',
      headers: {
        // Inworld portal keys are pre-encoded base64 credentials, used with HTTP Basic.
        'Authorization': `Basic ${apiKey}`,
        'Accept': 'application/json',
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
  // Inworld /tts/v1/voices returns: { voices: [{ voiceId, displayName, languages: [...], description, tags, isCustom }] }
  const voices = Array.isArray(payload.voices)
    ? payload.voices.filter(isSelectableVoice).map((v) => {
        const voiceId = v.voiceId || v.voice_id || v.name || v.displayName;
        const name = v.displayName || v.name || voiceId || 'Unknown Voice';
        const language = Array.isArray(v.languages) && v.languages.length
          ? v.languages[0]
          : (v.language || 'other');
        return {
          voiceId,
          name,
          category: language,
          description: v.description || '',
          tags: Array.isArray(v.tags) ? v.tags : [],
        };
      })
    : [];

  logDebug('voices-parsed', { requestId, count: voices.length, sample: voices.slice(0, 3).map((v) => v.voiceId) });
  return { ok: true, voices };
}

async function requestInworldTts({ apiKey, modelId, normalizedSpeed, requestId, text, voiceId }) {
  const url = INWORLD_TTS_URL;
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

    // Inworld /tts/v1/voice expects JSON in *and* JSON out (with audioContent base64-encoded).
    // audioConfig.speakingRate handles pacing server-side, which sounds far better than
    // bumping HTML5 Audio.playbackRate after the fact.
    const body = {
      text,
      voiceId,
      modelId,
      audioConfig: {
        audioEncoding: 'MP3',
        sampleRateHertz: 48000,
        speakingRate: normalizedSpeed,
      },
    };

    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
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
    contentType: res.headers.get('content-type') || null,
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

  // Inworld returns JSON: { audioContent: "<base64>", usage: {...}, timestampInfo: {...} }.
  // We pass the base64 straight through as a data URL; the content script can blob-ify it.
  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    logDebug('tts-json-parse-failed', { requestId, message: err?.message || String(err) });
    return { ok: false, error: 'bad-response', detail: 'Inworld response was not valid JSON.' };
  }

  const audioContent = typeof payload?.audioContent === 'string' ? payload.audioContent.trim() : '';
  if (!audioContent) {
    logDebug('tts-empty-audio-content', { requestId, payloadKeys: payload ? Object.keys(payload) : null });
    return { ok: false, error: 'bad-response', detail: 'Response missing audioContent.' };
  }

  logDebug('tts-audio-buffered', {
    requestId,
    base64Length: audioContent.length,
    usage: payload.usage || null,
  });
  return { ok: true, audioDataUrl: `data:${mimeType};base64,${audioContent}` };
}

// Inworld /tts/v1/voice rejects audioConfig.speakingRate outside 0.5..1.5.
function normalizeSpeed(speed) {
  const parsed = parseFloat(speed);
  if (!Number.isFinite(parsed)) return 1.0;
  return Math.max(0.5, Math.min(1.5, parsed));
}

