# Kokoro-js In-Extension TTS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Inworld TTS API with Kokoro-82M running fully inside the Chrome extension (kokoro-js in an MV3 offscreen document), with a popup voice dropdown and speed slider.

**Architecture:** The content script keeps sending `tts-request`/`voices-request` messages and receiving `{ ok, audioDataUrl }`/`{ ok, voices }`. The background service worker becomes a thin router that creates an offscreen document and forwards requests to it. The offscreen document loads Kokoro once (WebGPU with WASM fallback), downloads model weights from HuggingFace on first use (cached in browser storage), and synthesizes WAV audio.

**Tech Stack:** Chrome MV3 (offscreen API, min Chrome 116), kokoro-js + @huggingface/transformers (ONNX runtime web), esbuild for bundling, Node built-in test runner (`node --test`).

**Spec:** `docs/superpowers/specs/2026-07-09-kokoro-js-tts-design.md`

## Global Constraints

- `minimum_chrome_version`: **"116"** (needed for `chrome.runtime.getContexts`).
- Default voice ID: **`af_heart`** — identical string in background.js, popup/popup.js, content/content.js, offscreen/tts-engine.js.
- Speed range: **0.5–2.0 in 0.1 steps** everywhere (popup slider, in-page slider, background clamp, offscreen clamp).
- `MAX_TEXT_LENGTH = 2000` stays (bounds per-request synth latency).
- TTS response contract (unchanged): success `{ ok: true, audioDataUrl: 'data:audio/wav;base64,...' }`; failure `{ ok: false, error: '<code>', detail?, progress? }`.
- Error codes produced after this change: `empty-text`, `text-too-long`, `model-loading`, `engine-error`, `synthesis-failed`, `no-response`.
- MV3 remote-code ban: ONNX runtime `.wasm`/`.mjs` files ship inside the package (copied by the build); model **weights** may be fetched at runtime (they are data).
- Message addressing: messages for the offscreen document carry `target: 'offscreen'`; the offscreen listener ignores everything else; the background listener ignores messages **with** that target.
- Tests run with `npm test` (`node --test tests/*.js`) — they read source files and test mirrored pure functions; they never import extension code (no `chrome` global in Node).
- Build artifacts `offscreen/tts-engine.bundle.js` and `offscreen/ort/` are gitignored; `npm run build` regenerates them.
- Commit after every task; message style matches repo history (`Feat:`, `Fix:`, `Chore:` prefixes), ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Build pipeline and dependencies

