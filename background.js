'use strict';

// ── Constants ───────────────────────────────────────────────────────
const DEFAULT_VOICE_ID = 'bf_emma';
// Not an API limit anymore — bounds worst-case on-device synth latency
// for a single request (the content script sends one sentence at a time).
const MAX_TEXT_LENGTH = 2000;
const LOG_PREFIX = '[Highlighter TTS]';
const DEBUG_LOG_KEY = 'debugLog';
const DEBUG_LOG_LIMIT = 250;
const LOG_FLUSH_INTERVAL_MS = 2000;
const OFFSCREEN_URL = 'offscreen/offscreen.html';
const OFFSCREEN_SEND_RETRIES = 5;
const OFFSCREEN_SEND_RETRY_DELAY_MS = 200;

let requestSeq = 0;
let debugLogBuffer = [];
let isFlushPending = false;
let offscreenCreating = null;

function getStoredDefaultVoice() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['defaultVoice'], (data) => {
      const error = chrome.runtime.lastError?.message || null;
      if (error) {
        logDebug('settings-load-failed', { error });
        resolve('');
        return;
      }
      resolve(typeof data.defaultVoice === 'string' ? data.defaultVoice.trim() : '');
    });
  });
}

function redactDebugDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const copy = { ...details };
  for (const key of Object.keys(copy)) {
    if (/^(token|secret|authorization|password)$/i.test(key)) {
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
  // Purge legacy Inworld-era settings (the API key is a live credential).
  chrome.storage.local.remove(['inworld_Highlighter_API_Key', 'modelId'], () => {
    void chrome.runtime.lastError;
  });
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
  // The user is engaging — start warming the voice engine now so the first
  // sentence doesn't wait for model load.
  void ensureOffscreenDocument().catch(() => {});
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

// ── Offscreen document management ───────────────────────────────────
// The Kokoro model runs in an offscreen document (service workers can't
// use WASM threads/WebGPU or keep the model warm). Created lazily on the
// first TTS/voices/status request and kept alive to hold the model.
async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: 'Runs the on-device Kokoro text-to-speech model (WASM/WebGPU), which cannot execute in a service worker.',
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

function sendToOffscreenOnce(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ ...message, target: 'offscreen' }, (response) => {
      const error = chrome.runtime.lastError?.message || null;
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(response);
    });
  });
}

// Deliver a cancel to the offscreen document only if it already exists. A
// cancel for a not-yet-running engine is meaningless (nothing is queued), and
// spinning the document up just to cancel would defeat the purpose. Uses
// getContexts directly — never ensureOffscreenDocument.
async function forwardCancelToOffscreen(scopedIds) {
  if (!scopedIds.length) return;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length === 0) return;
  await sendToOffscreen({ type: 'tts-cancel', clientRequestIds: scopedIds });
}

// The offscreen document's large module bundle keeps evaluating after
// createDocument() resolves; sends in that window fail with "Receiving end
// does not exist". Retry briefly instead of surfacing a startup race.
async function sendToOffscreen(message) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendToOffscreenOnce(message);
    } catch (err) {
      const retriable = /Receiving end does not exist/i.test(err?.message || '');
      if (!retriable || attempt >= OFFSCREEN_SEND_RETRIES) throw err;
      logDebug('offscreen-send-retry', { attempt: attempt + 1, type: message.type });
      await new Promise((resolve) => setTimeout(resolve, OFFSCREEN_SEND_RETRY_DELAY_MS));
    }
  }
}

// ── Message router ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Offscreen-addressed messages are handled by the offscreen document's
  // own listener; both contexts share chrome.runtime.onMessage.
  if (msg && msg.target === 'offscreen') return false;

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
    // Scope the caller's per-tab clientRequestId so ids from different tabs can't
    // collide in the offscreen synth queue's cancellation set.
    const clientRequestId = msg.clientRequestId ? `${sender.tab?.id ?? 'x'}:${msg.clientRequestId}` : undefined;
    logDebug('message-received', {
      requestId,
      type: msg.type,
      textLength: typeof msg.text === 'string' ? msg.text.length : 0,
      voice: msg.voice || null,
      speed: msg.speed || null,
    });
    handleTtsRequest(msg, requestId, clientRequestId)
      .then(sendResponse)
      .catch((err) => {
        console.error(`${LOG_PREFIX} Unhandled TTS error:`, {
          requestId,
          message: err.message,
          stack: err.stack,
        });
        sendResponse({ ok: false, error: 'engine-error', detail: err.message });
      });
    return true; // keep channel open for async sendResponse
  }

  if (msg.type === 'tts-cancel') {
    const rawIds = Array.isArray(msg.clientRequestIds) ? msg.clientRequestIds : [];
    const scopedIds = rawIds.map((id) => `${sender.tab?.id ?? 'x'}:${id}`);
    // Fire-and-forget. Never create the offscreen document just to cancel — if
    // it isn't running there is nothing queued to skip.
    forwardCancelToOffscreen(scopedIds).catch(() => {});
    sendResponse({ ok: true });
    return false;
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
        sendResponse({ ok: false, error: 'engine-error', detail: err.message });
      });
    return true;
  }

  if (msg.type === 'engine-status-request') {
    handleEngineStatusRequest()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: 'engine-error', detail: err.message }));
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

// ── TTS request handler ─────────────────────────────────────────────
async function handleTtsRequest({ text, voice, speed }, requestId = ++requestSeq, clientRequestId) {
  const startedAt = performance.now();

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

  const callerVoice = typeof voice === 'string' ? voice.trim() : '';
  const voiceId = callerVoice || (await getStoredDefaultVoice()) || DEFAULT_VOICE_ID;
  const normalizedSpeed = normalizeSpeed(speed);

  logDebug('tts-normalized', {
    requestId,
    voiceId,
    textLength: normalizedText.length,
    speed: normalizedSpeed,
  });

  await ensureOffscreenDocument();
  const response = (await sendToOffscreen({
    type: 'tts-request',
    text: normalizedText,
    voice: voiceId,
    speed: normalizedSpeed,
    clientRequestId,
  })) || { ok: false, error: 'no-response' };

  logDebug('tts-complete', {
    requestId,
    ok: Boolean(response.ok),
    error: response.error || null,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  return response;
}

// ── Voices request handler ──────────────────────────────────────────
async function handleVoicesRequest(requestId = ++requestSeq) {
  logDebug('voices-request-forwarded', { requestId });
  await ensureOffscreenDocument();
  const response = (await sendToOffscreen({ type: 'voices-request' })) || { ok: false, error: 'no-response' };
  logDebug('voices-parsed', { requestId, ok: Boolean(response.ok), count: response.voices?.length || 0 });
  return response;
}

// ── Engine status handler ───────────────────────────────────────────
async function handleEngineStatusRequest() {
  await ensureOffscreenDocument();
  return (await sendToOffscreen({ type: 'engine-status-request' })) || { ok: false, error: 'no-response' };
}

// Kokoro's ONNX graph accepts speeds in [0.5, 2.0].
function normalizeSpeed(speed) {
  const parsed = parseFloat(speed);
  if (!Number.isFinite(parsed)) return 1.0;
  return Math.max(0.5, Math.min(2.0, parsed));
}
