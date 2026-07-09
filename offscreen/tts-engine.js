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

// ONNX Runtime must load its WASM from inside the extension package —
// MV3 forbids remote code. Model *weights* are data and may be fetched.
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('offscreen/ort/');
env.allowLocalModels = false;

let tts = null;
let initPromise = null;
// Serializes synthesis: concurrent ONNX runs on one session degrade both.
let synthQueue = Promise.resolve();
let engineStatus = { status: 'idle', progress: 0, device: null, error: null };

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

async function pickBackend() {
  // navigator.gpu existing does not mean the adapter works — probe it so
  // broken-GPU machines skip straight to WASM instead of downloading the
  // large WebGPU model first. fp32 is the recommended WebGPU pairing — fp16
  // produces audible precision artifacts with this model.
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return { device: 'webgpu', dtype: 'fp32' };
    } catch {
      // fall through to WASM
    }
  }
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

function ensureEngine() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const attempt = await pickBackend();
    engineStatus = { status: 'downloading', progress: 0, device: attempt.device, error: null };
    try {
      tts = await loadModel(attempt);
    } catch (err) {
      if (attempt.device !== 'webgpu') throw err;
      // WebGPU init can fail on adapter/driver issues — retry on CPU.
      console.warn(`${LOG_PREFIX} WebGPU load failed, retrying on WASM:`, err?.message || err);
      engineStatus = { status: 'downloading', progress: 0, device: 'wasm', error: null };
      tts = await loadModel({ device: 'wasm', dtype: 'q8' });
    }
    engineStatus = { status: 'ready', progress: 100, device: engineStatus.device, error: null };
    console.log(`${LOG_PREFIX} model ready`, { device: engineStatus.device });
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
  if (engineStatus.status !== 'ready') return notReadyResponse();

  const voice = resolveVoice(typeof msg.voice === 'string' ? msg.voice.trim() : '');
  const speed = clampSpeed(msg.speed);
  const run = synthQueue.then(async () => {
    const audio = await tts.generate(msg.text, { voice, speed });
    const wav = audio.toWav(); // 24 kHz mono PCM WAV as ArrayBuffer
    return { ok: true, audioDataUrl: `data:audio/wav;base64,${arrayBufferToBase64(wav)}` };
  });
  synthQueue = run.then(() => {}, () => {}); // keep the queue alive after failures
  return run;
}

function handleVoices() {
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

  if (msg.type === 'voices-request') {
    try {
      sendResponse(handleVoices());
    } catch (err) {
      sendResponse({ ok: false, error: 'synthesis-failed', detail: err?.message || String(err) });
    }
    return false;
  }

  if (msg.type === 'engine-status-request') {
    sendResponse({ ok: true, ...engineStatus });
    return false;
  }

  return false;
});

// Warm the model as soon as the document exists — the background only
// creates this document when TTS is about to be used.
void ensureEngine().catch(() => {});
