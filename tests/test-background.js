import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');
const backgroundJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

function normalizeSpeed(speed) {
  const parsed = parseFloat(speed);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0.7, Math.min(1.2, parsed));
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

  it('handles dynamic voice-list requests', () => {
    assert.match(backgroundJs, /if \(msg\.type === 'voices-request'\)/);
    assert.match(backgroundJs, /async function handleVoicesRequest\(\)/);
    assert.match(backgroundJs, /https:\/\/api\.elevenlabs\.io\/v1\/voices/);
  });

  it('requires an ElevenLabs-style key prefix', () => {
    assert.match(backgroundJs, /apiKey\.startsWith\('sk_'\)/);
    assert.match(backgroundJs, /Use an ElevenLabs API key that starts with sk_\./);
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

  it('clamps speeds to the supported range', () => {
    assert.equal(normalizeSpeed(0.1), 0.7);
    assert.equal(normalizeSpeed(1.1), 1.1);
    assert.equal(normalizeSpeed(3), 1.2);
  });
});

describe('text length validation', () => {
  it('enforces a maximum text length of 5000 characters', () => {
    assert.match(backgroundJs, /MAX_TEXT_LENGTH\s*=\s*5000/);
    assert.match(backgroundJs, /normalizedText\.length > MAX_TEXT_LENGTH/);
  });
});

describe('speed in API body', () => {
  it('includes speed in voice_settings', () => {
    assert.match(backgroundJs, /voice_settings/);
    assert.match(backgroundJs, /speed:\s*normalizedSpeed/);
  });
});

describe('error response JSON parsing', () => {
  it('parses error responses as JSON', () => {
    assert.match(backgroundJs, /\.json\(\)/);
    assert.match(backgroundJs, /async function parseErrorDetail\(res\)/);
  });
});

describe('ElevenLabs request path', () => {
  it('posts text-to-speech requests to ElevenLabs', () => {
    assert.match(backgroundJs, /https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech/);
    assert.match(backgroundJs, /'xi-api-key': apiKey/);
  });

  it('falls back to a supported model when storage contains a stale one', () => {
    assert.match(backgroundJs, /const SUPPORTED_MODEL_IDS = new Set/);
    assert.match(backgroundJs, /SUPPORTED_MODEL_IDS\.has\(data\.modelId\) \? data\.modelId : DEFAULT_MODEL_ID/);
  });

  it('filters voice results down to selectable voices', () => {
    assert.match(backgroundJs, /function isSelectableVoice\(voice\)/);
    assert.match(backgroundJs, /voice\.category === 'premade'/);
    assert.match(backgroundJs, /voice\.is_owner/);
    assert.match(backgroundJs, /payload\.voices\s*\.filter\(isSelectableVoice\)/s);
  });
});

describe('AbortController timeout', () => {
  it('uses AbortController for request timeouts', () => {
    assert.match(backgroundJs, /AbortController/);
    assert.match(backgroundJs, /controller\.abort\(\)/);
    assert.match(backgroundJs, /signal:\s*controller\.signal/);
  });
});
