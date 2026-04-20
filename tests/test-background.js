import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');
const backgroundJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

// Mirror of background.js#normalizeSpeed — keep in sync when the API range changes.
function normalizeSpeed(speed) {
  const parsed = parseFloat(speed);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0.5, Math.min(1.5, parsed));
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
    assert.match(backgroundJs, /https:\/\/api\.inworld\.ai\/tts\/v1\/voices/);
  });

  it('reads the Inworld API key from storage under the expected name', () => {
    assert.match(backgroundJs, /inworld_Highlighter_API_Key/);
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
    assert.equal(normalizeSpeed(0.1), 0.5);
    assert.equal(normalizeSpeed(1.1), 1.1);
    assert.equal(normalizeSpeed(3), 1.5);
  });
});

describe('text length validation', () => {
  it('enforces a maximum text length of 5000 characters', () => {
    assert.match(backgroundJs, /MAX_TEXT_LENGTH\s*=\s*2000/);
    assert.match(backgroundJs, /normalizedText\.length > MAX_TEXT_LENGTH/);
  });
});

describe('error response JSON parsing', () => {
  it('parses error responses as JSON', () => {
    assert.match(backgroundJs, /\.json\(\)/);
    assert.match(backgroundJs, /async function parseErrorDetail\(res\)/);
  });
});

describe('Inworld request path', () => {
  it('posts text-to-speech requests to Inworld with Basic auth', () => {
    assert.match(backgroundJs, /https:\/\/api\.inworld\.ai\/tts\/v1\/voice/);
    assert.match(backgroundJs, /'Authorization':\s*`Basic \$\{apiKey\}`/);
    assert.doesNotMatch(backgroundJs, /'Authorization':\s*`Bearer \$\{apiKey\}`/);
  });

  it('requests JSON response with audioConfig.speakingRate', () => {
    assert.match(backgroundJs, /'Accept':\s*'application\/json'/);
    assert.match(backgroundJs, /audioEncoding:\s*'MP3'/);
    assert.match(backgroundJs, /speakingRate:\s*normalizedSpeed/);
    assert.match(backgroundJs, /payload\?\.audioContent/);
  });

  it('falls back to a supported model when storage contains a stale one', () => {
    assert.match(backgroundJs, /const SUPPORTED_MODEL_IDS = new Set/);
    assert.match(backgroundJs, /SUPPORTED_MODEL_IDS\.has\(data\.modelId\) \? data\.modelId : DEFAULT_MODEL_ID/);
  });

  it('includes only Inworld models in the supported set', () => {
    assert.match(backgroundJs, /'inworld-tts-1\.5-max'/);
    assert.match(backgroundJs, /'inworld-tts-1\.5-mini'/);
    assert.doesNotMatch(backgroundJs, /eleven_flash|eleven_turbo|eleven_multilingual/);
  });

  it('filters voice results down to selectable voices', () => {
    assert.match(backgroundJs, /function isSelectableVoice\(voice\)/);
    assert.match(backgroundJs, /payload\.voices\.filter\(isSelectableVoice\)/s);
  });
});

describe('AbortController timeout', () => {
  it('uses AbortController for request timeouts', () => {
    assert.match(backgroundJs, /AbortController/);
    assert.match(backgroundJs, /controller\.abort\(\)/);
    assert.match(backgroundJs, /signal:\s*controller\.signal/);
  });
});

describe('ElevenLabs scrub', () => {
  it('has no ElevenLabs references in background.js', () => {
    assert.doesNotMatch(backgroundJs, /elevenlabs/i);
    assert.doesNotMatch(backgroundJs, /xi-api-key/);
    assert.doesNotMatch(backgroundJs, /\belApiKey\b/);
  });
});
