/**
 * Source-contract tests for the native Kokoro companion server
 * (server/kokoro_server.py). We don't spin up a Python process here — the
 * repo's node --test suite has no Python runtime dependency — so these
 * assertions read the server source and check it declares the behavior
 * specified for the local HTTP companion: binds to loopback only, exposes
 * the three endpoints with the right defaults/clamps, sends CORS headers,
 * and unloads the idle model after 15 minutes.
 *
 * The server was manually smoke-tested (curl against a running instance)
 * as part of building this file; see .superpowers/native-server-report.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(rootDir, 'server', 'kokoro_server.py'), 'utf8');

describe('server/kokoro_server.py', () => {
  it('binds to loopback only, never a wildcard interface', () => {
    assert.match(source, /HOST\s*=\s*["']127\.0\.0\.1["']/);
    assert.doesNotMatch(source, /0\.0\.0\.0/);
  });

  it('defaults the HTTP port to 8880, overridable via KOKORO_HTTP_PORT', () => {
    assert.match(source, /KOKORO_HTTP_PORT/);
    assert.match(source, /PORT\s*=\s*int\(os\.environ\.get\(\s*["']KOKORO_HTTP_PORT["']\s*,\s*["']8880["']\s*\)\)/);
  });

  it('reads model/voices paths from env with the documented cache defaults', () => {
    assert.match(source, /KOKORO_MODEL_PATH/);
    assert.match(source, /KOKORO_VOICES_PATH/);
    assert.match(source, /kokoro-v1\.0\.onnx/);
    assert.match(source, /voices-v1\.0\.bin/);
  });

  it('implements GET /health responding without loading the model', () => {
    assert.match(source, /path == ["']\/health["']/);
    assert.match(source, /"status":\s*"ok"/);
    assert.match(source, /"engine":\s*"kokoro-onnx"/);
    // /health must not call ensure_model_loaded()/synthesize before responding.
    const healthBlock = source.slice(source.indexOf('if path == "/health"'), source.indexOf('elif path == "/voices"'));
    assert.doesNotMatch(healthBlock, /ensure_model_loaded\(/);
  });

  it('reports model state as loaded/cold based on residency', () => {
    assert.match(source, /["']loaded["']\s+if\s+model_is_loaded\(\)\s+else\s+["']cold["']/);
  });

  it('implements GET /voices sourced from kokoro.get_voices()', () => {
    assert.match(source, /path == ["']\/voices["']/);
    assert.match(source, /get_voices\(\)/);
    assert.match(source, /voiceId/);
    assert.match(source, /category/);
  });

  it('maps every documented voice-id prefix to its display category', () => {
    const expected = {
      af: 'English \\(US\\)', am: 'English \\(US\\)',
      bf: 'English \\(UK\\)', bm: 'English \\(UK\\)',
      ef: 'Spanish', em: 'Spanish',
      ff: 'French',
      hf: 'Hindi', hm: 'Hindi',
      if: 'Italian', im: 'Italian',
      jf: 'Japanese', jm: 'Japanese',
      pf: 'Portuguese \\(BR\\)', pm: 'Portuguese \\(BR\\)',
      zf: 'Chinese', zm: 'Chinese',
    };
    for (const [prefix, category] of Object.entries(expected)) {
      const re = new RegExp(`["']${prefix}["']:\\s*\\(["']${category}["']`);
      assert.match(source, re, `prefix ${prefix} -> ${category}`);
    }
    assert.match(source, /["']Other["']/);
  });

  it('implements POST /tts returning base64 WAV audioContent', () => {
    assert.match(source, /path == ["']\/tts["']/);
    assert.match(source, /audioContent/);
    assert.match(source, /base64\.b64encode/);
    assert.match(source, /wave\.open/);
  });

  it('clamps synthesis speed to [0.5, 2.0]', () => {
    assert.match(source, /MIN_SPEED\s*=\s*0\.5/);
    assert.match(source, /MAX_SPEED\s*=\s*2\.0/);
    assert.match(source, /max\(MIN_SPEED,\s*min\(MAX_SPEED,\s*speed\)\)/);
  });

  it('rejects empty text with a 400 empty-text error', () => {
    assert.match(source, /empty-text/);
    assert.match(source, /self\._send_json\(400,\s*\{"error":\s*"empty-text"\}\)/);
  });

  it('falls back to bf_emma for unknown or empty voice', () => {
    assert.match(source, /DEFAULT_VOICE\s*=\s*["']bf_emma["']/);
    assert.match(source, /voice\s*=\s*DEFAULT_VOICE/);
    assert.match(source, /voice not in valid_voices/);
  });

  it('warms up with bf_emma / en-gb text on load, matching the reference server', () => {
    assert.match(source, /WARMUP_VOICE\s*=\s*["']bf_emma["']/);
    assert.match(source, /WARMUP_LANG\s*=\s*["']en-gb["']/);
    assert.match(source, /WARMUP_TEXT\s*=\s*["']Warming up\.["']/);
  });

  it('sends CORS headers on every response and handles OPTIONS preflight', () => {
    assert.match(source, /Access-Control-Allow-Origin/);
    assert.match(source, /CORS_ORIGIN\s*=\s*["']\*["']/);
    assert.match(source, /do_OPTIONS/);
    assert.match(source, /self\.send_response\(204\)/);
    assert.match(source, /Access-Control-Allow-Methods/);
    assert.match(source, /CORS_METHODS\s*=\s*["']GET, POST, OPTIONS["']/);
    assert.match(source, /Access-Control-Allow-Headers/);
    assert.match(source, /CORS_HEADERS\s*=\s*["']Content-Type["']/);
  });

  it('unloads the idle model after 15 minutes with a background thread', () => {
    assert.match(source, /MODEL_IDLE_UNLOAD_SECONDS\s*=\s*15\s*\*\s*60/);
    assert.match(source, /gc\.collect\(\)/);
    assert.match(source, /threading\.Thread\(target=_idle_unload_loop,\s*daemon=True\)/);
  });

  it('serializes synthesis behind a single inference lock', () => {
    assert.match(source, /_synth_lock\s*=\s*threading\.Lock\(\)/);
    assert.match(source, /with _synth_lock:/);
  });

  it('guards model load with its own lock (thread-safe lazy load)', () => {
    assert.match(source, /_load_lock\s*=\s*threading\.Lock\(\)/);
    assert.match(source, /with _load_lock:/);
  });

  it('logs one line per request to stderr with method, path, chars, and ms', () => {
    assert.match(source, /file=sys\.stderr/);
    assert.match(source, /def _log\(method, path, chars, elapsed_ms\)/);
    assert.match(source, /chars=%d/);
    assert.match(source, /%\.1fms/);
  });

  it('uses only stdlib http.server plus kokoro-onnx (no third-party web framework)', () => {
    assert.match(source, /from http\.server import BaseHTTPRequestHandler, ThreadingHTTPServer/);
    assert.match(source, /from kokoro_onnx import Kokoro/);
    assert.doesNotMatch(source, /flask|fastapi|django|aiohttp/i);
  });
});
