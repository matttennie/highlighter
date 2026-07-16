#!/usr/bin/env python3
"""Local native Kokoro companion server for the Highlighter Chrome extension.

Gives the extension native-speed Kokoro synthesis over plain HTTP on
127.0.0.1, so the in-browser WASM engine (kokoro-js) can stay as a fallback
for machines where this server isn't installed. Python 3 stdlib
(http.server / ThreadingHTTPServer) + kokoro-onnx only — no third-party web
framework.

This server is consumed only by the Highlighter Chrome extension, whose
background-script fetches carry host_permissions for http://127.0.0.1/*
and therefore bypass CORS entirely - no permissive CORS headers are sent.
Instead, every request is origin-gated: a request with no `Origin` header
(curl, local tools) is allowed; a request WITH an `Origin` header is only
allowed if it starts with `chrome-extension://` - anything else gets a
403 without being processed.

Endpoints (JSON in, JSON out):
  GET  /health  -> {"status": "ok", "model": "loaded"|"cold", "engine": "kokoro-onnx"}
                   Answers instantly; never triggers a model load.
  GET  /voices  -> {"voices": [{"voiceId", "name", "category"}, ...]}
                   Loads the model on first call if cold.
  POST /tts     -> {"audioContent": "<base64 24kHz mono PCM16 WAV>"}
                   body: {"text": str, "voice": str, "speed": float}

Model lifecycle: lazy-loaded on first /voices or /tts request (guarded by
a lock so concurrent requests only load once), with an immediate warmup
inference to pay ONNX Runtime's first-call cost up front instead of during
a real request. A background thread exits the whole process after
SERVER_IDLE_EXIT_SECONDS (15 minutes) with no synthesis activity. The Chrome
native host watches the server and drops the extension's native port when it
exits, so the next engagement starts a fresh host and server. Synthesis
concurrency is capped by a semaphore
(KOKORO_CONCURRENCY, default 2): onnxruntime's InferenceSession.run() is
thread-safe for concurrent calls, so a few requests can share one session
at once rather than serializing behind a single lock. To avoid the
concurrent runs fighting over all CPU cores, the session's intra-op thread
pool is capped (KOKORO_INTRA_THREADS, default half the CPU count) instead
of the onnxruntime default of using every core per run.
"""

import base64
import io
import json
import os
import sys
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

MODEL_PATH = os.environ.get(
    "KOKORO_MODEL_PATH",
    os.path.join(os.path.expanduser("~"), ".cache", "kokoro", "kokoro-v1.0.onnx"))
VOICES_PATH = os.environ.get(
    "KOKORO_VOICES_PATH",
    os.path.join(os.path.expanduser("~"), ".cache", "kokoro", "voices-v1.0.bin"))

HOST = "127.0.0.1"
PORT = int(os.environ.get("KOKORO_HTTP_PORT", "8880"))

WARMUP_TEXT = "Warming up."
WARMUP_VOICE = "bf_emma"
WARMUP_LANG = "en-gb"
DEFAULT_VOICE = "bf_emma"
DEFAULT_LANG = "en-us"

MIN_SPEED = 0.5
MAX_SPEED = 2.0

# Only requests that either omit Origin (curl, local tools) or carry an
# Origin starting with this prefix (the extension) are served; everything
# else gets a 403 without being processed. No CORS headers are sent - the
# extension's fetches carry host_permissions and bypass CORS entirely.
ALLOWED_ORIGIN_PREFIX = "chrome-extension://"

# Reject POST bodies larger than this without reading them.
MAX_BODY_BYTES = 64 * 1024

# Exit the whole process after 15 minutes with no synthesis requests. Boot
# counts as activity (see main), so an engaged-but-unused server still exits
# on schedule. The native host watching this child then exits too, dropping
# the extension's native port; the next engagement respawns a fresh server.
SERVER_IDLE_EXIT_SECONDS = 15 * 60
IDLE_CHECK_INTERVAL_SECONDS = 30

