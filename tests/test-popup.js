import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');
const popupHtml = fs.readFileSync(path.join(rootDir, 'popup', 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(rootDir, 'popup', 'popup.js'), 'utf8');

describe('popup.html', () => {
  it('associates labels with form controls', () => {
    for (const id of ['apiToken', 'modelId', 'defaultVoice', 'defaultSpeed', 'articleMode']) {
      assert.match(popupHtml, new RegExp(`<label[^>]*for="${id}"`, 'i'));
    }
  });

  it('renders an empty voice select that is populated dynamically', () => {
    assert.match(popupHtml, /<select id="defaultVoice"><\/select>/i);
    assert.match(popupHtml, /The list is loaded from ElevenLabs when your API key allows it\./i);
  });
});

describe('popup.js', () => {
  it('debounces transient status clearing so newer messages are not cleared early', () => {
    assert.match(popupJs, /clearTimeout\(statusTimer\)/);
    assert.match(popupJs, /statusTimer\s*=\s*setTimeout/);
  });

  it('persists the API key on input and blur instead of only on change', () => {
    assert.match(popupJs, /tokenInput\.addEventListener\('input',\s*saveTokenSoon\)/);
    assert.match(popupJs, /tokenInput\.addEventListener\('blur'/);
  });

  it('loads voice options dynamically from the background worker', () => {
    assert.match(popupJs, /chrome\.runtime\.sendMessage\(\{ type: 'voices-request' \}/);
    assert.match(popupJs, /ensureVoiceOption\(data\.defaultVoice \|\| DEFAULT_VOICE_ID, 'Configured voice'\)/);
  });
});
