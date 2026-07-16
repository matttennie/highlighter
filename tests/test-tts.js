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

describe('content.js decoded-audio cache contracts', () => {
  const contentJs = fs.readFileSync(path.join(rootDir, 'content', 'content.js'), 'utf8');

  it('stores binary Blobs instead of retaining base64 data URLs', () => {
    const setCache = contentJs.match(/function setCachedAudio\(idx, voice, speed, audioDataUrl\) \{([\s\S]*?)\n {2}\}/);
    assert.ok(setCache, 'setCachedAudio not found');
    assert.match(setCache[1], /audioDataUrlToBlob\(audioDataUrl\)/);
    assert.match(setCache[1], /\{ audioBlob, voice, speed \}/);
    assert.match(contentJs, /return entry\.audioBlob/);
    assert.doesNotMatch(contentJs, /\{ audioDataUrl, voice, speed \}/);
  });

  it('decodes each successful response before caching and reuses that Blob for playback', () => {
    assert.match(contentJs, /const audioSource = setCachedAudio\([\s\S]*?playAudioSource\(audioSource/);
    assert.match(contentJs, /pending\.waiter = \(audioBlob\) =>/);
    assert.match(contentJs, /if \(waiter\) waiter\(audioBlob\)/);
    assert.match(contentJs, /playAudioSource\(cachedAudio/);
  });

  it('creates short-lived object URLs for playback and revokes them on release', () => {
    const play = contentJs.match(/function playAudioSource\(audioSource, requestId, speed, text\) \{([\s\S]*?)\n {2}function audioDataUrlToBlob/);
    assert.ok(play, 'playAudioSource not found');
    assert.match(play[1], /audioSource instanceof Blob/);
    assert.match(play[1], /URL\.createObjectURL\(audioBlob\)/);
    assert.match(contentJs, /URL\.revokeObjectURL\(pbAudioObjectUrl\)/);
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
    const chunkWindow = rest.slice(0, limit);
    let cut = -1;
    for (const m of chunkWindow.matchAll(/[,;:—]/g)) cut = m.index;
    if (cut < 1) cut = chunkWindow.lastIndexOf(' ');
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
    // The long-after-short pre-pass runs BEFORE flatMap(splitLongSentence) so the
    // 160-char hard chunking still applies to any monster halves it produces.
    assert.match(contentJs, /pbSentences = splitLongAfterShort\(selected\)\.flatMap\(splitLongSentence\)/);
    assert.match(contentJs, /SENTENCE_CHUNK_LIMIT = 160/);
  });
});

// ── splitLongAfterShort (mirrors content.js) ─────────────────────────
// Pre-pass: a SHORT sentence (<90) followed by a LONG one (>200) splits the
// long follower at the first clause boundary (, ; or —) at/after its midpoint,
// with continuation: true on the second half (no mid-sentence pause). No such
// boundary → left alone.
function splitLongAfterShort(sentences) {
  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const prev = sentences[i - 1];
    if (prev && typeof prev.text === 'string' && prev.text.length < 90 &&
        s && typeof s.text === 'string' && s.text.length > 200) {
      const half = Math.floor(s.text.length / 2);
      const rel = s.text.slice(half).search(/[,;—]/);
      if (rel !== -1) {
        const cut = half + rel;
        out.push({ ...s, text: s.text.slice(0, cut + 1).trim() });
        out.push({ ...s, text: s.text.slice(cut + 1).trim(), continuation: true });
        continue;
      }
    }
    out.push(s);
  }
  return out;
}

describe('splitLongAfterShort', () => {
  const short = { text: 'A short one.' };                       // 12 chars
  // A long sentence (>200) whose only clause boundary sits well past the midpoint.
  const longWithLateComma =
    { text: 'x'.repeat(140) + ', ' + 'y'.repeat(120) };         // comma at idx 140, len 262, mid 131

  it('splits a long sentence following a short one at the first boundary past the midpoint', () => {
    const out = splitLongAfterShort([short, longWithLateComma]);
    assert.equal(out.length, 3);
    assert.equal(out[0], short);                                 // short untouched
    assert.equal(out[1].text, 'x'.repeat(140) + ',');           // first half keeps the comma
    assert.equal(out[1].continuation, undefined);               // first half is NOT a continuation
    assert.equal(out[2].text, 'y'.repeat(120));
    assert.equal(out[2].continuation, true);                    // second half suppresses the pause
  });

  it('leaves the long sentence alone when its only comma is before the midpoint', () => {
    const early = { text: 'x'.repeat(20) + ', ' + 'y'.repeat(220) }; // comma at 20, len 242, mid 121
    const out = splitLongAfterShort([short, early]);
    assert.equal(out.length, 2);
    assert.equal(out[1], early);
  });

  it('does not split when the preceding sentence is not short (long → long)', () => {
    const long1 = { text: 'a'.repeat(210) };
    const out = splitLongAfterShort([long1, longWithLateComma]);
    assert.equal(out.length, 2);
    assert.equal(out[1], longWithLateComma);
  });

  it('does not split a long sentence that has no clause boundary at all', () => {
    const noBoundary = { text: 'a'.repeat(260) }; // no , ; or —
    const out = splitLongAfterShort([short, noBoundary]);
    assert.equal(out.length, 2);
    assert.equal(out[1], noBoundary);
  });

  it('does not split when the follower is not long enough (>200 required)', () => {
    const notLong = { text: 'x'.repeat(100) + ', ' + 'y'.repeat(98) }; // len 200 — NOT > 200
    const out = splitLongAfterShort([short, notLong]);
    assert.equal(out.length, 2);
    assert.equal(out[1], notLong);
  });

  it('respects the short boundary: a 90-char predecessor is NOT short', () => {
    const exactly90 = { text: 'p'.repeat(90) };
    const out = splitLongAfterShort([exactly90, longWithLateComma]);
    assert.equal(out.length, 2, '90 chars is not < 90, so no split');
  });

  it('accepts a semicolon or em-dash as the split boundary', () => {
    const semi = { text: 'x'.repeat(140) + '; ' + 'y'.repeat(120) };
    const dash = { text: 'x'.repeat(140) + '— ' + 'y'.repeat(120) };
    assert.equal(splitLongAfterShort([short, semi]).length, 3);
    assert.equal(splitLongAfterShort([short, dash]).length, 3);
  });

  it('the two halves lose no words (concatenate back to the original clauses)', () => {
    const out = splitLongAfterShort([short, longWithLateComma]);
    assert.equal(out[1].text + ' ' + out[2].text, longWithLateComma.text);
  });

  it('leaves a lone or leading long sentence untouched (no short predecessor)', () => {
    const out = splitLongAfterShort([longWithLateComma]);
    assert.equal(out.length, 1);
    assert.equal(out[0], longWithLateComma);
  });

  it('source contract: content.js defines splitLongAfterShort with the < 90 / > 200 gates', () => {
    const contentJs = fs.readFileSync(path.join(rootDir, 'content', 'content.js'), 'utf8');
    assert.match(contentJs, /function splitLongAfterShort\(sentences\)/);
    assert.match(contentJs, /prev\.text\.length < 90/);
    assert.match(contentJs, /s\.text\.length > 200/);
    assert.match(contentJs, /continuation: true/);
  });
});

// ── Prefetch pipeline: eager kickoff + continuous work-ahead (source contracts) ──
// Pins the pipeline structurally: sentence N+1 is queued the instant N's request
// is committed (eager), and each prefetch completion self-refills the queue via
// topUpPrefetch, bounded to 2 in-flight so skips don't flood the synth queue.
describe('content.js prefetch pipeline contracts', () => {
  const contentJs = fs.readFileSync(path.join(rootDir, 'content', 'content.js'), 'utf8');

  it('raises AUDIO_CACHE_LIMIT to 64 so a whole selection can cache', () => {
    assert.match(contentJs, /const AUDIO_CACHE_LIMIT = 64;/);
  });

  it('defines topUpPrefetch, bounded to 2 in-flight prefetches, scanning after pbIndex', () => {
    const fn = contentJs.match(/function topUpPrefetch\(voice, speed\)\s*\{([\s\S]*?)\n {2}\}/);
    assert.ok(fn, 'topUpPrefetch not found');
    assert.match(fn[1], /pendingPrefetch\.size >= 2/, 'topUp must do nothing when 2 prefetches are already in flight');
    assert.match(fn[1], /for \(let idx = pbIndex \+ 1; idx < pbSentences\.length; idx\+\+\)/, 'topUp must scan forward from pbIndex+1 so a skip re-anchors the pipeline');
    assert.match(fn[1], /audioCache\.has\(idx\) \|\| pendingPrefetch\.has\(idx\)/, 'topUp must skip already-cached / already-pending indices');
    assert.match(fn[1], /prefetchSentence\(idx, voice, speed\)/);
  });

  it('calls topUpPrefetch from prefetchSentence success path, after the waiter resolution', () => {
    const fn = contentJs.match(/function prefetchSentence\(idx, voice, speed\)\s*\{([\s\S]*?)\n {2}\}/);
    assert.ok(fn, 'prefetchSentence not found');
    const body = fn[1];
    const cacheAt = body.indexOf('setCachedAudio(idx, voice, speed, response.audioDataUrl)');
    const waiterAt = body.indexOf('if (waiter) waiter(audioBlob)');
    const topUpAt = body.indexOf('topUpPrefetch(voice, speed)');
    assert.ok(cacheAt !== -1 && waiterAt !== -1 && topUpAt !== -1, 'success-path cache/waiter/topUp all present');
    assert.ok(cacheAt < waiterAt && waiterAt < topUpAt, 'topUp must run after setCachedAudio and waiter resolution');
  });

  it('topUp is reached only in the non-stale success branch (after the stale/cancel guard returns)', () => {
    const fn = contentJs.match(/function prefetchSentence\(idx, voice, speed\)\s*\{([\s\S]*?)\n {2}\}/);
    assert.ok(fn, 'prefetchSentence not found');
    const body = fn[1];
    const guardAt = body.indexOf('token.cancelled || myGen !== prefetchGeneration');
    const topUpAt = body.indexOf('topUpPrefetch(voice, speed)');
    assert.ok(guardAt !== -1 && topUpAt !== -1);
    assert.ok(guardAt < topUpAt, 'the stale/cancel guard must precede the topUp call');
  });

  it('eagerly kicks maybePrefetchAhead in BOTH of playSentence request paths (join + fresh send)', () => {
    const playSentenceBody = contentJs.match(/function playSentence\(idx\)\s*\{([\s\S]*?)\n {2}function pausePlayback\(\)/);
    assert.ok(playSentenceBody, 'playSentence body not found');
    const body = playSentenceBody[1];
    // Join branch: eager kick before its return, after registering the waiter.
    const joinAt = body.indexOf('pending.waiter = (audioBlob) =>');
    // Fresh send: the direct tts-request path.
    const freshSendAt = body.indexOf('inflightTtsIds.add(clientRequestId)');
    // Eager kicks: the cache-hit path already had one; count the request-path ones.
    const eager = body.match(/maybePrefetchAhead\(idx, voice, speed\)/g) || [];
    assert.ok(joinAt !== -1 && freshSendAt !== -1);
    // cache-hit + join-success-waiter + join-eager + fresh-success-callback + fresh-eager = 5 sites.
    assert.ok(eager.length >= 5, `expected >=5 maybePrefetchAhead sites in playSentence, found ${eager.length}`);
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

// ── Latency: playSentence joins an in-flight prefetch (mirrors content.js) ──
// Pins the double-synthesis fix structurally: when sentence N ends while
// prefetch(N+1) is still synthesizing, a cache-missed playSentence must WAIT on
// that in-flight prefetch instead of firing a duplicate tts-request the serial
// offscreen queue would only process after the prefetch finishes (measured:
// 13-27s inter-sentence gaps from synthesizing the identical audio twice).
describe('content.js join-in-flight-prefetch contracts', () => {
  const contentJs = fs.readFileSync(path.join(rootDir, 'content', 'content.js'), 'utf8');

  // Scope assertions to playSentence's body so a match elsewhere can't false-pass.
  const playSentenceBody = contentJs.match(
    /function playSentence\(idx\)\s*\{([\s\S]*?)\n {2}function pausePlayback\(\)/,
  );

  it('playSentence consults pendingPrefetch before sending a tts-request', () => {
    assert.ok(playSentenceBody, 'playSentence body not found');
    const body = playSentenceBody[1];
    const joinAt = body.indexOf('pendingPrefetch.get(idx)');
    const sendAt = body.indexOf('inflightTtsIds.add(clientRequestId)');
    assert.ok(joinAt !== -1, 'playSentence must consult pendingPrefetch.get(idx)');
    assert.ok(sendAt !== -1, 'playSentence must still have a direct-send path');
    assert.ok(joinAt < sendAt, 'the pendingPrefetch join check must precede the direct tts-request send');
  });

  it('joins only when the prefetch voice AND speed match the current request', () => {
    assert.ok(playSentenceBody, 'playSentence body not found');
    assert.match(
      playSentenceBody[1],
      /pending\.voice === voice && pending\.speed === speed/,
      'playSentence must compare the prefetch entry voice/speed against its own before joining',
    );
  });

  it('registers a single waiter that clears the shared timeout and honours the staleness guard', () => {
    assert.ok(playSentenceBody, 'playSentence body not found');
    const body = playSentenceBody[1];
    assert.match(body, /pending\.waiter = \(audioBlob\) =>/, 'playSentence must register a waiter on the pending prefetch');
    assert.match(
      body,
      /clearTimeout\(responseTimeout\)[\s\S]*?if \(requestId !== pbRequestId\) return/,
      'the waiter must clear the shared responseTimeout and discard a superseded resolution by requestId',
    );
  });

  it('prefetch entries carry voice and speed (and a waiter slot) for the join match', () => {
    assert.match(
      contentJs,
      /const entry = \{ token, voice, speed, waiter: null \}/,
      'prefetchSentence must record voice/speed and a waiter slot on the pendingPrefetch entry',
    );
    assert.match(contentJs, /pendingPrefetch\.set\(idx, entry\)/);
  });

  it('prefetch resolves its waiter with the decoded audio blob on success and null on every failure path', () => {
    assert.match(
      contentJs,
      /if \(waiter\) waiter\(audioBlob\)/,
      'a successful prefetch must resolve the waiter with the decoded audio blob',
    );
    const nullResolves = contentJs.match(/if \(waiter\) waiter\(null\)/g) || [];
    // prefetch callback: discarded/stale + cancelled + failed, plus cancelAllPrefetches teardown.
    assert.ok(
      nullResolves.length >= 3,
      'the discarded/stale, cancelled, and failed prefetch paths must each resolve the waiter with null',
    );
  });

  it('cancelAllPrefetches resolves outstanding waiters so a joined playSentence never hangs', () => {
    assert.match(
      contentJs,
      /function cancelAllPrefetches\(\)\s*\{[\s\S]*?entry\.token\.cancelled = true[\s\S]*?if \(waiter\) waiter\(null\)[\s\S]*?pendingPrefetch\.clear\(\)/,
      'cancelAllPrefetches must mark tokens cancelled and resolve outstanding waiters with null before clearing the map',
    );
  });
});

// ── Inter-sentence pacing: pauseBeforeNext (mirrors content.js) ──────
// 0.25s between sentences, 0.5s at paragraph breaks (different block
// elements), and NO pause between chunks of a single long sentence — those
// are mid-sentence, not sentence boundaries. Applies only to automatic
// advancement (onAudioEnded); user-initiated skip/play stay instant.

const SENTENCE_PAUSE_MS = 250;
const PARAGRAPH_PAUSE_MS = 500;

// Pause inserted before auto-advancing to the next entry: none inside a
// split long sentence, longer at paragraph boundaries.
function pauseBeforeNext(prev, next) {
  if (!prev || !next) return 0;
  if (next.continuation) return 0;
  if (prev.blockIdx !== next.blockIdx) return PARAGRAPH_PAUSE_MS;
  return SENTENCE_PAUSE_MS;
}

describe('pauseBeforeNext', () => {
  it('returns 0 when next is a continuation chunk of a split long sentence', () => {
    assert.equal(pauseBeforeNext({ blockIdx: 0 }, { blockIdx: 0, continuation: true }), 0);
    // Even across a block boundary, a continuation chunk must still be 0 —
    // continuation always wins over the block comparison.
    assert.equal(pauseBeforeNext({ blockIdx: 0 }, { blockIdx: 1, continuation: true }), 0);
  });

  it('returns PARAGRAPH_PAUSE_MS (500) when the boundary crosses block elements', () => {
    assert.equal(pauseBeforeNext({ blockIdx: 0 }, { blockIdx: 1 }), PARAGRAPH_PAUSE_MS);
    assert.equal(pauseBeforeNext({ blockIdx: 0 }, { blockIdx: 1 }), 500);
  });

  it('returns SENTENCE_PAUSE_MS (250) within the same block', () => {
    assert.equal(pauseBeforeNext({ blockIdx: 2 }, { blockIdx: 2 }), SENTENCE_PAUSE_MS);
    assert.equal(pauseBeforeNext({ blockIdx: 2 }, { blockIdx: 2 }), 250);
  });

  it('returns 0 when prev is null or undefined', () => {
    assert.equal(pauseBeforeNext(null, { blockIdx: 0 }), 0);
    assert.equal(pauseBeforeNext(undefined, { blockIdx: 0 }), 0);
  });

  it('returns 0 when next is null or undefined', () => {
    assert.equal(pauseBeforeNext({ blockIdx: 0 }, null), 0);
    assert.equal(pauseBeforeNext({ blockIdx: 0 }, undefined), 0);
  });

  it('returns 0 when both prev and next are missing', () => {
    assert.equal(pauseBeforeNext(null, null), 0);
    assert.equal(pauseBeforeNext(undefined, undefined), 0);
  });
});

// ── content.js source contracts for inter-sentence pacing ────────────
describe('content.js inter-sentence pacing contracts', () => {
  const contentJs = fs.readFileSync(path.join(rootDir, 'content', 'content.js'), 'utf8');

  it('defines the pacing constants at the documented values', () => {
    assert.match(contentJs, /const SENTENCE_PAUSE_MS = 250;/);
    assert.match(contentJs, /const PARAGRAPH_PAUSE_MS = 500;/);
  });

  it('mirrors pauseBeforeNext byte-for-byte', () => {
    assert.match(
      contentJs,
      /function pauseBeforeNext\(prev, next\) \{\s*if \(!prev \|\| !next\) return 0;\s*if \(next\.continuation\) return 0;\s*if \(prev\.blockIdx !== next\.blockIdx\) return PARAGRAPH_PAUSE_MS;\s*return SENTENCE_PAUSE_MS;\s*\}/,
      'pauseBeforeNext in content.js must match the test mirror exactly',
    );
  });

  it('stamps cached sentence structure with blockIdx using a per-block counter', () => {
    const fn = contentJs.match(
      /function buildSentenceStructure\(root\)\s*\{([\s\S]*?)\n {2}\}/,
    );
    assert.ok(fn, 'buildSentenceStructure not found');
    assert.match(fn[1], /let blockIdx\s*=\s*0;/, 'buildSentenceStructure must maintain a per-block counter');
    assert.match(fn[1], /entries\.push\(\{ \.\.\.sentence, block, blockIdx \}\)/, 'every cached sentence must be stamped with blockIdx');
    assert.match(fn[1], /blockIdx\+\+/, 'the counter must advance per block whose sentences get extracted');
  });

  it('marks chunks after the first as continuation in splitLongSentence', () => {
    const fn = contentJs.match(
      /function splitLongSentence\(sentence\)\s*\{([\s\S]*?)\n {2}\}/,
    );
    assert.ok(fn, 'splitLongSentence not found');
    assert.match(
      fn[1],
      /\.map\(\(chunkText, chunkIndex\) => \(\{ \.\.\.sentence, text: chunkText, continuation: chunkIndex > 0 \}\)\)/,
      'splitLongSentence must stamp continuation: chunkIndex > 0 on every chunk',
    );
  });

  it('onAudioEnded computes the pause via pauseBeforeNext and advances immediately when it is 0', () => {
    const fn = contentJs.match(
      /function onAudioEnded\(\)\s*\{([\s\S]*?)\n {2}\}/,
    );
    assert.ok(fn, 'onAudioEnded not found');
    assert.match(
      fn[1],
      /const pause = pauseBeforeNext\(pbSentences\[pbIndex\], pbSentences\[pbIndex \+ 1\]\);/,
    );
  });

  it('onAudioEnded schedules the advance with full requestId race protection when pause > 0', () => {
    const fn = contentJs.match(
      /function onAudioEnded\(\)\s*\{([\s\S]*?)\n {2}\}/,
    );
    assert.ok(fn, 'onAudioEnded not found');
    assert.match(fn[1], /const reqAtEnd = pbRequestId;/);
    assert.match(fn[1], /clearTimeout\(advanceTimer\);/);
    assert.match(
      fn[1],
      /advanceTimer = setTimeout\(\(\) => \{\s*advanceTimer = 0;\s*if \(reqAtEnd !== pbRequestId\) return; \/\/ superseded during the pause\s*playSentence\(pbIndex \+ 1\);\s*\}, pause\);/,
      'the scheduled advance must re-check pbRequestId before calling playSentence, guarding against skip/stop/re-stroke/menu-change during the pause',
    );
  });

  it('declares advanceTimer as module state initialized to 0', () => {
    assert.match(contentJs, /let advanceTimer = 0;/);
  });

  it('stopPlayback clears advanceTimer (belt and braces on top of the requestId guard)', () => {
    assert.match(
      contentJs,
      /function stopPlayback\(\)\s*\{[\s\S]*?clearTimeout\(advanceTimer\);\s*advanceTimer = 0;[\s\S]*?setPlaybackState\('idle'\);/,
    );
  });

  it('hidePlayer routes through stopPlayback so no advanceTimer leaks on close', () => {
    assert.match(
      contentJs,
      /function hidePlayer\(\)\s*\{[\s\S]*?stopPlayback\(\);/,
    );
  });
});
