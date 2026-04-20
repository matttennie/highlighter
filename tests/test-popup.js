import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');
const popupHtml = fs.readFileSync(path.join(rootDir, 'popup', 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(rootDir, 'popup', 'popup.js'), 'utf8');
const backgroundJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

describe('popup.html', () => {
  it('associates labels with form controls', () => {
    for (const id of ['inworldApiToken', 'modelId', 'defaultVoice', 'defaultSpeed', 'articleMode']) {
      assert.match(popupHtml, new RegExp(`<label[^>]*for="${id}"`, 'i'));
    }
  });

  it('renders Inworld-specific hints', () => {
    assert.match(popupHtml, /id="providerHint"/i);
    assert.match(popupHtml, /Inworld API Key/i);
    assert.match(popupHtml, /voices returned by the Inworld API/i);
    assert.match(popupHtml, /<select id="defaultVoice"><\/select>/i);
  });

  it('does not reference ElevenLabs anywhere', () => {
    assert.doesNotMatch(popupHtml, /elevenlabs/i);
  });
});

describe('popup.js', () => {
  it('debounces transient status clearing so newer messages are not cleared early', () => {
    assert.match(popupJs, /clearTimeout\(statusTimer\)/);
    assert.match(popupJs, /statusTimer\s*=\s*setTimeout/);
  });

  it('persists the Inworld API key on input and blur instead of only on change', () => {
    assert.match(popupJs, /inworldTokenInput\.addEventListener\('input',\s*saveInworldTokenSoon\)/);
    assert.match(popupJs, /inworldTokenInput\.addEventListener\('blur'/);
  });

  it('loads voice options dynamically from the background worker', () => {
    assert.match(popupJs, /chrome\.runtime\.sendMessage\(\{ type: 'voices-request' \}/);
    assert.match(popupJs, /function isSupportedModelId\(modelId\)/);
    assert.match(popupJs, /function setDefaultVoice\(voiceId\)/);
  });

  it('resets stale ElevenLabs-shaped voice IDs on load', () => {
    assert.match(popupJs, /function looksLikeLegacyVoiceId/);
    assert.match(popupJs, /stale-voice-reset-on-load/);
  });

  it('does not reference ElevenLabs API keys or models', () => {
    assert.doesNotMatch(popupJs, /\belApiKey\b/);
    assert.doesNotMatch(popupJs, /eleven_flash|eleven_turbo|eleven_multilingual/);
    assert.doesNotMatch(popupJs, /xi-api-key/);
  });
});

describe('default voice ID consistency', () => {
  it('uses the same default voice ID in popup.js and background.js', () => {
    const popupMatch = popupJs.match(/DEFAULT_VOICE_ID\s*=\s*'([^']+)'/);
    const bgMatch = backgroundJs.match(/DEFAULT_VOICE_ID\s*=\s*'([^']+)'/);
    assert.ok(popupMatch, 'popup.js should define DEFAULT_VOICE_ID');
    assert.ok(bgMatch, 'background.js should define DEFAULT_VOICE_ID');
    assert.equal(popupMatch[1], bgMatch[1], 'DEFAULT_VOICE_ID must match across files');
    assert.equal(popupMatch[1], 'Ashley', 'DEFAULT_VOICE_ID should be an Inworld voice name');
  });
});
