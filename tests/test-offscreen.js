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

  it('synthesizes on CPU only — WebGPU is disabled for audio quality', () => {
    assert.match(engineJs, /device: 'wasm', dtype: 'q8'/);
    assert.doesNotMatch(engineJs, /device: 'webgpu'/);
    assert.doesNotMatch(engineJs, /requestAdapter/);
  });

  it('warms up the graph before reporting ready and cools down after idle', () => {
    assert.match(engineJs, /WARMUP_TEXT = 'Warming up\.'/);
    assert.match(engineJs, /IDLE_COOLDOWN_MS = 15 \* 60 \* 1000/);
    assert.match(engineJs, /window\.close\(\)/);
    assert.match(engineJs, /activeSynths > 0\) return;/);
  });

  it('produces WAV data URLs and uses the shared default voice', () => {
    assert.match(engineJs, /data:audio\/wav;base64,/);
    assert.match(engineJs, /DEFAULT_VOICE_ID = 'bf_emma'/);
  });

  it('reports model-loading with progress while the model downloads', () => {
    assert.match(engineJs, /error: 'model-loading'/);
    assert.match(engineJs, /progress: engineStatus\.progress/);
  });

  it('guards ORT threading on crossOriginIsolated', () => {
    assert.match(engineJs, /crossOriginIsolated/);
  });
});

describe('offscreen WASM threading (Wave B)', () => {
  it('raises threads on isolated origins but caps oversubscription at 8', () => {
    assert.match(engineJs, /const wasmThreads = globalThis\.crossOriginIsolated/);
    assert.match(engineJs, /Math\.max\(1, Math\.min\(8, \(navigator\.hardwareConcurrency \|\| 4\) - 1\)\)/);
  });

  it('forces a single thread when the origin is not cross-origin isolated', () => {
    assert.match(
      engineJs,
      /crossOriginIsolated\s*\?\s*Math\.max\(1, Math\.min\(8, \(navigator\.hardwareConcurrency \|\| 4\) - 1\)\)\s*:\s*1;/,
    );
    assert.match(engineJs, /env\.backends\.onnx\.wasm\.numThreads = wasmThreads/);
  });

  it('reports isolation and thread count in the engine-status response', () => {
    assert.match(engineJs, /isolated: globalThis\.crossOriginIsolated === true/);
    assert.match(engineJs, /threads: wasmThreads/);
  });
});

describe('offscreen tts-cancel protocol (Wave B)', () => {
  it('maintains a cancelledIds set with a size guard that trims (not clears) oldest ids', () => {
    assert.match(engineJs, /const cancelledIds = new Set\(\)/);
    assert.match(engineJs, /cancelledIds\.size > 500/);
    // Trimming preserves ids added by the same message; a hard clear would drop them.
    assert.doesNotMatch(engineJs, /cancelledIds\.clear\(\)/);
    assert.match(engineJs, /cancelledIds\.delete\(it\.next\(\)\.value\)/);
  });

  it('records ids from a tts-cancel message', () => {
    assert.match(engineJs, /msg\.type === 'tts-cancel'/);
    assert.match(engineJs, /cancelledIds\.add\(id\)/);
  });

  it('captures the clientRequestId and skips a cancelled job before generating', () => {
    assert.match(engineJs, /const id = msg\.clientRequestId/);
    assert.match(engineJs, /if \(id && cancelledIds\.has\(id\)\)/);
    assert.match(engineJs, /error: 'cancelled'/);
  });
});

describe('offscreen warmup + warm-status (Wave B)', () => {
  it('warms with the stored voice, not only the hardcoded default', () => {
    assert.match(engineJs, /chrome\.storage\.local\.get\(\['defaultVoice'\]/);
    assert.match(engineJs, /resolveVoice\(storedVoice \|\| DEFAULT_VOICE_ID\)/);
  });

  it('persists kokoroLoadedOnce and exposes warm status', () => {
    assert.match(engineJs, /chrome\.storage\.local\.set\(\{ kokoroLoadedOnce: true \}/);
    assert.match(engineJs, /getKokoroLoadedOnce/);
    assert.match(engineJs, /warm/);
  });

  it('includes warm in the initial and error engineStatus shapes for cross-context uniformity', () => {
    assert.match(engineJs, /status: 'idle',[^}]*warm: false/);
    assert.match(engineJs, /status: 'error',[^}]*warm: false/);
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
