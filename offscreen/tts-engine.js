// Offscreen TTS engine: runs Kokoro-82M locally via kokoro-js.
// Lives in an offscreen document because the MV3 service worker can't
// run WebGPU/WASM inference or keep a ~90 MB model warm in memory.
// Bundled by scripts/build.mjs into tts-engine.bundle.js.
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE_ID = 'bf_emma';
const LOG_PREFIX = '[Highlighter Offscreen]';
const BASE64_CHUNK_SIZE = 8192;
const WARMUP_TEXT = 'Warming up.';
const IDLE_COOLDOWN_MS = 15 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

// ONNX Runtime must load its WASM from inside the extension package —
// MV3 forbids remote code. Model *weights* are data and may be fetched.
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('offscreen/ort/');
// COOP/COEP in the manifest makes extension pages crossOriginIsolated,
// unlocking SharedArrayBuffer so ONNX Runtime can use multiple threads.
// ORT's default caps at min(4, cores/2). Uncap on isolated origins;
// without isolation there is no SharedArrayBuffer, so force 1 thread
// rather than letting ORT crash probing for it.
const wasmThreads = globalThis.crossOriginIsolated
  ? Math.max(1, (navigator.hardwareConcurrency || 4) - 1)
  : 1;
env.backends.onnx.wasm.numThreads = wasmThreads;
console.log(`${LOG_PREFIX} crossOriginIsolated=${globalThis.crossOriginIsolated} wasmThreads=${wasmThreads}`);
env.allowLocalModels = false;

let tts = null;
let initPromise = null;
// Serializes synthesis: concurrent ONNX runs on one session degrade both.
let synthQueue = Promise.resolve();
let engineStatus = { status: 'idle', progress: 0, device: null, error: null };
let lastActivityAt = Date.now();
let activeSynths = 0;
// Wave B: ids the content script asked us to skip. A queued synth job checks
// this set before generating and bails cheaply. Bounded so a long session can't
// grow it without limit — an id that never matched is harmless once cleared.
const cancelledIds = new Set();

// Human labels for Kokoro's language codes (voice ids are prefixed, e.g.
// af_* = American female, bm_* = British male).
const LANGUAGE_LABELS = {
  'en-us': 'English (US)',
  'en-gb': 'English (UK)',
  'es': 'Spanish',
  'fr-fr': 'French',
  'hi': 'Hindi',
  'it': 'Italian',
  'ja': 'Japanese',
  'pt-br': 'Portuguese (BR)',
  'zh': 'Chinese',
};

function pickBackend() {
  // CPU/WASM only. WebGPU (both fp16 and fp32) produced audible artifacts
  // on macOS Metal with this model — revisit when upstream kokoro-js/
  // transformers.js WebGPU output is clean.
  return { device: 'wasm', dtype: 'q8' };
}

function loadModel({ device, dtype }) {
  return KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device,
    progress_callback: (p) => {
      if (p.status === 'progress' && typeof p.progress === 'number' && p.file && p.file.endsWith('.onnx')) {
        engineStatus.progress = Math.round(p.progress);
      }
    },
  });
}

// Offscreen documents have chrome.storage access. Read the user's stored voice
// so the warmup pays that voice's style-vector fetch, not the default voice's.
function getStoredVoice() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['defaultVoice'], (data) => {
        void chrome.runtime.lastError;
        resolve(typeof data?.defaultVoice === 'string' ? data.defaultVoice.trim() : '');
      });
    } catch (e) {
      resolve('');
    }
  });
}

// True once the weights have loaded at least once — subsequent cold starts read
// them from disk cache ("waking up"), not the network ("downloading").
function getKokoroLoadedOnce() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['kokoroLoadedOnce'], (data) => {
        void chrome.runtime.lastError;
        resolve(data?.kokoroLoadedOnce === true);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function ensureEngine() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const attempt = pickBackend();
    // Warm means the weights are already on disk from a prior load, so this
    // "download" is really a cache-backed wake-up.
    const warm = await getKokoroLoadedOnce();
    engineStatus = { status: 'downloading', progress: 0, device: attempt.device, error: null, warm };
    tts = await loadModel(attempt);
    // Pay the one-time graph-compilation cost now, not during the first real
    // sentence (same warmup trick as the local kokoro server). Warm with the
    // user's stored voice — validated now that tts is loaded — so its style
    // vector is fetched here rather than on their first real sentence.
    const storedVoice = await getStoredVoice();
    const warmVoice = resolveVoice(storedVoice || DEFAULT_VOICE_ID);
    await tts.generate(WARMUP_TEXT, { voice: warmVoice, speed: 1.2 });
    engineStatus = { status: 'ready', progress: 100, device: engineStatus.device, error: null, warm };
    // Remember weights are now on disk so the next cold start reads as a
    // wake-up instead of a download.
    chrome.storage.local.set({ kokoroLoadedOnce: true }, () => { void chrome.runtime.lastError; });
    console.log(`${LOG_PREFIX} model ready`, { device: engineStatus.device, warm });
    return tts;
  })().catch((err) => {
    engineStatus = { status: 'error', progress: 0, device: null, error: err?.message || String(err) };
    initPromise = null; // allow a retry on the next request
    throw err;
  });
  return initPromise;
}

