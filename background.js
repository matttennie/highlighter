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

// Kokoro v1 voice metadata is static. Serving it here keeps both voice
// selectors useful without booting the native server or the ~300MB WASM
// engine merely to enumerate ids. Availability is still validated naturally
// when the user requests synthesis.
const VOICE_GROUPS = [
  ['English (US)', [
    'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore',
    'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky', 'am_adam',
    'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx',
    'am_puck', 'am_santa',
  ]],
  ['English (UK)', [
    'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
    'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
  ]],
  ['Spanish', ['ef_dora', 'em_alex', 'em_santa']],
  ['French', ['ff_siwis']],
  ['Hindi', ['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi']],
  ['Italian', ['if_sara', 'im_nicola']],
  ['Japanese', ['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo']],
  ['Portuguese (BR)', ['pf_dora', 'pm_alex', 'pm_santa']],
  ['Chinese', [
    'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi',
    'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang',
  ]],
];
const VOICE_CATALOG = VOICE_GROUPS.flatMap(([category, voiceIds]) =>
  voiceIds.map((voiceId) => ({ voiceId, name: voiceId, category }))
);

// Native companion server (server/kokoro_server.py) — loopback only, checked
// first on every TTS or waking status request. Opening the toolbar popup sends
// a native-only wake so this process can boot ahead of first playback without
// also loading the much heavier in-extension WASM fallback.
const NATIVE_BASE_URL = 'http://127.0.0.1:8880';
const NATIVE_HEALTH_TIMEOUT_MS = 600;
const NATIVE_TTS_TIMEOUT_MS = 30000;
const NATIVE_RECHECK_MS = 30000;

// Native-messaging lifecycle host (server/native_host.py). Opening this port
// makes Chrome spawn the host, which boots kokoro_server.py; the host reaps
// the server when the port closes (Chrome quit / extension disabled / SW
// death). An active native port also keeps the MV3 service worker alive on
// Chrome 116+ — so the server lives exactly as long as Chrome does, from the
// user's first engagement.
const NATIVE_HOST = 'com.highlighter.kokoro';
const LEASH_PING_MS = 25000;
const LEASH_UNAVAILABLE_BACKOFF_MS = 5 * 60 * 1000;

let requestSeq = 0;
let debugLogBuffer = [];
let isFlushPending = false;
let offscreenCreating = null;
let nativeState = { available: null, checkedAt: 0 };
let nativePort = null;
let leashState = 'closed'; // 'closed' | 'opening' | 'open' | 'unavailable'
let leashPingInterval = null;
let leashUnavailableAt = 0;

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

