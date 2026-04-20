/**
 * Tests for TTS integration logic.
 * Covers: error message mapping, playback state transitions,
 * stale request guard, playback-rate normalization, and base64 encoding.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── Error message mapping (mirrors content.js) ─────────────────────

function getErrorMessage(response) {
  if (!response) return 'No response from background';
  switch (response.error) {
    case 'no-token':          return 'Set Inworld API key in extension settings';
    case 'empty-text':        return 'Select some text before playing';
    case 'text-too-long':     return response.detail || 'Text exceeds maximum length';
    case 'auth-failed':       return response.detail
      ? `Authentication failed\n${truncateDetail(response.detail)}`
      : 'Invalid API key';
    case 'billing-required':  return response.detail
      ? `API error (402)\n${truncateDetail(response.detail)}`
      : 'API error (402)\nCheck Inworld billing/quota';
    case 'rate-limited':      return 'Rate limited — try again shortly';
    case 'timeout':           return 'Request timed out — try again';
    case 'api-error':         return response.detail
      ? `API error (${response.status})\n${truncateDetail(response.detail)}`
      : `API error (${response.status})`;
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

  it('maps no-token', () => {
    assert.match(getErrorMessage({ error: 'no-token' }), /Inworld/i);
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

  it('maps auth-failed without detail', () => {
    assert.match(getErrorMessage({ error: 'auth-failed' }), /invalid/i);
  });

  it('includes upstream auth detail when available', () => {
    const msg = getErrorMessage({ error: 'auth-failed', detail: 'Missing permission' });
    assert.match(msg, /authentication failed/i);
    assert.match(msg, /missing permission/i);
  });

  it('maps billing-required with 402', () => {
    const msg = getErrorMessage({ error: 'billing-required' });
    assert.match(msg, /402/);
    assert.match(msg, /billing/i);
    assert.match(msg, /Inworld/i);
  });

  it('includes upstream billing-required detail when available', () => {
    const msg = getErrorMessage({
      error: 'billing-required',
      detail: 'Plan quota exceeded.',
    });
    assert.match(msg, /402/);
    assert.match(msg, /quota exceeded/i);
  });

  it('maps rate-limited', () => {
    assert.match(getErrorMessage({ error: 'rate-limited' }), /rate/i);
  });

  it('maps timeout', () => {
    assert.match(getErrorMessage({ error: 'timeout' }), /timed out/i);
  });

  it('maps api-error with status code', () => {
    const msg = getErrorMessage({ error: 'api-error', status: 429 });
    assert.match(msg, /429/);
  });

  it('maps api-error with 500 status', () => {
    const msg = getErrorMessage({ error: 'api-error', status: 500 });
    assert.match(msg, /500/);
  });

  it('includes upstream api-error detail when available', () => {
    const msg = getErrorMessage({ error: 'api-error', status: 500, detail: 'Backend rejected request' });
    assert.match(msg, /500/);
    assert.match(msg, /backend rejected request/i);
  });

  it('falls back to error string for unknown codes', () => {
    assert.equal(getErrorMessage({ error: 'custom-error' }), 'custom-error');
  });

  it('returns "Unknown error" for empty error field', () => {
    assert.equal(getErrorMessage({ error: '' }), 'Unknown error');
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
  return Math.max(0.5, Math.min(1.5, parsed));
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

  it('clamps values above maximum to 1.5', () => {
    assert.equal(normalizePlaybackRate(3), 1.5);
    assert.equal(normalizePlaybackRate(2.1), 1.5);
    assert.equal(normalizePlaybackRate(100), 1.5);
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