function resolveVoice(requested) {
  if (tts && requested && Object.prototype.hasOwnProperty.call(tts.voices, requested)) {
    return requested;
  }
  return DEFAULT_VOICE_ID;
}

// Kokoro's ONNX graph accepts speeds in [0.5, 2.0].
function clampSpeed(speed) {
  const parsed = parseFloat(speed);
  if (!Number.isFinite(parsed)) return 1.0;
  return Math.max(0.5, Math.min(2.0, parsed));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

// Shared "engine not ready" response; also kicks off loading so the first
// request after install starts the model download.
function notReadyResponse() {
  void ensureEngine().catch(() => {});
  if (engineStatus.status === 'error') {
    return { ok: false, error: 'engine-error', detail: engineStatus.error };
  }
  return { ok: false, error: 'model-loading', progress: engineStatus.progress };
}

async function handleTts(msg) {
  lastActivityAt = Date.now();
  if (engineStatus.status !== 'ready') return notReadyResponse();

  const id = msg.clientRequestId;
  const voice = resolveVoice(typeof msg.voice === 'string' ? msg.voice.trim() : '');
  const speed = clampSpeed(msg.speed);
  const run = synthQueue.then(async () => {
    // Wave B: if the caller cancelled this request while it waited in the queue,
    // skip it before starting synthesis — the real win is never spending 3-7s
    // on a superseded sentence. (Mid-inference abort is impossible with the
    // synchronous WASM backend; skipping unstarted jobs is what we can do.)
    if (id && cancelledIds.has(id)) {
      cancelledIds.delete(id);
      return { ok: false, error: 'cancelled' };
    }
    activeSynths += 1;
    try {
      const audio = await tts.generate(msg.text, { voice, speed });
      const wav = audio.toWav(); // 24 kHz mono PCM WAV as ArrayBuffer
      lastActivityAt = Date.now();
      return { ok: true, audioDataUrl: `data:audio/wav;base64,${arrayBufferToBase64(wav)}` };
    } finally {
      activeSynths -= 1;
    }
  });
  synthQueue = run.then(() => {}, () => {}); // keep the queue alive after failures
  return run;
}

function handleVoices() {
  lastActivityAt = Date.now();
  if (engineStatus.status !== 'ready') return notReadyResponse();

  const voices = Object.entries(tts.voices).map(([voiceId, v]) => ({
    voiceId,
    name: v.gender ? `${v.name} (${v.gender})` : v.name,
    category: LANGUAGE_LABELS[v.language] || v.language || 'Other',
  }));
  return { ok: true, voices };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.type === 'tts-request') {
    handleTts(msg)
      .then(sendResponse)
      .catch((err) => {
        console.error(`${LOG_PREFIX} synthesis failed:`, err);
        sendResponse({ ok: false, error: 'synthesis-failed', detail: err?.message || String(err) });
      });
    return true; // async sendResponse
  }

  if (msg.type === 'tts-cancel') {
    const ids = Array.isArray(msg.clientRequestIds) ? msg.clientRequestIds : [];
    for (const id of ids) cancelledIds.add(id);
    // Bounded: a hard reset is fine because an id that never matched a queued
    // job is harmless — worst case a not-yet-received cancel is forgotten.
    if (cancelledIds.size > 500) cancelledIds.clear();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'voices-request') {
    try {
      sendResponse(handleVoices());
    } catch (err) {
      sendResponse({ ok: false, error: 'synthesis-failed', detail: err?.message || String(err) });
    }
    return false;
  }

  if (msg.type === 'engine-status-request') {
    sendResponse({
      ok: true,
      ...engineStatus,
      isolated: globalThis.crossOriginIsolated === true,
      threads: wasmThreads,
    });
    return false;
  }

  return false;
});

// Warm the model as soon as the document exists — the background only
// creates this document when TTS is about to be used.
void ensureEngine().catch(() => {});

// Release the model after sustained idle. An idle resident model costs RAM,
// not CPU — the cooldown exists to return memory, and the background
// recreates this document (and re-warms) on the next request.
setInterval(() => {
  if (engineStatus.status !== 'ready') return;
  if (activeSynths > 0) return;
  if (Date.now() - lastActivityAt < IDLE_COOLDOWN_MS) return;
  console.log(`${LOG_PREFIX} idle cooldown — closing offscreen document`);
  window.close();
}, IDLE_CHECK_INTERVAL_MS);
