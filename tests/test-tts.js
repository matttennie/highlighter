/**
 * Tests for TTS integration logic.
 * Covers: error message mapping, playback state transitions,
 * stale request guard, playback-rate normalization, and base64 encoding.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');

// ── Error message mapping (mirrors content.js) ─────────────────────

function getErrorMessage(response) {
  if (!response) return 'No response from background';
  switch (response.error) {
    case 'empty-text':        return 'Select some text before playing';
    case 'text-too-long':     return response.detail || 'Text exceeds maximum length';
    case 'model-loading':     return typeof response.progress === 'number' && response.progress > 0
      ? `Voice model downloading (${response.progress}%) — using system voice meanwhile`
      : 'Voice model loading — using system voice meanwhile';
    case 'engine-error':      return response.detail
      ? `Voice engine error\n${truncateDetail(response.detail)}`
      : 'Voice engine error — using system voice';
    case 'synthesis-failed':  return response.detail
      ? `Synthesis failed\n${truncateDetail(response.detail)}`
      : 'Synthesis failed — using system voice';
    case 'timeout':           return 'Request timed out — try again';
    case 'no-response':       return 'Voice engine did not respond — using system voice';
    case 'cancelled':         return 'Cancelled';
    default:                  return response.error || 'Unknown error';
  }
}

function truncateDetail(detail) {
  const text = typeof detail === 'string' ? detail.trim() : '';
  if (!text) return 'Unknown upstream error';
  return text.length > 140 ? text.slice(0, 137) + '...' : text;
}

describe('getErrorMessage', () => {
  it('handles null response', () => {
    assert.equal(getErrorMessage(null), 'No response from background');
  });

  it('handles undefined response', () => {
    assert.equal(getErrorMessage(undefined), 'No response from background');
  });

  it('maps empty-text', () => {
    assert.match(getErrorMessage({ error: 'empty-text' }), /select some text/i);
  });

  it('maps text-too-long with detail', () => {
    const msg = getErrorMessage({ error: 'text-too-long', detail: 'Text is 6000 characters; maximum is 5000.' });
    assert.match(msg, /6000/);
  });

  it('maps text-too-long without detail', () => {
    const msg = getErrorMessage({ error: 'text-too-long' });
    assert.match(msg, /exceeds maximum/i);
  });

  it('maps timeout', () => {
    assert.match(getErrorMessage({ error: 'timeout' }), /timed out/i);
  });

  it('maps no-response', () => {
    assert.match(getErrorMessage({ error: 'no-response' }), /did not respond/i);
  });

  it('maps cancelled quietly (Wave B forward-compat)', () => {
    assert.equal(getErrorMessage({ error: 'cancelled' }), 'Cancelled');
  });

  it('maps model-loading with progress', () => {
    const msg = getErrorMessage({ error: 'model-loading', progress: 43 });
    assert.match(msg, /43%/);
    assert.match(msg, /system voice/i);
  });

  it('maps model-loading without progress', () => {
    assert.match(getErrorMessage({ error: 'model-loading' }), /loading/i);
  });

  it('maps engine-error with detail', () => {
    const msg = getErrorMessage({ error: 'engine-error', detail: 'WebGPU adapter lost' });
    assert.match(msg, /engine error/i);
    assert.match(msg, /WebGPU adapter lost/);
  });

  it('maps synthesis-failed', () => {
    assert.match(getErrorMessage({ error: 'synthesis-failed' }), /synthesis failed/i);
  });

  it('falls back to error string for unknown codes', () => {
    assert.equal(getErrorMessage({ error: 'custom-error' }), 'custom-error');
  });

  it('returns "Unknown error" for empty error field', () => {
    assert.equal(getErrorMessage({ error: '' }), 'Unknown error');
  });
});

describe('error-code contract', () => {
  it('every error code the background/offscreen can emit has a friendly mapping in content.js', () => {
    const contentJs = fs.readFileSync(path.join(rootDir, 'content', 'content.js'), 'utf8');
    for (const code of ['empty-text', 'text-too-long', 'model-loading', 'engine-error', 'synthesis-failed', 'no-response']) {
      assert.match(contentJs, new RegExp(`case '${code}':`), `content.js getErrorMessage must map '${code}'`);
    }
  });
});

// ── truncateDetail ───────────────────────────────────────────────────

describe('truncateDetail', () => {
  it('returns a placeholder for empty detail', () => {
    assert.equal(truncateDetail('   '), 'Unknown upstream error');
  });

  it('returns a placeholder for non-string detail', () => {
    assert.equal(truncateDetail(null), 'Unknown upstream error');
    assert.equal(truncateDetail(undefined), 'Unknown upstream error');
    assert.equal(truncateDetail(42), 'Unknown upstream error');
  });

  it('passes through short detail strings unchanged', () => {
    assert.equal(truncateDetail('Something went wrong'), 'Something went wrong');
  });

  it('truncates long detail strings at 140 characters', () => {
    const msg = truncateDetail('x'.repeat(200));
    assert.equal(msg.length, 140);
    assert.ok(msg.endsWith('...'));
    assert.equal(msg, 'x'.repeat(137) + '...');
  });

  it('does not truncate strings exactly at 140 characters', () => {
    const input = 'a'.repeat(140);
    assert.equal(truncateDetail(input), input);
  });
});

// ── Playback state machine transitions ──────────────────────────────

const VALID_TRANSITIONS = {
  idle:    ['loading'],
  loading: ['playing', 'error', 'idle'],
  playing: ['paused', 'loading', 'idle'],
  paused:  ['playing', 'loading', 'idle'],
  error:   ['loading', 'idle'],
};

function isValidTransition(from, to) {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

describe('Playback state transitions', () => {
  it('idle -> loading (play pressed)', () => {
    assert.ok(isValidTransition('idle', 'loading'));
  });

  it('idle -> playing is INVALID (must go through loading)', () => {
    assert.ok(!isValidTransition('idle', 'playing'));
  });

  it('loading -> playing (audio ready)', () => {
    assert.ok(isValidTransition('loading', 'playing'));
  });

  it('loading -> error (API failure)', () => {
    assert.ok(isValidTransition('loading', 'error'));
  });

  it('loading -> idle (user cancels)', () => {
    assert.ok(isValidTransition('loading', 'idle'));
  });

  it('playing -> paused', () => {
    assert.ok(isValidTransition('playing', 'paused'));
  });

  it('playing -> loading (auto-advance to next sentence)', () => {
    assert.ok(isValidTransition('playing', 'loading'));
  });

  it('playing -> idle (dismissed)', () => {
    assert.ok(isValidTransition('playing', 'idle'));
  });

  it('paused -> playing (resume)', () => {
    assert.ok(isValidTransition('paused', 'playing'));
  });

  it('paused -> loading (skip while paused)', () => {
    assert.ok(isValidTransition('paused', 'loading'));
  });

  it('error -> loading (retry)', () => {
    assert.ok(isValidTransition('error', 'loading'));
  });

  it('error -> idle (dismissed)', () => {
    assert.ok(isValidTransition('error', 'idle'));
  });

  it('error -> playing is INVALID', () => {
    assert.ok(!isValidTransition('error', 'playing'));
  });
});

// ── Stale request ID guard ──────────────────────────────────────────

describe('Request ID staleness guard', () => {
  let pbRequestId = 0;

  it('matching requestId allows response to proceed', () => {
    const id = ++pbRequestId;
    assert.equal(id, pbRequestId);
  });

  it('incrementing pbRequestId invalidates old id', () => {
    const oldId = pbRequestId;
    pbRequestId++;
    assert.notEqual(oldId, pbRequestId);
  });

  it('rapid sequential requests only honor the latest', () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(++pbRequestId);
    for (let i = 0; i < ids.length - 1; i++) {
      assert.notEqual(ids[i], pbRequestId, `request ${i} should be stale`);
    }
    assert.equal(ids[ids.length - 1], pbRequestId);
  });
});

// ── Playback-rate normalization (from content.js/background.js) ──────────────

function normalizePlaybackRate(speed) {
  const parsed = parseFloat(speed);
  if (!Number.isFinite(parsed)) return 1.0;
  return Math.max(0.5, Math.min(2.0, parsed));
}

describe('normalizePlaybackRate', () => {
  it('defaults invalid input to 1.0', () => {
    assert.equal(normalizePlaybackRate('abc'), 1.0);
    assert.equal(normalizePlaybackRate(undefined), 1.0);
    assert.equal(normalizePlaybackRate(null), 1.0);
    assert.equal(normalizePlaybackRate(NaN), 1.0);
    assert.equal(normalizePlaybackRate(Infinity), 1.0);
  });

  it('clamps values below minimum to 0.5', () => {
    assert.equal(normalizePlaybackRate(0.25), 0.5);
    assert.equal(normalizePlaybackRate(0), 0.5);
    assert.equal(normalizePlaybackRate(-1), 0.5);
  });

  it('preserves in-range values', () => {
    assert.equal(normalizePlaybackRate('1.1'), 1.1);
    assert.equal(normalizePlaybackRate(0.5), 0.5);
    assert.equal(normalizePlaybackRate(1.5), 1.5);
    assert.equal(normalizePlaybackRate(1), 1.0);
  });

  it('clamps values above maximum to 2.0', () => {
    assert.equal(normalizePlaybackRate(3), 2.0);
    assert.equal(normalizePlaybackRate(2.1), 2.0);
    assert.equal(normalizePlaybackRate(100), 2.0);
  });
});

// ── Base64 encoding (from background.js) ────────────────────────────

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

describe('arrayBufferToBase64', () => {
  it('encodes empty buffer', () => {
    assert.equal(arrayBufferToBase64(new ArrayBuffer(0)), '');
  });

  it('encodes small buffer correctly', () => {
    const buf = new Uint8Array([72, 101, 108, 108, 111]).buffer; // "Hello"
    assert.equal(arrayBufferToBase64(buf), btoa('Hello'));
  });

  it('round-trips through atob correctly', () => {
    const original = 'The quick brown fox jumps over the lazy dog';
    const bytes = new TextEncoder().encode(original);
    const base64 = arrayBufferToBase64(bytes.buffer);
    const decoded = atob(base64);
    assert.equal(decoded, original);
  });

  it('handles buffer larger than chunk size (8192)', () => {
    const size = 20000;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = i % 256;

    const base64 = arrayBufferToBase64(data.buffer);
    const decoded = atob(base64);
    assert.equal(decoded.length, size);
    for (let i = 0; i < size; i++) {
      assert.equal(decoded.charCodeAt(i), i % 256);
    }
  });

  it('handles binary data with null bytes', () => {
    const buf = new Uint8Array([0, 0, 0, 255, 255]).buffer;
    const base64 = arrayBufferToBase64(buf);
    const decoded = atob(base64);
    assert.equal(decoded.charCodeAt(0), 0);
    assert.equal(decoded.charCodeAt(3), 255);
    assert.equal(decoded.charCodeAt(4), 255);
  });

  it('produces valid data URI when combined with prefix', () => {
    const buf = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer; // "RIFF" (WAV header)
    const base64 = arrayBufferToBase64(buf);
    const dataUri = `data:audio/wav;base64,${base64}`;
    assert.ok(dataUri.startsWith('data:audio/wav;base64,'));
    assert.equal(atob(base64), 'RIFF');
  });
});

// ── splitLongSentenceText (mirrors content.js) ───────────────────────

// Mirror of content.js#splitLongSentenceText — keep byte-identical.
// Split text into chunks of at most `limit` chars, preferring clause
// boundaries (,;:—) and falling back to the last space before the limit.
function splitLongSentenceText(text, limit) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length <= limit) return trimmed ? [trimmed] : [];
  const chunks = [];
  let rest = trimmed;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = -1;
    for (const m of window.matchAll(/[,;:—]/g)) cut = m.index;
    if (cut < 1) cut = window.lastIndexOf(' ');
    if (cut < 1) cut = limit - 1; // no boundary at all — hard split
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

describe('splitLongSentenceText', () => {
  it('returns short text unchanged', () => {
    assert.deepEqual(splitLongSentenceText('Hello world.', 400), ['Hello world.']);
  });

  it('returns empty array for empty/whitespace text', () => {
    assert.deepEqual(splitLongSentenceText('   ', 400), []);
  });

  it('splits at the last clause boundary before the limit', () => {
    const chunks = splitLongSentenceText('aaaa, bbbb; cccc dddd', 12);
    assert.deepEqual(chunks, ['aaaa, bbbb;', 'cccc dddd']);
  });

  it('falls back to the last space when no clause boundary exists', () => {
    const chunks = splitLongSentenceText('aaaa bbbb cccc', 11);
    assert.deepEqual(chunks, ['aaaa bbbb', 'cccc']);
  });

  it('hard-splits unbroken runs with no boundaries', () => {
    const chunks = splitLongSentenceText('a'.repeat(25), 10);
    assert.ok(chunks.every((c) => c.length <= 10));
    assert.equal(chunks.join(''), 'a'.repeat(25));
  });

  it('never emits a chunk above the limit and loses no words', () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunks = splitLongSentenceText(text, 80);
    assert.ok(chunks.every((c) => c.length <= 80));
    assert.deepEqual(chunks.join(' ').split(/\s+/), words);
  });

  it('adds a source-contract check that content.js applies chunking at the assignment site', () => {
    const contentJs = fs.readFileSync(path.join(rootDir, 'content', 'content.js'), 'utf8');
    assert.match(contentJs, /pbSentences = selected\.flatMap\(splitLongSentence\)/);
    assert.match(contentJs, /SENTENCE_CHUNK_LIMIT = 160/);
  });
});

// ── Race-condition & session-policy source contracts (mirrors content.js) ──
// These pin the concurrency fixes structurally so a refactor can't silently
// reintroduce the timeout / new-stroke playback races or the fallback policy.
describe('content.js race-condition & policy contracts', () => {
  const contentJs = fs.readFileSync(path.join(rootDir, 'content', 'content.js'), 'utf8');

  it('retires the old session: stopPlayback() is the first statement of resolveAndSelect', () => {
    assert.match(
      contentJs,
      /function resolveAndSelect\(startPt, endPt\)\s*\{\s*stopPlayback\(\);/,
      'resolveAndSelect must call stopPlayback() before anything else so a new stroke bumps pbRequestId and cancels the old session',
    );
  });

  // Extract the responseTimeout handler body once so the following assertions
  // are scoped to it (a bare [\s\S]*? would happily reach pbRequestId++ in a
  // different function far below and false-pass).
  const timeoutHandler = contentJs.match(
    /const responseTimeout = setTimeout\(\(\) => \{([\s\S]*?)\}, TTS_TIMEOUT_MS\);/,
  );

  it('timeout invalidates the in-flight request: pbRequestId++ inside the responseTimeout handler', () => {
    assert.ok(timeoutHandler, 'responseTimeout handler not found');
    assert.match(
      timeoutHandler[1],
      /pbRequestId\+\+;/,
      'the responseTimeout handler must bump pbRequestId so a late Kokoro response is discarded by the staleness guard',
    );
  });

  it('honest timeout toast asks the engine for status', () => {
    assert.ok(timeoutHandler, 'responseTimeout handler not found');
    assert.match(
      timeoutHandler[1],
      /engine-status-request/,
      'the responseTimeout handler must query engine-status-request to phrase the fallback toast honestly',
    );
  });

  it('session fallback policy engages after two engine failures', () => {
    assert.match(contentJs, /sessionFallbackCount >= 2/);
  });

  it('prefetch respects the session fallback policy', () => {
    assert.match(
      contentJs,
      /function prefetchSentence\(idx, voice, speed\)\s*\{[\s\S]*?sessionFallbackCount >= 2[\s\S]*?function maybePrefetchAhead/,
      'prefetchSentence must skip queuing engine work once the fallback policy is engaged',
    );
  });

  it('maps the cancelled error code in content.js getErrorMessage', () => {
    assert.match(contentJs, /case 'cancelled':/);
  });

  it('polls engine status while loading for the download-progress tooltip', () => {
    assert.match(contentJs, /Downloading voice model — \$\{status\.progress\}%/);
  });

  it('switches the loading tooltip to "Waking up" when the engine is warm', () => {
    assert.match(contentJs, /Waking up voice engine — \$\{status\.progress\}%/);
  });
});

// ── Wave B: tts-cancel protocol source contracts (mirrors content.js) ──
describe('content.js tts-cancel protocol contracts', () => {
  const contentJs = fs.readFileSync(path.join(rootDir, 'content', 'content.js'), 'utf8');

  it('mints a monotonic clientRequestId and tracks inflight ids', () => {
    assert.match(contentJs, /let ttsClientSeq = 0/);
    assert.match(contentJs, /const inflightTtsIds = new Set\(\)/);
    assert.match(contentJs, /const clientRequestId = `\$\{ttsSessionNonce\}:\$\{\+\+ttsClientSeq\}`/);
  });

  it('I1: composes a per-load nonce into the id so it survives content-script reloads', () => {
    // ttsClientSeq resets to 0 each load while the offscreen cancelled-id set
    // outlives it; the nonce prevents a fresh id colliding with a stale cancel.
    assert.match(contentJs, /const ttsSessionNonce = Math\.random\(\)\.toString\(36\)\.slice\(2, 8\)/);
    // Both mint sites (playSentence + prefetchSentence) use the composed form.
    const mints = contentJs.match(/`\$\{ttsSessionNonce\}:\$\{\+\+ttsClientSeq\}`/g) || [];
    assert.equal(mints.length, 2, 'both playSentence and prefetchSentence must compose the nonce');
  });

  it('I2(a): recovers when a cancel reaches the current request instead of stalling', () => {
    assert.match(contentJs, /let cancelledRetryCount = 0/);
    assert.match(contentJs, /cancelledRetryCount < 2/);
    assert.match(contentJs, /cancelledRetryCount\+\+;/);
    // Cap exhausted → fall back to the system voice under a freshly-bumped id.
    assert.match(contentJs, /fallbackSpeechSynthesis\(text, speed, \+\+pbRequestId\)/);
  });

  it('I2(b): re-issues the current sentence when a menu change cancels a queued load', () => {
    // Both the speed slider and voice select re-issue when mid-load.
    const reissues = contentJs.match(/if \(changed && pbState === 'loading'\) playSentence\(pbIndex\)/g) || [];
    assert.equal(reissues.length, 2, 'speed slider and voice select must both re-issue on a cancelled load');
  });

  it('I3: model-loading is excluded from the session fallback latch', () => {
    // !response.ok path: fall back for this sentence but don't count the latch.
    assert.match(contentJs, /if \(response\?\.error !== 'model-loading'\) sessionFallbackCount\+\+;/);
    // Timeout path: a 'downloading' engine status likewise doesn't latch.
    assert.match(contentJs, /if \(!isDownloading\) sessionFallbackCount\+\+;/);
  });

  it('stamps every tts-request with the clientRequestId and tracks it in the set', () => {
    // Both playSentence and prefetchSentence add before sending and delete in the callback.
    const adds = contentJs.match(/inflightTtsIds\.add\(clientRequestId\)/g) || [];
    const deletes = contentJs.match(/inflightTtsIds\.delete\(clientRequestId\)/g) || [];
    assert.equal(adds.length, 2, 'both playSentence and prefetchSentence must add the id');
    assert.equal(deletes.length, 2, 'both callbacks must remove the id');
    assert.match(contentJs, /type: 'tts-request', text, voice, speed, clientRequestId/);
  });

  it('defines cancelInflightTts as a fire-and-forget tts-cancel sender', () => {
    assert.match(contentJs, /function cancelInflightTts\(\)/);
    assert.match(contentJs, /type: 'tts-cancel', clientRequestIds/);
    assert.match(contentJs, /inflightTtsIds\.clear\(\)/);
  });

  it('cancels inflight synths from stopPlayback', () => {
    assert.match(
      contentJs,
      /function stopPlayback\(\)\s*\{[\s\S]*?cancelInflightTts\(\)[\s\S]*?setPlaybackState\('idle'\)/,
    );
  });

  it('cancels inflight synths when the audio cache is invalidated', () => {
    assert.match(
      contentJs,
      /function invalidateAudioCache\(reason\)\s*\{\s*[\s\S]*?cancelInflightTts\(\)/,
    );
  });

  it('cancels the timed-out request inside the responseTimeout handler', () => {
    const timeoutHandler = contentJs.match(
      /const responseTimeout = setTimeout\(\(\) => \{([\s\S]*?)\}, TTS_TIMEOUT_MS\);/,
    );
    assert.ok(timeoutHandler, 'responseTimeout handler not found');
    assert.match(timeoutHandler[1], /pbRequestId\+\+;[\s\S]*?cancelInflightTts\(\)/);
  });

  it('cancels the superseded synth on the skip (cache-miss) path before re-sending', () => {
    // navigateSentence cancels OLD ids before the debounced settle mints a NEW one.
    assert.match(
      contentJs,
      /function navigateSentence\(delta\)\s*\{[\s\S]*?cancelInflightTts\(\)[\s\S]*?skipDebounceTimer = setTimeout/,
    );
  });
});
