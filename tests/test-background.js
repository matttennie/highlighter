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
    assert.doesNotMatch(backgroundJs, /fetch\(/);
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
    assert.match(backgroundJs, /function sendToggle\([\s\S]{0,200}?void ensureOffscreenDocument\(\)/);
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