# Concurrent synthesis: N requests may run inference at once, each on an
# intra_op-limited session so they don't fight over all cores. See
# server/kokoro_server.py module docstring for the tuning rationale.
CONCURRENCY = int(os.environ.get("KOKORO_CONCURRENCY", "2"))
INTRA_THREADS = int(os.environ.get("KOKORO_INTRA_THREADS", str(max(2, (os.cpu_count() or 4) // 2))))

# voice-id prefix -> (display category, kokoro-onnx `lang` code for create())
PREFIX_INFO = {
    "af": ("English (US)", "en-us"),
    "am": ("English (US)", "en-us"),
    "bf": ("English (UK)", "en-gb"),
    "bm": ("English (UK)", "en-gb"),
    "ef": ("Spanish", "es"),
    "em": ("Spanish", "es"),
    "ff": ("French", "fr-fr"),
    "hf": ("Hindi", "hi"),
    "hm": ("Hindi", "hi"),
    "if": ("Italian", "it"),
    "im": ("Italian", "it"),
    "jf": ("Japanese", "ja"),
    "jm": ("Japanese", "ja"),
    "pf": ("Portuguese (BR)", "pt-br"),
    "pm": ("Portuguese (BR)", "pt-br"),
    "zf": ("Chinese", "zh"),
    "zm": ("Chinese", "zh"),
}


def _prefix_of(voice_id):
    return voice_id[:2]


def category_for_voice(voice_id):
    return PREFIX_INFO.get(_prefix_of(voice_id), ("Other", DEFAULT_LANG))[0]


def lang_for_voice(voice_id):
    return PREFIX_INFO.get(_prefix_of(voice_id), ("Other", DEFAULT_LANG))[1]


# --- Model lifecycle ---------------------------------------------------

_kokoro = None
_load_lock = threading.Lock()          # guards lazy-load / unload of _kokoro
_synth_sem = threading.Semaphore(CONCURRENCY)  # caps concurrent inferences
_last_activity = None                   # monotonic time of last completed synthesis


def _log(method, path, chars, elapsed_ms):
    print("%s %s chars=%d %.1fms" % (method, path, chars, elapsed_ms),
          file=sys.stderr, flush=True)


def _warmup(kokoro):
    """Pay ONNX Runtime's one-time first-call session cost now."""
    with _synth_sem:
        kokoro.create(WARMUP_TEXT, voice=WARMUP_VOICE, speed=1.0, lang=WARMUP_LANG)


def ensure_model_loaded():
    """Return the resident Kokoro instance, loading + warming it up if cold."""
    global _kokoro, _last_activity
    if _kokoro is not None:
        return _kokoro
    with _load_lock:
        if _kokoro is None:
            if not os.path.exists(MODEL_PATH) or not os.path.exists(VOICES_PATH):
                raise RuntimeError(
                    "kokoro model files not found (expected %s and %s) - run "
                    "server/install.sh" % (MODEL_PATH, VOICES_PATH))
            import onnxruntime as rt
            from kokoro_onnx import Kokoro
            t0 = time.time()
            so = rt.SessionOptions()
            so.intra_op_num_threads = INTRA_THREADS
            sess = rt.InferenceSession(MODEL_PATH, so, providers=["CPUExecutionProvider"])
            kokoro = Kokoro.from_session(sess, VOICES_PATH)
            _warmup(kokoro)
            print("kokoro_server: model loaded + warmed in %.2fs" % (time.time() - t0),
                  file=sys.stderr, flush=True)
            _kokoro = kokoro
            _last_activity = time.time()
        return _kokoro


def _mark_activity():
    global _last_activity
    _last_activity = time.time()


def _idle_exit_loop(server):
    """Shut the server down after SERVER_IDLE_EXIT_SECONDS with no activity.
    server.shutdown() unblocks serve_forever() in main(), which then flushes
    and exits 0 — a clean full-process exit, not just a model unload."""
    while True:
        time.sleep(IDLE_CHECK_INTERVAL_SECONDS)
        if _last_activity is None:
            continue
        idle_for = time.time() - _last_activity
        if idle_for > SERVER_IDLE_EXIT_SECONDS:
            print("kokoro_server: exiting after %.0fs idle" % idle_for,
                  file=sys.stderr, flush=True)
            server.shutdown()  # unblocks serve_forever(); main() exits 0
            return


def model_is_loaded():
    return _kokoro is not None


# --- Synthesis -----------------------------------------------------------

def synthesize_wav_base64(text, voice, speed):
    """Run one synthesis and return base64-encoded 24kHz mono PCM16 WAV bytes."""
    kokoro = ensure_model_loaded()

    valid_voices = set(kokoro.get_voices())
    if not voice or voice not in valid_voices:
        voice = DEFAULT_VOICE
    lang = lang_for_voice(voice)

    with _synth_sem:
        samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
    _mark_activity()

    pcm16 = (samples * 32767).astype("int16").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm16)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def list_voices():
    kokoro = ensure_model_loaded()
    return [
        {"voiceId": voice_id, "name": voice_id, "category": category_for_voice(voice_id)}
        for voice_id in kokoro.get_voices()
    ]


# --- HTTP handler ----------------------------------------------------------

class KokoroHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        pass  # replaced by our own single-line request log in each handler

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _log_exception(self, context):
        print("kokoro_server: unhandled exception in %s:" % context,
              file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)

    def _origin_forbidden(self):
        """True if this request carries an Origin header that isn't the
        extension's. Requests with no Origin header (curl, local tools) are
        always allowed - the extension's own fetches bypass CORS via
        host_permissions and never need permissive CORS headers here."""
        origin = self.headers.get("Origin")
        return origin is not None and not origin.startswith(ALLOWED_ORIGIN_PREFIX)

    def _read_bounded_body(self):
        """Read the POST body, capped at MAX_BODY_BYTES.

        Returns the raw bytes read. Sends the appropriate error response and
        returns None (without touching self.rfile) if Content-Length is
        missing, non-integer, negative, or over the cap.
        """
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._send_json(411, {"error": "body-too-large"})
            return None
        try:
            length = int(raw_length)
        except ValueError:
            self._send_json(413, {"error": "body-too-large"})
            return None
        if length < 0 or length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "body-too-large"})
            return None
        return self.rfile.read(length) if length > 0 else b""

    def do_OPTIONS(self):
        t0 = time.time()
        if self._origin_forbidden():
            self._send_json(403, {"error": "forbidden-origin"})
        else:
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
        _log("OPTIONS", self.path, 0, (time.time() - t0) * 1000)

    def do_GET(self):
        t0 = time.time()
        path = urlparse(self.path).path
        chars = 0
        try:
            if self._origin_forbidden():
                self._send_json(403, {"error": "forbidden-origin"})
                return
            if path == "/health":
                self._send_json(200, {
                    "status": "ok",
                    "model": "loaded" if model_is_loaded() else "cold",
                    "engine": "kokoro-onnx",
                })
            elif path == "/voices":
                self._send_json(200, {"voices": list_voices()})
            else:
                self._send_json(404, {"error": "not-found"})
        except Exception:
            self._log_exception("GET %s" % path)
            self._send_json(500, {"error": "internal-error"})
        finally:
            _log("GET", path, chars, (time.time() - t0) * 1000)

    def do_POST(self):
        t0 = time.time()
        path = urlparse(self.path).path
        chars = 0
        try:
            if self._origin_forbidden():
                self._send_json(403, {"error": "forbidden-origin"})
                return

            if path == "/tts":
                raw = self._read_bounded_body()
                if raw is None:
                    return  # error response already sent by _read_bounded_body

                try:
                    body = json.loads(raw.decode("utf-8")) if raw else {}
                except (ValueError, UnicodeDecodeError):
                    self._send_json(400, {"error": "invalid-json"})
                    return

                if not isinstance(body, dict):
                    self._send_json(400, {"error": "bad-request"})
                    return

                text = body.get("text")
                if not isinstance(text, str) or not text.strip():
                    self._send_json(400, {"error": "empty-text"})
                    return
                chars = len(text)

                voice = body.get("voice") or ""

                try:
                    speed = float(body.get("speed", 1.0))
                except (TypeError, ValueError):
                    speed = 1.0
                speed = max(MIN_SPEED, min(MAX_SPEED, speed))

                try:
                    audio_b64 = synthesize_wav_base64(text, voice, speed)
                except Exception:
                    self._log_exception("POST /tts synthesis")
                    self._send_json(500, {"error": "synthesis-failed"})
                    return

                self._send_json(200, {"audioContent": audio_b64})
            else:
                self._send_json(404, {"error": "not-found"})
        except Exception:
            self._log_exception("POST %s" % path)
            self._send_json(500, {"error": "internal-error"})
        finally:
            _log("POST", path, chars, (time.time() - t0) * 1000)


def main():
    global _last_activity
    server = ThreadingHTTPServer((HOST, PORT), KokoroHandler)
    _last_activity = time.time()  # boot counts as activity; idle clock starts now
    idler = threading.Thread(target=_idle_exit_loop, args=(server,), daemon=True)
    idler.start()

    print("kokoro_server: listening on http://%s:%d" % (HOST, PORT),
          file=sys.stderr, flush=True)
    try:
        server.serve_forever()  # returns when _idle_exit_loop calls shutdown()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    sys.stderr.flush()
    sys.stdout.flush()
    sys.exit(0)  # full-process exit — the native host reaps on our departure


if __name__ == "__main__":
    main()
