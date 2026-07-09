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
