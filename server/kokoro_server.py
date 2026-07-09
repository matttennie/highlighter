#!/usr/bin/env python3
"""Local native Kokoro companion server for the Highlighter Chrome extension.

Gives the extension native-speed Kokoro synthesis over plain HTTP on
127.0.0.1, so the in-browser WASM engine (kokoro-js) can stay as a fallback
for machines where this server isn't installed. Python 3 stdlib
(http.server / ThreadingHTTPServer) + kokoro-onnx only — no third-party web
framework.

Endpoints (JSON in, JSON out, CORS enabled for the extension origin):
  GET  /health  -> {"status": "ok", "model": "loaded"|"cold", "engine": "kokoro-onnx"}
                   Answers instantly; never triggers a model load.
  GET  /voices  -> {"voices": [{"voiceId", "name", "category"}, ...]}
                   Loads the model on first call if cold.
  POST /tts     -> {"audioContent": "<base64 24kHz mono PCM16 WAV>"}
                   body: {"text": str, "voice": str, "speed": float}

Model lifecycle: lazy-loaded on first /voices or /tts request (guarded by
a lock so concurrent requests only load once), with an immediate warmup
inference to pay ONNX Runtime's first-call cost up front instead of during
a real request. A background thread unloads the model (frees the
kokoro-onnx session, drops the reference, garbage-collects) after
MODEL_IDLE_UNLOAD_SECONDS (15 minutes) with no synthesis activity — the
HTTP listener itself is never torn down, so the next request just pays a
cold-load again. Synthesis is serialized behind a single lock: kokoro-onnx
runs one inference at a time faster than two interleaved ones fight over
the same session.
"""

import base64
import gc
import io
import json
import os
import sys
import threading
import time
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

# Unload the model after 15 minutes with no synthesis requests. The HTTP
# listener stays up; the next request after this just pays a cold load.
MODEL_IDLE_UNLOAD_SECONDS = 15 * 60
IDLE_CHECK_INTERVAL_SECONDS = 30

CORS_ORIGIN = "*"
CORS_METHODS = "GET, POST, OPTIONS"
CORS_HEADERS = "Content-Type"

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
_load_lock = threading.Lock()   # guards lazy-load / unload of _kokoro
_synth_lock = threading.Lock()  # serializes inference: one synth at a time
_last_activity = None           # monotonic time of last completed synthesis


def _log(method, path, chars, elapsed_ms):
    print("%s %s chars=%d %.1fms" % (method, path, chars, elapsed_ms),
          file=sys.stderr, flush=True)


def _warmup(kokoro):
    """Pay ONNX Runtime's one-time first-call session cost now."""
    with _synth_lock:
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
            from kokoro_onnx import Kokoro
            t0 = time.time()
            kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
            _warmup(kokoro)
            print("kokoro_server: model loaded + warmed in %.2fs" % (time.time() - t0),
                  file=sys.stderr, flush=True)
            _kokoro = kokoro
            _last_activity = time.time()
        return _kokoro


def _mark_activity():
    global _last_activity
    _last_activity = time.time()


def _unload_if_idle():
    global _kokoro, _last_activity
    with _load_lock:
        if _kokoro is not None and _last_activity is not None:
            idle_for = time.time() - _last_activity
            if idle_for > MODEL_IDLE_UNLOAD_SECONDS:
                print("kokoro_server: unloading model after %.0fs idle" % idle_for,
                      file=sys.stderr, flush=True)
                _kokoro = None
                gc.collect()


def _idle_unload_loop():
    while True:
        time.sleep(IDLE_CHECK_INTERVAL_SECONDS)
        try:
            _unload_if_idle()
        except Exception as e:
            print("kokoro_server: idle-unload check failed: %s" % e,
                  file=sys.stderr, flush=True)


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

    with _synth_lock:
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
        self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self):
        t0 = time.time()
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", CORS_METHODS)
        self.send_header("Access-Control-Allow-Headers", CORS_HEADERS)
        self.send_header("Content-Length", "0")
        self.end_headers()
        _log("OPTIONS", self.path, 0, (time.time() - t0) * 1000)

    def do_GET(self):
        t0 = time.time()
        path = urlparse(self.path).path
        chars = 0
        try:
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
        except Exception as e:
            self._send_json(500, {"error": str(e)})
        finally:
            _log("GET", path, chars, (time.time() - t0) * 1000)

    def do_POST(self):
        t0 = time.time()
        path = urlparse(self.path).path
        chars = 0
        try:
            if path == "/tts":
                try:
                    body = self._read_json_body()
                except (ValueError, UnicodeDecodeError):
                    self._send_json(400, {"error": "invalid-json"})
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
                except Exception as e:
                    self._send_json(500, {"error": str(e)})
                    return

                self._send_json(200, {"audioContent": audio_b64})
            else:
                self._send_json(404, {"error": "not-found"})
        finally:
            _log("POST", path, chars, (time.time() - t0) * 1000)


def main():
    unloader = threading.Thread(target=_idle_unload_loop, daemon=True)
    unloader.start()

    server = ThreadingHTTPServer((HOST, PORT), KokoroHandler)
    print("kokoro_server: listening on http://%s:%d" % (HOST, PORT),
          file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
