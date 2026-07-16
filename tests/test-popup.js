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

  it('wakes only the native server and does not enumerate voices when the popup opens', () => {
    assert.match(
      popupJs,
      /refreshEngineStatus\(\{ wake: true, nativeOnly: true, retryNative: true \}\)/,
    );
    const initialization = popupJs.match(
      /chrome\.storage\.local\.get\(\['defaultVoice'[\s\S]*?\n}\);\n\nfunction showStatus/,
    );
    assert.ok(initialization, 'settings initialization callback not found');
    assert.doesNotMatch(initialization[0], /loadVoices\(/);
    assert.match(popupJs, /engine-status-request', wake, nativeOnly, retryNative/);
  });

  it('loads the full voice catalog only when the voice selector is engaged', () => {
    assert.match(popupJs, /voiceSelect\.addEventListener\('focus', requestVoiceCatalog\)/);
    assert.match(popupJs, /voiceSelect\.addEventListener\('pointerdown', requestVoiceCatalog\)/);
    assert.match(popupJs, /voiceCatalogLoaded/);
    assert.match(popupJs, /voicesLoading/);
  });

  it('polls engine status while the model downloads', () => {
    assert.match(popupJs, /engine-status-request/);
    assert.match(popupJs, /Downloading voice model/);
    assert.match(popupJs, /scheduleEnginePoll/);
  });

  it('polls native startup without switching the poll to the WASM fallback', () => {
    assert.match(popupJs, /case 'starting':[\s\S]*?Starting native Kokoro server/);
    assert.match(popupJs, /scheduleEnginePoll\(\{ nativeOnly: true \}\)/);
    assert.match(popupJs, /Native server unavailable — built-in engine starts on Play/);
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

  it('reports the WASM thread count when the origin is isolated', () => {
    assert.match(popupJs, /CPU, \$\{resp\.threads \|\| '\?'\} threads/);
  });

  it('warns that single-thread mode is slow when not isolated', () => {
    assert.match(popupJs, /resp\.isolated === false/);
    assert.match(popupJs, /single-thread — slow/);
  });

  it('drops the stale GPU status branch (device is always CPU now)', () => {
    assert.doesNotMatch(popupJs, /on-device \(GPU\)/);
  });

  it('says "Waking up" instead of "Downloading" when weights are warm', () => {
    assert.match(popupJs, /resp\.warm/);
    assert.match(popupJs, /Waking up voice engine — \$\{resp\.progress \|\| 0\}%/);
  });

  it('reports the native Kokoro server distinctly from the WASM engine', () => {
    assert.match(popupJs, /resp\.backend === 'native'/);
    assert.match(popupJs, /Ready — native Kokoro server/);
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
      assert.equal(match[1], 'bf_emma', `${name} DEFAULT_VOICE_ID`);
    }
  });
});