function persistDebugEvent(source, event, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    source,
    event,
    details,
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

// ── Native companion server ─────────────────────────────────────────
// isNativeAvailable() caches its result for NATIVE_RECHECK_MS so the hot
// tts-request/voices-request paths don't pay a health-check round trip on
// every call. markNativeDown() lets a failed /tts or /voices call force an
// immediate recheck instead of waiting out the cache window.
async function isNativeAvailable() {
  const now = Date.now();
  if (nativeState.available !== null && now - nativeState.checkedAt < NATIVE_RECHECK_MS) {
    return nativeState.available;
  }
  try {
    const res = await fetch(`${NATIVE_BASE_URL}/health`, { signal: AbortSignal.timeout(NATIVE_HEALTH_TIMEOUT_MS) });
    nativeState = { available: res.ok, checkedAt: now };
  } catch {
    nativeState = { available: false, checkedAt: now };
  }
  if (nativeState.available) logDebug('native-server-available', {});
  return nativeState.available;
}

function markNativeDown() {
  nativeState = { available: false, checkedAt: Date.now() };
}

function markNativeUnknown() {
  nativeState = { available: null, checkedAt: 0 };
}

// Open the native-messaging leash on user engagement. Idempotent via
// leashState: a no-op while 'opening' or 'open'. When 'unavailable' (host not
// installed), re-probe at most once per LEASH_UNAVAILABLE_BACKOFF_MS — the
// user may install the host later, but we never hot-loop connectNative. A new
// toolbar-popup engagement may explicitly bypass that backoff once.
function openLeash(retryUnavailable = false) {
  if (leashState === 'open' || leashState === 'opening') return;
  // A live port already leashes us. Never open a second one — that would
  // spawn a duplicate host. Reconnect only after onDisconnect nulls the port.
  if (nativePort) return;
  if (!retryUnavailable && leashState === 'unavailable' &&
      Date.now() - leashUnavailableAt < LEASH_UNAVAILABLE_BACKOFF_MS) return;

  leashState = 'opening';
  logDebug('native-leash-opening', { retryUnavailable });
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (err) {
    // Thrown when the permission is missing or the host name is invalid.
    nativePort = null;
    leashState = 'unavailable';
    leashUnavailableAt = Date.now();
    // A missing lifecycle host does not prove that a manually started/shared
    // HTTP server is absent. Leave one direct health probe available.
    markNativeUnknown();
    logDebug('native-leash-connect-threw', { error: err?.message || String(err) });
    return;
  }

  nativePort.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'server-status') return;
    if (msg.ok) {
      leashState = 'open';
      // Force availability now — the health probe would otherwise race the
      // server boot on a cold start; the host says the server is up, trust it.
      nativeState = { available: true, checkedAt: Date.now() };
      logDebug('native-leash-ready', { owned: Boolean(msg.owned) });
    } else {
      // Host is up but the server failed to boot — treat it as unavailable so
      // the WASM path carries requests. Drop this failed leash so a later,
      // explicit toolbar selection can retry after the user fixes the cause.
      leashState = 'unavailable';
      leashUnavailableAt = Date.now();
      markNativeDown();
      logDebug('native-leash-server-down', {});
      nativePort?.disconnect();
    }
  });

  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || null;
    // If we never reached 'open', the host isn't installed/reachable → back
    // off. If we HAD opened (Chrome killed the host), allow a reopen on the
    // next engagement rather than parking in 'unavailable'.
    const hadOpened = leashState === 'open';
    leashState = hadOpened ? 'closed' : 'unavailable';
    if (!hadOpened) leashUnavailableAt = Date.now();
    nativePort = null;
    if (leashPingInterval !== null) {
      clearInterval(leashPingInterval);
      leashPingInterval = null;
    }
    if (hadOpened) {
      markNativeDown();
    } else {
      // Failure to connect to the lifecycle host says nothing conclusive about
      // an independently running loopback server. The next status/TTS request
      // gets one real health probe instead of inheriting a false negative.
      markNativeUnknown();
    }
    logDebug('native-leash-disconnect', { error, hadOpened });
  });

  // An active native port keeps the MV3 service worker alive on Chrome 116+.
  // The 25s ping both exercises the host's pong path and refreshes that
  // keepalive (well under Chrome's 30s idle SW timeout).
  if (leashPingInterval !== null) clearInterval(leashPingInterval);
  leashPingInterval = setInterval(() => {
    try {
      nativePort?.postMessage({ type: 'ping' });
    } catch {
      // Port died between disconnect and clear — the onDisconnect handler cleans up.
    }
  }, LEASH_PING_MS);
}

