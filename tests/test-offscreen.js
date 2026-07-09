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
    assert.match(engineJs, /device: 'webgpu', dtype: 'fp16'/);
    assert.match(engineJs, /device: 'wasm', dtype: 'q8'/);
    assert.match(engineJs, /navigator\.gpu\.requestAdapter\(\)/);
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