**Files:**
- Modify: `package.json`
- Create: `scripts/build.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `npm run build` → writes `offscreen/tts-engine.bundle.js` (ESM bundle of `offscreen/tts-engine.js`) and `offscreen/ort/ort-*.{wasm,mjs}`. Task 3 creates the entry point; until then the build fails on the missing entry, which Step 4 verifies as the "red" state.

- [ ] **Step 1: Add dependencies and the build script to package.json**

Replace the full contents of `package.json` with:

```json
{
  "name": "highlighter-tts",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "description": "Chrome extension: select text with a paint-brush stroke and hear it read aloud with on-device Kokoro AI voices",
  "scripts": {
    "build": "node scripts/build.mjs",
    "test": "node --test tests/*.js",
    "test:extension:verbose": "node tests/playwright-extension-check.mjs",
    "test:extension:playback": "node tests/playwright-playback-flow.mjs",
    "test:extension:real": "node tests/playwright-real-article-flow.mjs",
    "watch:extension": "node tests/watch-extension.mjs"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "kokoro-js": "^1.2.1",
    "playwright": "^1.59.1"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: exits 0; `node_modules/kokoro-js`, `node_modules/@huggingface/transformers`, and `node_modules/esbuild` exist.

- [ ] **Step 3: Write scripts/build.mjs**

```js
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Bundle the offscreen TTS engine. ESM because offscreen.html loads it
// with <script type="module">.
await build({
  entryPoints: ['offscreen/tts-engine.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'offscreen/tts-engine.bundle.js',
  // transformers.js references the Node backend behind a runtime guard;
  // mark it external so esbuild doesn't try to resolve it for the browser.
  external: ['onnxruntime-node'],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

// ONNX Runtime's WASM binaries must ship inside the extension package —
// MV3 forbids remote code, and transformers.js would otherwise pull them
// from a CDN at runtime.
const distDir = 'node_modules/@huggingface/transformers/dist';
const outDir = 'offscreen/ort';
mkdirSync(outDir, { recursive: true });
let copied = 0;
for (const f of readdirSync(distDir)) {
  if (f.startsWith('ort-') && (f.endsWith('.wasm') || f.endsWith('.mjs'))) {
    copyFileSync(join(distDir, f), join(outDir, f));
    copied++;
  }
}
if (copied === 0) {
  throw new Error(`no ort-*.wasm/.mjs files found in ${distDir} — transformers.js layout changed?`);
}
console.log(`build: bundled tts-engine and copied ${copied} ONNX runtime files`);
```

- [ ] **Step 4: Verify the build fails only on the missing entry point**

Run: `npm run build`
Expected: FAIL with esbuild error `Could not resolve "offscreen/tts-engine.js"` (created in Task 3). Any *other* error (bad JSON, missing esbuild) must be fixed now.

- [ ] **Step 5: Ignore build artifacts**

Append to `.gitignore`:

```
offscreen/tts-engine.bundle.js
offscreen/ort/
```

- [ ] **Step 6: Run the existing test suite to confirm no regression**

Run: `npm test`
Expected: PASS (all existing tests still green — nothing they read has changed).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json scripts/build.mjs .gitignore
git commit -m "Chore: add esbuild + kokoro-js build pipeline for offscreen TTS engine

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Manifest for offscreen Kokoro

**Files:**
- Modify: `manifest.json`
- Create: `tests/test-manifest.js`

**Interfaces:**
- Consumes: nothing.
- Produces: permissions `offscreen` + `unlimitedStorage` (Task 4's `chrome.offscreen.createDocument` needs the former; model cache needs the latter); CSP `'wasm-unsafe-eval'` (Task 3's ONNX runtime needs it); static `content_scripts` and `host_permissions` removed (background injects on demand via `activeTab` + `scripting`).

- [ ] **Step 1: Write the failing test**

Create `tests/test-manifest.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));

describe('manifest.json', () => {
  it('declares the permissions the offscreen Kokoro engine needs', () => {
    assert.ok(manifest.permissions.includes('offscreen'), 'offscreen permission');
    assert.ok(manifest.permissions.includes('unlimitedStorage'), 'unlimitedStorage for the model cache');
    assert.ok(manifest.permissions.includes('activeTab'), 'activeTab for on-demand injection');
    assert.ok(manifest.permissions.includes('scripting'), 'scripting for on-demand injection');
  });

  it('allows WASM in extension pages', () => {
    assert.match(manifest.content_security_policy.extension_pages, /'wasm-unsafe-eval'/);
  });

  it('carries no remote API host permissions and no static content scripts', () => {
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_scripts, undefined);
    assert.doesNotMatch(JSON.stringify(manifest), /inworld/i);
  });

  it('requires Chrome 116+ for chrome.runtime.getContexts', () => {
    assert.ok(parseInt(manifest.minimum_chrome_version, 10) >= 116);
  });

  it('is version 0.2.0 with an on-device description', () => {
    assert.equal(manifest.version, '0.2.0');
    assert.match(manifest.description, /on-device|Kokoro/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test-manifest.js`
Expected: FAIL (missing `offscreen` permission, host_permissions still present, version 0.1.31).

- [ ] **Step 3: Rewrite manifest.json**

Replace the full contents of `manifest.json` with:

```json
{
  "manifest_version": 3,
  "name": "Highlighter TTS",
  "version": "0.2.0",
  "description": "Select text with a paint-brush stroke and hear it read aloud with private, on-device Kokoro AI voices",
  "minimum_chrome_version": "116",
  "permissions": [
    "activeTab",
    "storage",
    "contextMenus",
    "scripting",
    "offscreen",
    "unlimitedStorage"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "commands": {
    "toggle-highlight-mode": {
      "suggested_key": {
        "default": "Alt+H",
        "mac": "Alt+H"
      },
      "description": "Toggle highlight mode"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

Note what was removed: `host_permissions` (both `<all_urls>` and `https://api.inworld.ai/*`) and the static `content_scripts` block. The background already injects `content/content.js` + `content/content.css` on demand (`background.js` `injectContentScript()`), and `activeTab` grants access when the user invokes the extension via popup, context menu, or keyboard shortcut.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/test-manifest.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add manifest.json tests/test-manifest.js
git commit -m "Feat: manifest for on-device Kokoro (offscreen, wasm CSP, narrowed permissions) (0.2.0)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Offscreen Kokoro engine

**Files:**
- Create: `offscreen/offscreen.html`
- Create: `offscreen/tts-engine.js`
- Create: `tests/test-offscreen.js`

**Interfaces:**
- Consumes: `chrome.runtime.getURL('offscreen/ort/')` (WASM files from Task 1's build).
- Produces — message API on `chrome.runtime.onMessage`, only for `msg.target === 'offscreen'`:
  - `{ target:'offscreen', type:'tts-request', text: string, voice: string, speed: number }` → `{ ok:true, audioDataUrl:string }` | `{ ok:false, error:'model-loading', progress:number }` | `{ ok:false, error:'engine-error'|'synthesis-failed', detail:string }`
  - `{ target:'offscreen', type:'voices-request' }` → `{ ok:true, voices:[{ voiceId, name, category }] }` | same failure shapes
  - `{ target:'offscreen', type:'engine-status-request' }` → `{ ok:true, status:'idle'|'downloading'|'ready'|'error', progress:number, device:'webgpu'|'wasm'|null, error:string|null }`

- [ ] **Step 1: Write the failing test**

Create `tests/test-offscreen.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');
const engineJs = fs.readFileSync(path.join(rootDir, 'offscreen', 'tts-engine.js'), 'utf8');
const offscreenHtml = fs.readFileSync(path.join(rootDir, 'offscreen', 'offscreen.html'), 'utf8');

// Mirror of offscreen/tts-engine.js#clampSpeed — keep in sync.
function clampSpeed(speed) {
  const parsed = parseFloat(speed);
  if (!Number.isFinite(parsed)) return 1.0;
  return Math.max(0.5, Math.min(2.0, parsed));
}

describe('offscreen document', () => {
  it('loads the built bundle as a module, not the unbundled source', () => {
    assert.match(offscreenHtml, /<script type="module" src="tts-engine\.bundle\.js"><\/script>/);
  });

  it('serves ONNX WASM from inside the extension (MV3 remote-code ban)', () => {
    assert.match(engineJs, /env\.backends\.onnx\.wasm\.wasmPaths = chrome\.runtime\.getURL\('offscreen\/ort\/'\)/);
  });

  it('only handles messages addressed to the offscreen target', () => {
    assert.match(engineJs, /msg\.target !== 'offscreen'/);
  });

  it('falls back from WebGPU to WASM q8', () => {
    assert.match(engineJs, /device: 'webgpu', dtype: 'fp32'/);
    assert.match(engineJs, /device: 'wasm', dtype: 'q8'/);
  });

  it('produces WAV data URLs and uses the shared default voice', () => {
    assert.match(engineJs, /data:audio\/wav;base64,/);
    assert.match(engineJs, /DEFAULT_VOICE_ID = 'af_heart'/);
  });

  it('reports model-loading with progress while the model downloads', () => {
    assert.match(engineJs, /error: 'model-loading'/);
    assert.match(engineJs, /progress: engineStatus\.progress/);
  });
});

describe('clampSpeed (offscreen mirror)', () => {
  it('defaults invalid values to 1x', () => {
    assert.equal(clampSpeed(undefined), 1);
    assert.equal(clampSpeed('abc'), 1);
    assert.equal(clampSpeed(NaN), 1);
    assert.equal(clampSpeed(Infinity), 1);
  });

  it('clamps to the Kokoro range 0.5–2.0', () => {
    assert.equal(clampSpeed(0.1), 0.5);
    assert.equal(clampSpeed(1.7), 1.7);
    assert.equal(clampSpeed(3), 2.0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test-offscreen.js`
Expected: FAIL with `ENOENT ... offscreen/tts-engine.js`.

- [ ] **Step 3: Create offscreen/offscreen.html**

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <script type="module" src="tts-engine.bundle.js"></script>
</body>
</html>
```

- [ ] **Step 4: Create offscreen/tts-engine.js**

```js
// Offscreen TTS engine: runs Kokoro-82M locally via kokoro-js.
// Lives in an offscreen document because the MV3 service worker can't
// run WebGPU/WASM inference or keep a ~90 MB model warm in memory.
// Bundled by scripts/build.mjs into tts-engine.bundle.js.
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE_ID = 'af_heart';
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

function pickBackend() {
  // q8 quantization is unreliable on WebGPU; fp32 is the recommended pairing.
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    return { device: 'webgpu', dtype: 'fp32' };
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
    const attempt = pickBackend();
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/test-offscreen.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Verify the bundle builds**

Run: `npm run build`
Expected: exits 0; `offscreen/tts-engine.bundle.js` exists (roughly 1–3 MB) and `offscreen/ort/` contains at least one `ort-*.wasm` file. If esbuild fails resolving a Node-only module inside transformers.js, add that module name to the `external` array in `scripts/build.mjs` and re-run.

- [ ] **Step 7: Commit**

```bash
git add offscreen/offscreen.html offscreen/tts-engine.js tests/test-offscreen.js
git commit -m "Feat: offscreen Kokoro TTS engine (kokoro-js, WebGPU/WASM, model-loading states)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Background becomes a thin router

**Files:**
- Modify: `background.js`
- Modify: `tests/test-background.js` (full rewrite)

**Interfaces:**
- Consumes: Task 3's offscreen message API (`target: 'offscreen'`).
- Produces (consumed by content script and popup — unchanged message names):
  - `tts-request` `{ text, voice, speed }` → validated/normalized, forwarded to offscreen.
  - `voices-request` → forwarded.
  - `engine-status-request` (new) → forwarded; popup uses it in Task 5.
  - `normalizeSpeed(speed)` clamps to 0.5–2.0.

- [ ] **Step 1: Rewrite the test file first**

Replace the full contents of `tests/test-background.js` with:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');
const backgroundJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

// Mirror of background.js#normalizeSpeed — keep in sync (Kokoro range).
function normalizeSpeed(speed) {
  const parsed = parseFloat(speed);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0.5, Math.min(2.0, parsed));
}

describe('background command handling', () => {
  it('resolves keyboard shortcuts through the active tab query path', () => {
    assert.match(backgroundJs, /chrome\.commands\.onCommand\.addListener\(\(command\)/);
    assert.match(backgroundJs, /chrome\.tabs\.query\(\{ active: true, lastFocusedWindow: true \}/);
  });

  it('guards against undefined tab ids before sending messages', () => {
    assert.match(backgroundJs, /if \(!Number\.isInteger\(tabId\)\) \{/);
    assert.match(backgroundJs, /error: 'tab-not-found'/);
  });
});

describe('offscreen routing', () => {
  it('creates the offscreen document lazily via getContexts', () => {
    assert.match(backgroundJs, /chrome\.runtime\.getContexts\(\{ contextTypes: \['OFFSCREEN_DOCUMENT'\] \}\)/);
    assert.match(backgroundJs, /chrome\.offscreen[\s\S]*?\.createDocument\(/);
    assert.match(backgroundJs, /reasons: \['WORKERS'\]/);
  });

  it('addresses forwarded messages to the offscreen target and ignores them in its own listener', () => {
    assert.match(backgroundJs, /target: 'offscreen'/);
    assert.match(backgroundJs, /msg\.target === 'offscreen'\) return false/);
  });

  it('routes tts, voices, and engine-status requests', () => {
    assert.match(backgroundJs, /if \(msg\.type === 'tts-request'\)/);
    assert.match(backgroundJs, /if \(msg\.type === 'voices-request'\)/);
    assert.match(backgroundJs, /if \(msg\.type === 'engine-status-request'\)/);
  });

  it('has no Inworld, ElevenLabs, or API-key remnants', () => {
    assert.doesNotMatch(backgroundJs, /inworld/i);
    assert.doesNotMatch(backgroundJs, /elevenlabs/i);
    assert.doesNotMatch(backgroundJs, /apiKey/);
    assert.doesNotMatch(backgroundJs, /Authorization/);
    assert.doesNotMatch(backgroundJs, /fetch\(/);
  });

  it('uses the Kokoro default voice', () => {
    assert.match(backgroundJs, /DEFAULT_VOICE_ID = 'af_heart'/);
  });
});

describe('normalizeSpeed', () => {
  it('defaults invalid values to 1x', () => {
    assert.equal(normalizeSpeed(undefined), 1);
    assert.equal(normalizeSpeed('abc'), 1);
    assert.equal(normalizeSpeed(null), 1);
    assert.equal(normalizeSpeed(NaN), 1);
    assert.equal(normalizeSpeed(Infinity), 1);
  });

  it('clamps speeds to the Kokoro range', () => {
    assert.equal(normalizeSpeed(0.1), 0.5);
    assert.equal(normalizeSpeed(1.7), 1.7);
    assert.equal(normalizeSpeed(3), 2.0);
  });

  it('matches the clamp constants in background.js', () => {
    assert.match(backgroundJs, /Math\.max\(0\.5, Math\.min\(2\.0, parsed\)\)/);
  });
});

describe('text length validation', () => {
  it('enforces the 2000-character per-request cap', () => {
    assert.match(backgroundJs, /MAX_TEXT_LENGTH\s*=\s*2000/);
    assert.match(backgroundJs, /normalizedText\.length > MAX_TEXT_LENGTH/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test-background.js`
Expected: FAIL — `offscreen routing` and `normalizeSpeed` describes fail against the current Inworld implementation.

- [ ] **Step 3: Rewrite background.js**

Replace the full contents of `background.js` with:

```js
'use strict';

// ── Constants ───────────────────────────────────────────────────────
const DEFAULT_VOICE_ID = 'af_heart';
// Not an API limit anymore — bounds worst-case on-device synth latency
// for a single request (the content script sends one sentence at a time).
const MAX_TEXT_LENGTH = 2000;
const LOG_PREFIX = '[Highlighter TTS]';
const DEBUG_LOG_KEY = 'debugLog';
const DEBUG_LOG_LIMIT = 250;
const LOG_FLUSH_INTERVAL_MS = 2000;
const OFFSCREEN_URL = 'offscreen/offscreen.html';

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

function sendToOffscreen(message) {
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

// ── Message router ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
        sendResponse({ ok: false, error: 'engine-error', detail: err.message });
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
async function handleTtsRequest({ text, voice, speed }, requestId = ++requestSeq) {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/test-background.js tests/test-manifest.js tests/test-offscreen.js`
Expected: PASS. (`tests/test-popup.js` and `tests/test-tts.js` still fail overall `npm test` at this point — they are rewritten in Tasks 5–6.)

- [ ] **Step 5: Commit**

```bash
git add background.js tests/test-background.js
git commit -m "Feat: route TTS through offscreen Kokoro engine, drop Inworld API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Popup — voice dropdown, speed slider, engine status

**Files:**
- Modify: `popup/popup.html`
- Modify: `popup/popup.js` (full rewrite)
- Modify: `tests/test-popup.js` (full rewrite)

**Interfaces:**
- Consumes: `voices-request`, `tts-request`, `engine-status-request`, `debug-log-request`, `debug-log-clear` from Task 4.
- Produces: storage keys `defaultVoice` (string voice id) and `defaultSpeed` (string like `"1.2"`) — same keys the content script reads.

- [ ] **Step 1: Rewrite the test file first**

Replace the full contents of `tests/test-popup.js` with:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');
const popupHtml = fs.readFileSync(path.join(rootDir, 'popup', 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(rootDir, 'popup', 'popup.js'), 'utf8');
const backgroundJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');
const contentJs = fs.readFileSync(path.join(rootDir, 'content', 'content.js'), 'utf8');

// Mirror of popup.js#snapSpeed — keep in sync.
function snapSpeed(value) {
  const raw = parseFloat(value);
  const safe = Number.isFinite(raw) ? raw : 1.0;
  const clamped = Math.max(0.5, Math.min(2.0, safe));
  return Math.round(clamped * 10) / 10;
}

describe('popup.html', () => {
  it('associates labels with form controls', () => {
    for (const id of ['defaultVoice', 'defaultSpeed', 'articleMode']) {
      assert.match(popupHtml, new RegExp(`<label[^>]*for="${id}"`, 'i'));
    }
  });

  it('exposes the voice dropdown and a range slider for speed', () => {
    assert.match(popupHtml, /<select id="defaultVoice"><\/select>/i);
    assert.match(popupHtml, /<input type="range" id="defaultSpeed" min="0.5" max="2" step="0.1"/i);
    assert.match(popupHtml, /id="speedValue"/);
  });

  it('shows engine status and a local test button instead of API-key UI', () => {
    assert.match(popupHtml, /id="engineStatus"/);
    assert.match(popupHtml, /id="testVoiceBtn"/);
    assert.doesNotMatch(popupHtml, /inworld/i);
    assert.doesNotMatch(popupHtml, /api key/i);
    assert.doesNotMatch(popupHtml, /id="modelId"/);
  });
});

describe('popup.js', () => {
  it('debounces transient status clearing so newer messages are not cleared early', () => {
    assert.match(popupJs, /clearTimeout\(statusTimer\)/);
    assert.match(popupJs, /statusTimer\s*=\s*setTimeout/);
  });

  it('loads voice options dynamically from the background worker', () => {
    assert.match(popupJs, /chrome\.runtime\.sendMessage\(\{ type: 'voices-request' \}/);
    assert.match(popupJs, /function setDefaultVoice\(voiceId\)/);
  });

  it('polls engine status while the model downloads', () => {
    assert.match(popupJs, /engine-status-request/);
    assert.match(popupJs, /Downloading voice model/);
    assert.match(popupJs, /scheduleEnginePoll/);
  });

  it('persists snapped slider values on change and previews on input', () => {
    assert.match(popupJs, /speedSlider\.addEventListener\('input'/);
    assert.match(popupJs, /speedSlider\.addEventListener\('change'/);
    assert.match(popupJs, /function snapSpeed\(value\)/);
  });

  it('has no Inworld or API-key remnants', () => {
    assert.doesNotMatch(popupJs, /inworld/i);
    assert.doesNotMatch(popupJs, /apiKey|API key/i);
    assert.doesNotMatch(popupJs, /modelId/);
  });
});

describe('snapSpeed (popup mirror)', () => {
  it('snaps to one decimal within 0.5–2.0', () => {
    assert.equal(snapSpeed('1.2499'), 1.2);
    assert.equal(snapSpeed(0.1), 0.5);
    assert.equal(snapSpeed(3), 2.0);
    assert.equal(snapSpeed('abc'), 1.0);
  });
});

describe('default voice ID consistency', () => {
  it('uses the same Kokoro default voice everywhere', () => {
    for (const [name, src] of [['popup.js', popupJs], ['background.js', backgroundJs], ['content.js', contentJs]]) {
      const match = src.match(/DEFAULT_VOICE_ID\s*=\s*'([^']+)'/);
      assert.ok(match, `${name} should define DEFAULT_VOICE_ID`);
      assert.equal(match[1], 'af_heart', `${name} DEFAULT_VOICE_ID`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test-popup.js`
Expected: FAIL (popup still has Inworld UI; content.js still uses 'Ashley' — the consistency test goes green only after Task 6, which is fine: this task's steps only need the popup describes passing; run the consistency describe again after Task 6).

- [ ] **Step 3: Update popup.html**

In `popup/popup.html`, replace the three fields `inworldApiToken`, `modelId`, and `defaultSpeed` (lines 148–173 of the current file) — keeping the `defaultVoice` field between them — so the body section reads:

```html
  <h1>Highlighter TTS</h1>

  <div class="field">
    <label>Voice Engine</label>
    <div class="hint" id="engineStatus">Checking engine…</div>
  </div>

  <div class="field">
    <label for="defaultVoice">Voice</label>
    <select id="defaultVoice"></select>
    <div class="hint" id="voiceHint">Voices run on-device via Kokoro — nothing to configure.</div>
  </div>

  <div class="field">
    <label for="defaultSpeed">Speed: <span id="speedValue">1.0×</span></label>
    <input type="range" id="defaultSpeed" min="0.5" max="2" step="0.1" value="1">
    <div class="hint">0.5× – 2.0× — applied during synthesis, not playback.</div>
  </div>
```

And in the `.debug-actions` block, rename the test button:

```html
    <button type="button" id="testVoiceBtn">Test Voice</button>
```

Add this CSS rule after the existing `select` rule in the `<style>` block:

```css
    input[type="range"] {
      width: 100%;
      accent-color: #7c5cbf;
    }
```

- [ ] **Step 4: Rewrite popup.js**

Replace the full contents of `popup/popup.js` with:

```js
const voiceSelect = document.getElementById('defaultVoice');
const speedSlider = document.getElementById('defaultSpeed');
const speedValueEl = document.getElementById('speedValue');
const engineStatusEl = document.getElementById('engineStatus');
const articleToggle = document.getElementById('articleMode');
const statusEl = document.getElementById('status');
const copyDebugLogBtn = document.getElementById('copyDebugLog');
const clearDebugLogBtn = document.getElementById('clearDebugLog');
const testVoiceBtn = document.getElementById('testVoiceBtn');
const debugPreview = document.getElementById('debugPreview');
const DEFAULT_VOICE_ID = 'af_heart';
const LOG_PREFIX = '[Highlighter Popup]';
const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
const ENGINE_POLL_MS = 1000;

let statusTimer = 0;
let enginePollTimer = 0;
let voicesLoadedFromEngine = false;

function logDebug(event, details = {}) {
  console.log(`${LOG_PREFIX} ${event}`, details);
  persistDebugEvent('popup', event, details);
}

function persistDebugEvent(source, event, details = {}) {
  chrome.runtime.sendMessage(
    {
      type: 'debug-event',
      entry: {
        ts: new Date().toISOString(),
        source,
        event,
        details,
      },
    },
    () => {
      // Suppress benign errors while the service worker is restarting.
      void chrome.runtime.lastError;
    }
  );
}

// ── Speed slider helpers ────────────────────────────────────────────
// Snap to one decimal in [0.5, 2.0] so storage stays clean even if the
// range input reports float drift (e.g. 0.7000000000000001).
function snapSpeed(value) {
  const raw = parseFloat(value);
  const safe = Number.isFinite(raw) ? raw : 1.0;
  const clamped = Math.max(SPEED_MIN, Math.min(SPEED_MAX, safe));
  return Math.round(clamped * 10) / 10;
}

function formatSpeedLabel(speed) {
  return `${speed.toFixed(1)}×`;
}

function renderSpeed(speed) {
  speedSlider.value = speed.toString();
  speedValueEl.textContent = formatSpeedLabel(speed);
}

// ── Load saved settings ─────────────────────────────────────────────
chrome.storage.local.get(['defaultVoice', 'defaultSpeed', 'articleMode'], (data) => {
  const storageError = chrome.runtime.lastError?.message || null;
  if (storageError) {
    logDebug('settings-load-failed', { error: storageError });
    showStatus('Could not load settings');
    return;
  }

  logDebug('settings-loaded', {
    defaultVoice: data.defaultVoice || null,
    defaultSpeed: data.defaultSpeed || null,
    articleMode: data.articleMode,
  });

  const effectiveVoice = data.defaultVoice || DEFAULT_VOICE_ID;
  renderSpeed(snapSpeed(data.defaultSpeed ?? 1.0));
  if (data.articleMode !== undefined) articleToggle.checked = data.articleMode;

  ensureVoiceOption(effectiveVoice, 'Saved voice');
  refreshEngineStatus();
  loadVoices(effectiveVoice);
});

function showStatus(msg) {
  statusEl.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = '';
    statusTimer = 0;
  }, 2000);
}

function save(key, value) {
  logDebug('save-setting', { key, value });
  chrome.storage.local.set({ [key]: value }, () => {
    const error = chrome.runtime.lastError?.message || null;
    showStatus(error ? 'Could not save setting' : 'Saved');
  });
}

function ensureVoiceOption(voiceId, label) {
  if (!voiceId) return;
  const existing = Array.from(voiceSelect.options).find((option) => option.value === voiceId);
  if (existing) {
    existing.textContent = label || existing.textContent;
    voiceSelect.value = voiceId;
    return;
  }

  const option = document.createElement('option');
  option.value = voiceId;
  option.textContent = label || voiceId;
  voiceSelect.appendChild(option);
  voiceSelect.value = voiceId;
}

function setDefaultVoice(voiceId) {
  chrome.storage.local.set({ defaultVoice: voiceId }, () => {
    const error = chrome.runtime.lastError?.message || null;
    showStatus(error ? 'Could not save voice' : 'Saved');
  });
}

function loadVoices(selectedVoice) {
  const startedAt = performance.now();
  logDebug('voices-request-start', { selectedVoice });
  chrome.runtime.sendMessage({ type: 'voices-request' }, (response) => {
    logDebug('voices-response', {
      ok: Boolean(response?.ok),
      error: response?.error || null,
      voiceCount: response?.voices?.length || 0,
      elapsedMs: Math.round(performance.now() - startedAt),
      runtimeError: chrome.runtime.lastError?.message || null,
    });
    if (chrome.runtime.lastError || !response || !response.ok || !response.voices?.length) {
      // Model probably still downloading — the engine-status poll retries
      // loadVoices once the engine reports ready.
      ensureVoiceOption(selectedVoice || DEFAULT_VOICE_ID, 'Default voice');
      return;
    }

    const groups = new Map();
    for (const voice of response.voices) {
      const category = voice.category || 'Other';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(voice);
    }

    const fragment = document.createDocumentFragment();
    for (const [category, voices] of groups) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = category;
      for (const voice of voices) {
        const option = document.createElement('option');
        option.value = voice.voiceId;
        option.textContent = voice.name;
        optgroup.appendChild(option);
      }
      fragment.appendChild(optgroup);
    }

    voiceSelect.replaceChildren(fragment);
    voicesLoadedFromEngine = true;
    const effectiveVoiceId = Array.from(voiceSelect.options).some((option) => option.value === selectedVoice)
      ? selectedVoice
      : DEFAULT_VOICE_ID;
    voiceSelect.value = effectiveVoiceId;
    if (!voiceSelect.value && voiceSelect.options.length > 0) {
      voiceSelect.selectedIndex = 0;
    }
    if (effectiveVoiceId !== selectedVoice && effectiveVoiceId) {
      logDebug('stale-voice-reset', { from: selectedVoice, to: effectiveVoiceId });
      setDefaultVoice(effectiveVoiceId);
    }
  });
}

// ── Engine status ───────────────────────────────────────────────────
function scheduleEnginePoll() {
  clearTimeout(enginePollTimer);
  enginePollTimer = setTimeout(refreshEngineStatus, ENGINE_POLL_MS);
}

function refreshEngineStatus() {
  chrome.runtime.sendMessage({ type: 'engine-status-request' }, (resp) => {
    const runtimeError = chrome.runtime.lastError?.message || null;
    if (runtimeError || !resp || !resp.ok) {
      engineStatusEl.textContent = 'Engine unavailable — system voice will be used';
      logDebug('engine-status-failed', { error: runtimeError || resp?.error || 'no-response' });
      return;
    }
    switch (resp.status) {
      case 'downloading':
        engineStatusEl.textContent = `Downloading voice model — ${resp.progress || 0}%`;
        scheduleEnginePoll();
        break;
      case 'ready':
        engineStatusEl.textContent = resp.device === 'webgpu'
          ? 'Ready — on-device (GPU)'
          : 'Ready — on-device (CPU)';
        if (!voicesLoadedFromEngine) loadVoices(voiceSelect.value || DEFAULT_VOICE_ID);
        break;
      case 'error':
        engineStatusEl.textContent = `Engine error: ${resp.error || 'unknown'}`;
        break;
      default: // 'idle' — engine starts loading on first request
        engineStatusEl.textContent = 'Starting voice engine…';
        scheduleEnginePoll();
    }
  });
}

// ── Debug log actions ───────────────────────────────────────────────
function formatDebugEntries(entries) {
  return entries
    .map((entry) => {
      const details = entry.details ? ` ${JSON.stringify(entry.details)}` : '';
      return `${entry.ts} [${entry.source}] ${entry.event}${details}`;
    })
    .join('\n');
}

function copyDebugLog() {
  chrome.runtime.sendMessage({ type: 'debug-log-request' }, async (response) => {
    const runtimeError = chrome.runtime.lastError?.message || null;
    if (runtimeError || !response?.ok) {
      debugPreview.style.display = 'block';
      debugPreview.textContent = runtimeError || response?.error || 'Debug log unavailable.';
      showStatus('Debug log unavailable');
      return;
    }
    const entries = Array.isArray(response?.entries) ? response.entries : [];
    const text = formatDebugEntries(entries);
    debugPreview.style.display = 'block';
    debugPreview.textContent = text || 'No debug entries yet.';
    try {
      await navigator.clipboard.writeText(text || 'No debug entries yet.');
      showStatus(`Copied ${entries.length} debug entries`);
    } catch {
      showStatus(`Showing ${entries.length} debug entries`);
    }
  });
}

function clearDebugLog() {
  chrome.runtime.sendMessage({ type: 'debug-log-clear' }, (response) => {
    const runtimeError = chrome.runtime.lastError?.message || null;
    if (runtimeError || !response?.ok) {
      showStatus('Could not clear debug log');
      return;
    }
    debugPreview.style.display = 'none';
    debugPreview.textContent = '';
    showStatus('Debug log cleared');
  });
}

function showInPreview(lines) {
  debugPreview.style.display = 'block';
  debugPreview.textContent = lines.join('\n');
}

// ── Test voice ──────────────────────────────────────────────────────
function testVoice() {
  testVoiceBtn.disabled = true;
  testVoiceBtn.textContent = 'Synthesizing…';
  const voice = voiceSelect.value || DEFAULT_VOICE_ID;
  const speed = snapSpeed(speedSlider.value);
  const startedAt = performance.now();
  chrome.runtime.sendMessage(
    { type: 'tts-request', text: 'This is your Kokoro voice.', voice, speed },
    (resp) => {
      const runtimeError = chrome.runtime.lastError?.message || null;
      testVoiceBtn.disabled = false;
      testVoiceBtn.textContent = 'Test Voice';
      if (runtimeError || !resp?.ok || !resp.audioDataUrl) {
        const reason = resp?.error === 'model-loading'
          ? `Model still downloading (${resp.progress || 0}%).`
          : (resp?.detail || resp?.error || runtimeError || 'no response');
        showInPreview([`Test failed: ${reason}`]);
        showStatus('Test failed');
        refreshEngineStatus();
        return;
      }
      showInPreview([
        `Synthesized in ${Math.round(performance.now() - startedAt)} ms`,
        `Voice: ${voice}  Speed: ${formatSpeedLabel(speed)}`,
        `Audio: ${Math.round(resp.audioDataUrl.length / 1024)} KB (base64 WAV)`,
      ]);
      new Audio(resp.audioDataUrl).play().catch((err) => {
        showStatus(`Playback failed: ${err?.message || err}`);
      });
      showStatus('Playing test voice');
    }
  );
}

// ── Event wiring ────────────────────────────────────────────────────
voiceSelect.addEventListener('change', () => save('defaultVoice', voiceSelect.value));
speedSlider.addEventListener('input', () => {
  speedValueEl.textContent = formatSpeedLabel(snapSpeed(speedSlider.value));
});
speedSlider.addEventListener('change', () => {
  const snapped = snapSpeed(speedSlider.value);
  renderSpeed(snapped);
  save('defaultSpeed', snapped.toString());
});
articleToggle.addEventListener('change', () => save('articleMode', articleToggle.checked));
copyDebugLogBtn.addEventListener('click', copyDebugLog);
clearDebugLogBtn.addEventListener('click', clearDebugLog);
testVoiceBtn.addEventListener('click', testVoice);
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/test-popup.js`
Expected: PASS except the `default voice ID consistency` describe (content.js still says 'Ashley' until Task 6). Everything else green.

- [ ] **Step 6: Commit**

```bash
git add popup/popup.html popup/popup.js tests/test-popup.js
git commit -m "Feat: popup voice dropdown + speed slider + engine status for on-device Kokoro

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Content script — Kokoro speed range, default voice, error messages

**Files:**
- Modify: `content/content.js:13` (default voice), `content/content.js:16-20` (SPEEDS), `content/content.js:1159-1161` (comment), `content/content.js:1349-1376` (error map + playback-rate clamp)
- Modify: `tests/test-tts.js` (error-map mirror + speed clamp sections)

**Interfaces:**
- Consumes: Task 4's response contract, including new error codes `model-loading` (with `progress`), `engine-error`, `synthesis-failed`.
- Produces: storage writes to `defaultSpeed` from the in-page slider (unchanged key), now over 0.5–2.0 in 0.1 steps.

- [ ] **Step 1: Update the test mirrors first**

In `tests/test-tts.js`, replace the `getErrorMessage` mirror function (lines 11–30) with:

```js
function getErrorMessage(response) {
  if (!response) return 'No response from background';
  switch (response.error) {
    case 'empty-text':        return 'Select some text before playing';
    case 'text-too-long':     return response.detail || 'Text exceeds maximum length';
    case 'model-loading':     return typeof response.progress === 'number' && response.progress > 0
      ? `Voice model downloading (${response.progress}%) — using system voice meanwhile`
      : 'Voice model loading — using system voice meanwhile';
    case 'engine-error':      return response.detail
      ? `Voice engine error\n${truncateDetail(response.detail)}`
      : 'Voice engine error — using system voice';
    case 'synthesis-failed':  return response.detail
      ? `Synthesis failed\n${truncateDetail(response.detail)}`
      : 'Synthesis failed — using system voice';
    case 'timeout':           return 'Request timed out — try again';
    default:                  return response.error || 'Unknown error';
  }
}
```

Then in the `describe('getErrorMessage', ...)` block: **delete** the tests `maps no-token`, `maps auth-failed without detail`, `includes upstream auth detail when available`, and `maps billing-required with 402` (and any other tests referencing `rate-limited` or `api-error`), and **add**:

```js
  it('maps model-loading with progress', () => {
    const msg = getErrorMessage({ error: 'model-loading', progress: 43 });
    assert.match(msg, /43%/);
    assert.match(msg, /system voice/i);
  });

  it('maps model-loading without progress', () => {
    assert.match(getErrorMessage({ error: 'model-loading' }), /loading/i);
  });

  it('maps engine-error with detail', () => {
    const msg = getErrorMessage({ error: 'engine-error', detail: 'WebGPU adapter lost' });
    assert.match(msg, /engine error/i);
    assert.match(msg, /WebGPU adapter lost/);
  });

  it('maps synthesis-failed', () => {
    assert.match(getErrorMessage({ error: 'synthesis-failed' }), /synthesis failed/i);
  });
```

In the `describe('normalizePlaybackRate', ...)` section, update the mirror function's clamp from `Math.min(1.5, parsed)` to `Math.min(2.0, parsed)` and update any assertion that expects an input above 2.0 to clamp — e.g. `assert.equal(normalizePlaybackRate(3), 1.5)` becomes `assert.equal(normalizePlaybackRate(3), 2.0)`; an assertion like `normalizePlaybackRate(1.7) === 1.5` becomes `=== 1.7`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test-tts.js`
Expected: The updated mirror tests pass (they test the mirror), but this step exists to make sure you didn't break unrelated describes. The real "does content.js match" check is the grep-style consistency test in `tests/test-popup.js` (`default voice ID consistency`), which still FAILS until Step 3.

- [ ] **Step 3: Update content.js**

Edit 1 — `content/content.js:13`:

```js
  const DEFAULT_VOICE_ID = 'af_heart';
```

Edit 2 — replace lines 16–20 (the SPEEDS comment + constants):

```js
  // Kokoro's supported synthesis range. 16 detents in 0.1 increments.
  // Math.round avoids float-arithmetic drift (0.5 + 7*0.1 !== 1.2 in
  // IEEE 754) that would break SPEEDS.indexOf checks.
  const SPEEDS = Array.from({ length: 16 }, (_, i) => Math.round((0.5 + i * 0.1) * 100) / 100);
  const SPEED_DEFAULT_INDEX = SPEEDS.indexOf(1.0); // 5
```

Edit 3 — replace the comment above `pbAudio.playbackRate = 1.0;` (lines 1159–1161):

```js
    // Speed is applied by Kokoro during synthesis; double-applying
    // playbackRate here would compound the rate and degrade pitch.
    pbAudio.playbackRate = 1.0;
```

Edit 4 — replace the `getErrorMessage` function (lines 1349–1370) with the same body as the test mirror in Step 1 (identical switch, using the existing `truncateDetail` helper).

Edit 5 — in `normalizePlaybackRate` (line 1372–1376), widen the clamp and comment (this rate feeds the speechSynthesis fallback voice):

```js
  function normalizePlaybackRate(speed) {
    const parsed = parseFloat(speed);
    if (!Number.isFinite(parsed)) return 1.0;
    return Math.max(0.5, Math.min(2.0, parsed));
  }
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — every file including the cross-file `default voice ID consistency` test and `tests/test-ui.js` (whose assertions about content.js are unaffected by these edits).

- [ ] **Step 5: Commit**

```bash
git add content/content.js tests/test-tts.js
git commit -m "Feat: content script speaks Kokoro — 0.5–2.0x speed range, af_heart default, new error map

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Harness, README, and end-to-end verification

**Files:**
- Modify: `tests/extension-harness.mjs:97-108`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a verified, loadable extension.

- [ ] **Step 1: Update the Playwright harness seed**

In `tests/extension-harness.mjs`, replace the storage-seeding block (lines 97–107) with:

```js
  await popupPage.evaluate(async () => {
    await chrome.storage.local.set({
      defaultVoice: 'af_heart',
      defaultSpeed: '1',
    });
  });
```

Also remove the now-unused `apiKey` parameter from the surrounding function's signature and any callers in `tests/playwright-*.mjs` that pass it (grep: `grep -rn "apiKey" tests/*.mjs` and delete each reference — the harness no longer needs credentials).

- [ ] **Step 2: Update README.md**

Read `README.md`; replace every Inworld reference (description, API-key setup instructions) so it documents:

```markdown
## How it works

All speech is generated on your device by the Kokoro-82M model — no API
key, no cloud calls, no per-use cost. On first use the extension downloads
the voice model (~90 MB, cached permanently); until it finishes, playback
falls back to your system voice.

## Development

```bash
npm install
npm run build   # bundles the offscreen TTS engine (required before loading)
npm test        # unit tests
```

Load the extension unpacked from the repo root (chrome://extensions →
Developer mode → Load unpacked) after running the build.
```

- [ ] **Step 3: Full unit suite + build**

Run: `npm test && npm run build`
Expected: all tests PASS; build exits 0.

- [ ] **Step 4: Manual end-to-end verification (requires Chrome)**

1. `chrome://extensions` → reload the unpacked extension.
2. Open the popup → engine status should show `Downloading voice model — N%` climbing, then `Ready — on-device (GPU)` or `(CPU)`; voice dropdown fills with grouped Kokoro voices.
3. Click **Test Voice** → hear a short phrase in the selected voice; drag the speed slider to 2.0× and test again — noticeably faster.
4. On a normal article page: toggle highlight mode (Alt+H or context menu), stroke a paragraph → playback in the Kokoro voice; in-page menu slider shows 0.5–2.0 range; changing voice/speed invalidates cache and re-synthesizes.
5. While the model is still downloading (fresh profile: `npm run test:extension:verbose` uses one), stroke text → friendly toast + system-voice fallback.
6. Verify no requests to `api.inworld.ai` in the service-worker network log, and that model files came from `huggingface.co` only on first run (cached on the second).
7. Force the CPU path once (temporarily make `pickBackend()` return the WASM pair, rebuild, reload): status should read `Ready — on-device (CPU)` and per-sentence synth should still feel usable — this simulates customer hardware without WebGPU. Revert the change afterwards.

Record any deviation as a bug before proceeding.

- [ ] **Step 5: Commit**

```bash
git add tests/extension-harness.mjs README.md
git commit -m "Chore: update harness seed and README for on-device Kokoro

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Troubleshooting notes for implementers

- **esbuild fails resolving a Node-only import** inside `@huggingface/transformers`: add that specifier to `external` in `scripts/build.mjs` (it's behind a runtime environment guard and never executes in the browser).
- **`tts.generate` rejects the `speed` option**: the installed kokoro-js is too old — require `^1.2.1` (Task 1 pins this).
- **SharedArrayBuffer errors in the offscreen console**: set `env.backends.onnx.wasm.numThreads = 1;` right after the `wasmPaths` line in `offscreen/tts-engine.js` (slower, but universally compatible) and note it in the commit message.
- **Garbled audio on WebGPU**: force WASM by changing `pickBackend()` to always return the WASM pair; file a follow-up to re-test WebGPU on a newer kokoro-js.
- **Phase 2 (out of scope, pre-launch):** payments/licensing, store listing assets, espeak-ng GPL license chain check — see the spec's "Out of scope" section.
