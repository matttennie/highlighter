# Kokoro-js In-Extension TTS — Design

**Date:** 2026-07-09
**Status:** Approved pending user review
**Goal:** Replace the Inworld TTS API with Kokoro running fully inside the
extension, so the product needs no API key, no local server, and no
per-use cost — the architecture required to sell it on the Chrome Web
Store.

## Overview

The TTS engine moves into the extension itself. Kokoro-82M (ONNX,
q8 quantization, ~90 MB) runs via the `kokoro-js` npm package inside an
MV3 **offscreen document** — a hidden extension page that can use
WebGPU/WASM and hold the loaded model in memory across requests.

The internal contract is unchanged: the content script sends
`tts-request` / `voices-request` messages and receives
`{ ok, audioDataUrl }` / `{ ok, voices }`. Highlighting, sentence
prefetch, and playback logic are untouched.

```
content script ──tts-request──▶ background (service worker)
                                   │ ensures offscreen document exists
                                   ▼
                              offscreen/tts-engine.js
                              (kokoro-js, model warm in memory)
                                   │ base64 WAV data URL
                                   ▼
content script ◀──{ok, audioDataUrl}── background
```

## Components

### 1. `offscreen/tts-engine.js` + `offscreen/offscreen.html` (new)

- Loads `KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX",
  { dtype: "q8", device: "webgpu" })`, falling back to `device: "wasm"`
  when WebGPU is unavailable.
- Handles `tts-request` (`{ text, voice, speed }` → WAV → base64 data
  URL) and `voices-request` (from `tts.list_voices()`).
- Reports model state to background/popup: `downloading` (with percent
  from the transformers.js progress callback), `ready`, `error`.
- Model weights download from HuggingFace on first use and are cached
  permanently in the extension's Cache API storage. Weights are data,
  not code, so MV3's remote-code ban does not apply.

### 2. `background.js` (rewritten TTS section)

- All Inworld code deleted: API URLs, Basic-auth key handling,
  `no-token` gate, model-ID allowlist, legacy voice-ID length checks.
- Becomes a thin router: creates/reuses the offscreen document
  (`chrome.offscreen.createDocument`, reason `WORKERS`), forwards
  TTS/voices/status requests, returns responses.
- Speed clamp widens from Inworld's 0.5–1.5 to Kokoro's **0.5–2.0**.
- Debug-log plumbing (buffered writes to `chrome.storage.local`) stays.

### 3. Popup

- **Removed:** Inworld API Key field, Inworld model dropdown
  (`inworld-tts-1.5-max/mini`), "Test Inworld API" wording.
- **Voice dropdown (kept, re-sourced):** `#defaultVoice` now lists
  Kokoro voices from `voices-request` (e.g. `af_heart`, `af_bella`,
  `bf_emma`, `am_adam`), grouped by language/accent prefix. Default:
  `af_heart`. Persists to the existing `defaultVoice` storage key.
- **Speed slider (new, replaces the current `<select id="defaultSpeed">`):**
  `<input type="range" min="0.5" max="2.0" step="0.1">` with a live
  label ("1.2×"). Persists to the existing `defaultSpeed` storage key.
- **Engine status row (new):** shows `Downloading model — 43%`,
  `Ready (WebGPU)` / `Ready (CPU)`, or `Fallback: system voice`.
- **"Test voice" button:** synthesizes a short phrase locally with the
  selected voice/speed and plays it.

### 4. Content script

- In-page menu's existing speed slider widens to the same 0.5–2.0 range
  (the 1.2 cap was an Inworld-era workaround). Both sliders use 0.1
  steps over 0.5–2.0 and write the same `defaultSpeed` key, so the two
  controls always agree.
- Existing behavior kept: audio cache invalidation on voice/speed
  change, system-voice (`speechSynthesis`) fallback with friendly toast
  when TTS is unavailable — this now also covers the `model-loading`
  window during first-run download.

### 5. Manifest & permissions

- **Add:** `offscreen`, `unlimitedStorage` (model cache).
- **Remove:** `https://api.inworld.ai/*` host permission; the static
  `<all_urls>` content script (background already injects on demand via
  `chrome.scripting` — narrows install warning and eases store review).
- **CSP:** `extension_pages` gains `'wasm-unsafe-eval'` for ONNX runtime.
- Description updated; version → **0.2.0**.

### 6. Build step (new)

- `esbuild` bundles `kokoro-js`/`@huggingface/transformers` into the
  offscreen script (`npm run build`). The ONNX runtime `.wasm` binaries
  ship inside the package and are pointed to via
  `env.backends.onnx.wasm.wasmPaths` — remote code is banned in MV3,
  local WASM is fine.
- `background.js`, `popup/`, `content/` remain unbundled plain JS.

## Error handling

| Condition | Behavior |
|---|---|
| Model still downloading | `{ ok:false, error:'model-loading', progress }` → system-voice fallback + toast |
| WebGPU unavailable | Automatic WASM fallback (slower, still local) |
| Synthesis / download failure | `{ ok:false, error, detail }` → existing fallback path, logged to debug log |
| Text empty / > 2,000 chars | Existing checks kept (bounds per-sentence synth latency) |

## Testing

- Update `tests/test-tts.js`, `test-background.js`, `test-popup.js`:
  mock the offscreen messaging instead of Inworld fetches; cover the
  new speed clamp, voice defaults, and status states.
- Manual: cold Chrome profile first-run (exercises download UX), WASM
  forced on (simulates no-GPU customer hardware), voice/speed changes
  mid-playback, restricted pages (chrome://) fallback.

## Out of scope (phase 2 — pre-launch)

- Payments/licensing (ExtensionPay or Stripe + license key).
- Chrome Web Store listing assets, privacy policy.
- **License due diligence:** kokoro-js's phonemizer wraps espeak-ng
  (GPL-3.0). Before selling closed-source, either open-source the
  extension, swap the phonemizer, or verify the bundled license chain.
