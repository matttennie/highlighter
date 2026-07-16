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

  it('does not warm the engine when the user only toggles highlight mode', () => {
    const start = backgroundJs.indexOf('function sendToggle(');
    const end = backgroundJs.indexOf('\nfunction sendToggleToActiveTab', start);
    assert.ok(start !== -1 && end > start, 'sendToggle not found');
    const sendToggle = backgroundJs.slice(start, end);
    assert.doesNotMatch(sendToggle, /preWarmEngine|openLeash|ensureOffscreenDocument/);
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
    assert.match(backgroundJs, /fetch\(`\$\{NATIVE_BASE_URL\}\/health`, \{ signal: AbortSignal\.timeout\(NATIVE_HEALTH_TIMEOUT_MS\) \}\)/);
    assert.match(backgroundJs, /now - nativeState\.checkedAt < NATIVE_RECHECK_MS/);
  });

  it('marks native down on failure so callers fall back to offscreen', () => {
    assert.match(backgroundJs, /function markNativeDown\(\)/);
    assert.match(backgroundJs, /nativeState = \{ available: false, checkedAt: Date\.now\(\) \}/);
    assert.match(backgroundJs, /function markNativeUnknown\(\)/);
    assert.match(backgroundJs, /nativeState = \{ available: null, checkedAt: 0 \}/);
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

  it('serves a static voice catalog without starting either backend', () => {
    const voicesFn = backgroundJs.match(/async function handleVoicesRequest\([\s\S]*?\n}\n/);
    assert.ok(voicesFn, 'handleVoicesRequest not found');
    assert.match(backgroundJs, /const VOICE_CATALOG = VOICE_GROUPS\.flatMap/);
    const catalogSource = backgroundJs.slice(
      backgroundJs.indexOf('const VOICE_GROUPS'),
      backgroundJs.indexOf('// Native companion server'),
    );
    const voiceIds = [...catalogSource.matchAll(/'([a-z]{2}_[a-z0-9]+)'/g)].map((match) => match[1]);
    assert.equal(voiceIds.length, 54);
    assert.equal(new Set(voiceIds).size, 54);
    assert.ok(voiceIds.includes('bf_emma'));
    assert.match(voicesFn[0], /ok: true, voices: VOICE_CATALOG/);
    assert.doesNotMatch(voicesFn[0], /openLeash|isNativeAvailable|ensureOffscreenDocument|sendToOffscreen|fetch/);
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

  it('supports a side-effect-free status peek that never starts either backend', () => {
    const helper = backgroundJs.match(/async function handleEngineStatusRequest\([^)]*\)[\s\S]*?\n}\n/);
    assert.ok(helper, 'handleEngineStatusRequest helper not found');
    const peekBranch = helper[0].slice(0, helper[0].indexOf('\n  openLeash('));
    assert.match(peekBranch, /if \(!wake\)/);
    assert.match(peekBranch, /getContexts\(\{ contextTypes: \['OFFSCREEN_DOCUMENT'\] \}\)/);
    assert.match(peekBranch, /status: 'idle', backend: 'wasm'/);
    assert.doesNotMatch(peekBranch, /openLeash\(|isNativeAvailable\(|ensureOffscreenDocument\(/);
    assert.match(backgroundJs, /wake: msg\.wake !== false/);
    assert.match(backgroundJs, /nativeOnly: msg\.nativeOnly === true/);
    assert.match(backgroundJs, /retryNative: msg\.retryNative === true/);
  });

  it('starts only the native leash for a native-only waking status request', () => {
    const helper = backgroundJs.match(/async function handleEngineStatusRequest\([^)]*\)[\s\S]*?\n}\n/);
    assert.ok(helper, 'handleEngineStatusRequest helper not found');
    assert.match(helper[0], /nativeOnly = false/);
    assert.match(helper[0], /retryNative = false/);
    assert.match(helper[0], /openLeash\(nativeOnly && retryNative\);[\s\S]*?if \(nativeOnly\)/);
    const nativeOnlyBranch = helper[0].match(/if \(nativeOnly\) \{[\s\S]*?\n  \}/);
    assert.ok(nativeOnlyBranch, 'native-only wake branch not found');
    assert.match(nativeOnlyBranch[0], /status: 'starting', backend: 'native'/);
    assert.match(nativeOnlyBranch[0], /status: 'unavailable', backend: 'native'/);
    assert.match(nativeOnlyBranch[0], /if \(await isNativeAvailable\(\)\)/);
    assert.doesNotMatch(nativeOnlyBranch[0], /ensureOffscreenDocument|sendToOffscreen/);
  });

  it('leaves tts-cancel routing to the offscreen queue only (native synths are cheap to waste)', () => {
    assert.match(backgroundJs, /native synths are ~1\.5s/i);
  });
});

describe('native-messaging server leash', () => {
  it('names the host and leash timing constants', () => {
    assert.match(backgroundJs, /const NATIVE_HOST\s*=\s*'com\.highlighter\.kokoro'/);
    assert.match(backgroundJs, /const LEASH_PING_MS\s*=\s*25000/);
    assert.match(backgroundJs, /const LEASH_UNAVAILABLE_BACKOFF_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  });

  it('declares the leash state machine', () => {
    assert.match(backgroundJs, /let nativePort\s*=\s*null/);
    assert.match(backgroundJs, /let leashState\s*=\s*'closed'/);
    assert.match(backgroundJs, /let leashPingInterval\s*=\s*null/);
    assert.match(backgroundJs, /let leashUnavailableAt\s*=\s*0/);
  });

  it('openLeash is idempotent and never opens a second port', () => {
    const fn = backgroundJs.match(/function openLeash\([^)]*\)[\s\S]*?\n}\n/);
    assert.ok(fn, 'openLeash not found');
    // no-op while already opening/open, and never a duplicate when a port lives
    assert.match(fn[0], /if \(leashState === 'open' \|\| leashState === 'opening'\) return/);
    assert.match(fn[0], /if \(nativePort\) return/);
    // backoff while unavailable
    assert.match(fn[0], /!retryUnavailable && leashState === 'unavailable'/);
    assert.match(fn[0], /Date\.now\(\) - leashUnavailableAt < LEASH_UNAVAILABLE_BACKOFF_MS/);
    // spawns the host via connectNative
    assert.match(fn[0], /native-leash-opening/);
    assert.match(fn[0], /chrome\.runtime\.connectNative\(NATIVE_HOST\)/);
  });

  it('server-status ok forces native availability; not-ok backs off to WASM', () => {
    const fn = backgroundJs.match(/function openLeash\([^)]*\)[\s\S]*?\n}\n/);
    assert.match(fn[0], /msg\.type !== 'server-status'/);
    assert.match(fn[0], /nativeState = \{ available: true, checkedAt: Date\.now\(\) \}/);
    assert.match(fn[0], /markNativeDown\(\)/);
    assert.match(fn[0], /nativePort\?\.disconnect\(\)/);
  });

  it('onDisconnect marks native down and reopens only if it had opened', () => {
    const fn = backgroundJs.match(/function openLeash\([^)]*\)[\s\S]*?\n}\n/);
    assert.match(fn[0], /onDisconnect\.addListener/);
    assert.match(fn[0], /const hadOpened = leashState === 'open'/);
    assert.match(fn[0], /leashState = hadOpened \? 'closed' : 'unavailable'/);
    assert.match(fn[0], /nativePort = null/);
    assert.match(fn[0], /clearInterval\(leashPingInterval\)/);
    assert.match(fn[0], /hadOpened[\s\S]*?markNativeDown\(\)[\s\S]*?markNativeUnknown\(\)/);
  });

  it('keeps the SW alive with a 25s ping under the native port', () => {
    const fn = backgroundJs.match(/function openLeash\([^)]*\)[\s\S]*?\n}\n/);
    assert.match(fn[0], /setInterval\(\(\)\s*=>\s*\{[\s\S]*?nativePort\?\.postMessage\(\{ type: 'ping' \}\)[\s\S]*?\},\s*LEASH_PING_MS\)/);
  });

  it('opens the leash on synthesis and explicit waking-status paths', () => {
    for (const name of ['handleTtsRequest', 'handleEngineStatusRequest']) {
      const fn = backgroundJs.match(new RegExp(`async function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n}\\n`));
      assert.ok(fn, `${name} not found`);
      assert.match(fn[0], /openLeash\(/, `${name} must openLeash`);
    }
  });
});
