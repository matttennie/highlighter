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
    assert.doesNotMatch(backgroundJs, /api\.inworld\.ai/);
    assert.match(backgroundJs, /chrome\.storage\.local\.remove\(\['inworld_Highlighter_API_Key', 'modelId'\]/);
    assert.doesNotMatch(backgroundJs, /elevenlabs/i);
    assert.doesNotMatch(backgroundJs, /apiKey/);
    assert.doesNotMatch(backgroundJs, /Authorization/);
    // fetch() now exists solely for the loopback native Kokoro server.
    assert.doesNotMatch(backgroundJs, /fetch\((?!`\$\{NATIVE_BASE_URL\})/);
  });

  it('uses the Kokoro default voice', () => {
    assert.match(backgroundJs, /DEFAULT_VOICE_ID = 'bf_emma'/);
  });

  it('retries offscreen sends while the bundle is still evaluating', () => {
    assert.match(backgroundJs, /Receiving end does not exist/);
    assert.match(backgroundJs, /OFFSCREEN_SEND_RETRIES = 5/);
    assert.match(backgroundJs, /offscreen-send-retry/);
  });

  it('pre-warms the engine when the user toggles highlight mode', () => {
    assert.match(backgroundJs, /function sendToggle\([\s\S]{0,200}?void preWarmEngine\(\)/);
  });
});

describe('offscreen boot-info routing (storage-crash fix)', () => {
  it('routes engine-boot-info-request: reads storage and responds with defaultVoice + loadedOnce', () => {
    assert.match(backgroundJs, /if \(msg\.type === 'engine-boot-info-request'\)/);
    assert.match(backgroundJs, /chrome\.storage\.local\.get\(\['defaultVoice', 'kokoroLoadedOnce'\]/);
    assert.match(backgroundJs, /loadedOnce: Boolean\(/);
  });

  it('routes engine-loaded-once: persists kokoroLoadedOnce and responds ok', () => {
    assert.match(backgroundJs, /if \(msg\.type === 'engine-loaded-once'\)/);
    assert.match(backgroundJs, /chrome\.storage\.local\.set\(\{ kokoroLoadedOnce: true \}/);
  });
});

describe('tts-cancel routing (Wave B)', () => {
  it('renames the onMessage listener sender param so tab scoping can read it', () => {
    assert.match(backgroundJs, /chrome\.runtime\.onMessage\.addListener\(\(msg, sender, sendResponse\)/);
  });

  it('has a tts-cancel route that responds ok immediately', () => {
    assert.match(backgroundJs, /msg\.type === 'tts-cancel'/);
  });

  it('scopes client request ids per tab (both tts-request and tts-cancel)', () => {
    assert.match(backgroundJs, /\$\{sender\.tab\?\.id \?\? 'x'\}:\$\{/);
    // tts-request forwards a scoped clientRequestId to the offscreen doc.
    assert.match(backgroundJs, /const clientRequestId = msg\.clientRequestId \?/);
    assert.match(backgroundJs, /handleTtsRequest\(msg, requestId, clientRequestId\)/);
  });

  it('does not create the offscreen document just to deliver a cancel', () => {
    const cancelRoute = backgroundJs.match(/if \(msg\.type === 'tts-cancel'\) \{([\s\S]*?)\n {2}\}/);
    assert.ok(cancelRoute, 'tts-cancel route not found');
    assert.doesNotMatch(cancelRoute[1], /ensureOffscreenDocument/);
    assert.match(cancelRoute[1], /forwardCancelToOffscreen/);
  });

  it('forwards a cancel only when an offscreen document already exists', () => {
    const helper = backgroundJs.match(/async function forwardCancelToOffscreen\([\s\S]*?\n\}/);
    assert.ok(helper, 'forwardCancelToOffscreen helper not found');
    assert.match(helper[0], /getContexts\(\{ contextTypes: \['OFFSCREEN_DOCUMENT'\] \}\)/);
    assert.match(helper[0], /contexts\.length === 0\) return/);
    assert.doesNotMatch(helper[0], /ensureOffscreenDocument/);
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

describe('native-first routing', () => {
  it('defines the native companion server constants', () => {
    assert.match(backgroundJs, /const NATIVE_BASE_URL = 'http:\/\/127\.0\.0\.1:8880';/);
    assert.match(backgroundJs, /const NATIVE_HEALTH_TIMEOUT_MS = 600;/);
    assert.match(backgroundJs, /const NATIVE_TTS_TIMEOUT_MS = 30000;/);
    assert.match(backgroundJs, /const NATIVE_RECHECK_MS = 30000;/);
  });

  it('caches native availability and probes /health with an abortable fetch', () => {
    assert.match(backgroundJs, /async function isNativeAvailable\(\)/);
    assert.match(backgroundJs, /fetch\(`\$\{NATIVE_BASE_URL\}\/health`, \{ signal: controller\.signal \}\)/);
    assert.match(backgroundJs, /now - nativeState\.checkedAt < NATIVE_RECHECK_MS/);
  });

  it('marks native down on failure so callers fall back to offscreen', () => {
    assert.match(backgroundJs, /function markNativeDown\(\)/);
    assert.match(backgroundJs, /nativeState = \{ available: false, checkedAt: Date\.now\(\) \}/);
  });

  it('routes tts-request to native /tts first, falling back to offscreen on failure', () => {
    assert.match(backgroundJs, /fetch\(`\$\{NATIVE_BASE_URL\}\/tts`/);
    assert.match(backgroundJs, /audioDataUrl: `data:audio\/wav;base64,\$\{payload\.audioContent\}`/);
    // On native failure the handler must mark native down and log before falling through.
    const ttsFn = backgroundJs.match(/async function handleTtsRequest\([\s\S]*?\n}\n/);
    assert.ok(ttsFn, 'handleTtsRequest not found');
    assert.match(ttsFn[0], /isNativeAvailable\(\)/);
    assert.match(ttsFn[0], /markNativeDown\(\)/);
    assert.match(ttsFn[0], /native-tts-failed/);
    assert.match(ttsFn[0], /ensureOffscreenDocument\(\)/);
    assert.match(ttsFn[0], /sendToOffscreen\(\{/);
  });

  it('routes voices-request to native /voices first, falling back to offscreen', () => {
    assert.match(backgroundJs, /fetch\(`\$\{NATIVE_BASE_URL\}\/voices`/);
    const voicesFn = backgroundJs.match(/async function handleVoicesRequest\([\s\S]*?\n}\n/);
    assert.ok(voicesFn, 'handleVoicesRequest not found');
    assert.match(voicesFn[0], /isNativeAvailable\(\)/);
    assert.match(voicesFn[0], /ok: true, voices: payload\.voices/);
    assert.match(voicesFn[0], /ensureOffscreenDocument\(\)/);
  });

  it('reports the native backend immediately for engine-status without touching offscreen', () => {
    const statusFn = backgroundJs.match(/async function handleEngineStatusRequest\([\s\S]*?\n}\n/);
    assert.ok(statusFn, 'handleEngineStatusRequest not found');
    assert.match(statusFn[0], /status: 'ready', backend: 'native', progress: 100, warm: true/);
    // The native branch must return before any offscreen call.
    const nativeBranch = statusFn[0].split(/status: 'ready', backend: 'native'/)[0];
    assert.doesNotMatch(nativeBranch, /ensureOffscreenDocument/);
    assert.match(statusFn[0], /backend = 'wasm'/);
  });

  it('gates offscreen creation in preWarmEngine on native availability', () => {
    const helper = backgroundJs.match(/async function preWarmEngine\(\)[\s\S]*?\n}\n/);
    assert.ok(helper, 'preWarmEngine helper not found');
    assert.match(helper[0], /isNativeAvailable\(\)/);
    assert.match(helper[0], /ensureOffscreenDocument\(\)/);
  });

  it('leaves tts-cancel routing to the offscreen queue only (native synths are cheap to waste)', () => {
    assert.match(backgroundJs, /native synths are ~1\.5s/i);
  });
});