// ── Offscreen document management ───────────────────────────────────
// The Kokoro model runs in an offscreen document (service workers can't
// use WASM threads/WebGPU or keep the model warm). Created lazily on the
// first TTS request (or an explicit waking status request) and kept alive to
// hold the model. Voice metadata is served from VOICE_CATALOG above.
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
  // Benign to drop: no offscreen document ⇒ the engine isn't running and nothing
  // is queued, so there's no wasted synthesis for this cancel to prevent.
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
    // Native synths are ~1.5s and untracked here — a superseded native /tts fetch
    // just finishes and its result is discarded, which is cheap enough to accept.
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
    handleEngineStatusRequest({
      wake: msg.wake !== false,
      nativeOnly: msg.nativeOnly === true,
      retryNative: msg.retryNative === true,
    })
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: 'engine-error', detail: err.message }));
    return true;
  }

  // Offscreen documents have no chrome.storage access — only runtime
  // messaging. These two routes let the offscreen engine read/write the
  // stored default voice and the loaded-once flag through the background.
  if (msg.type === 'engine-boot-info-request') {
    chrome.storage.local.get(['defaultVoice', 'kokoroLoadedOnce'], (data) => {
      const error = chrome.runtime.lastError?.message || null;
      if (error) {
        sendResponse({ ok: false });
        return;
      }
      sendResponse({
        ok: true,
        defaultVoice: typeof data.defaultVoice === 'string' ? data.defaultVoice : '',
        loadedOnce: Boolean(data.kokoroLoadedOnce),
      });
    });
    return true;
  }

  if (msg.type === 'engine-loaded-once') {
    chrome.storage.local.set({ kokoroLoadedOnce: true }, () => {
      void chrome.runtime.lastError;
      sendResponse({ ok: true });
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

// ── TTS request handler ─────────────────────────────────────────────
async function handleTtsRequest({ text, voice, speed }, requestId = ++requestSeq, clientRequestId) {
  openLeash();
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

  if (await isNativeAvailable()) {
    try {
      const res = await fetch(`${NATIVE_BASE_URL}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: normalizedText, voice: voiceId, speed: normalizedSpeed }),
        signal: AbortSignal.timeout(NATIVE_TTS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`native-http-${res.status}`);
      const payload = await res.json();
      if (!payload || typeof payload.audioContent !== 'string' || !payload.audioContent) {
        throw new Error('native-bad-payload');
      }
      logDebug('tts-complete', {
        requestId,
        ok: true,
        error: null,
        backend: 'native',
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return { ok: true, audioDataUrl: `data:audio/wav;base64,${payload.audioContent}` };
    } catch (err) {
      markNativeDown();
      logDebug('native-tts-failed', { detail: err.message });
      // Fall through to the offscreen (WASM) path below.
    }
  }

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
  logDebug('voices-catalog-served', { requestId, count: VOICE_CATALOG.length });
  return { ok: true, voices: VOICE_CATALOG };
}

// ── Engine status handler ───────────────────────────────────────────
async function handleEngineStatusRequest({
  wake = true,
  nativeOnly = false,
  retryNative = false,
} = {}) {
  // A non-waking status peek may inspect either backend if it already exists,
  // but it never starts one.
  if (!wake) {
    const nativeReady = nativeState.available === true &&
      (leashState === 'open' || Date.now() - nativeState.checkedAt < NATIVE_RECHECK_MS);
    if (nativeReady) {
      return { ok: true, status: 'ready', backend: 'native', progress: 100, warm: true };
    }
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length === 0) {
      return { ok: true, status: 'idle', backend: 'wasm', progress: 0, warm: false };
    }
    const existing = (await sendToOffscreen({ type: 'engine-status-request' })) ||
      { ok: false, error: 'no-response' };
    if (existing.ok) existing.backend = 'wasm';
    return existing;
  }

  // A fresh toolbar selection may bypass the unavailable backoff exactly once;
  // follow-up polls omit retryNative so a failed host cannot hot-loop.
  openLeash(nativeOnly && retryNative);

  // The toolbar popup deliberately wakes only the native companion. The
  // native host reports readiness asynchronously after it has started (or
  // attached to) kokoro_server.py, so expose that transition for popup
  // polling. Never probe/create the offscreen engine in this branch: WASM
  // remains lazy until an actual Play/Test Voice request needs the fallback.
  if (nativeOnly) {
    const nativeReady = nativeState.available === true &&
      (leashState === 'open' || Date.now() - nativeState.checkedAt < NATIVE_RECHECK_MS);
    if (nativeReady) {
      return { ok: true, status: 'ready', backend: 'native', progress: 100, warm: true };
    }
    if (leashState === 'unavailable') {
      if (await isNativeAvailable()) {
        return { ok: true, status: 'ready', backend: 'native', progress: 100, warm: true };
      }
      return { ok: true, status: 'unavailable', backend: 'native', progress: 0, warm: false };
    }
    return { ok: true, status: 'starting', backend: 'native', progress: 0, warm: false };
  }

  if (await isNativeAvailable()) {
    return { ok: true, status: 'ready', backend: 'native', progress: 100, warm: true };
  }
  await ensureOffscreenDocument();
  const response = (await sendToOffscreen({ type: 'engine-status-request' })) || { ok: false, error: 'no-response' };
  if (response.ok) response.backend = 'wasm';
  return response;
}

// Kokoro's ONNX graph accepts speeds in [0.5, 2.0].
function normalizeSpeed(speed) {
  const parsed = parseFloat(speed);
  if (!Number.isFinite(parsed)) return 1.0;
  return Math.max(0.5, Math.min(2.0, parsed));
}
