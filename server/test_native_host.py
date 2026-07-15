#!/usr/bin/env python3
"""End-to-end check of the native host's shared-server behavior: spawn via
the shared tts skill, hold a chrome-* leash marker, never reap the shared
server, and let claims (not the host) end its life. Stdlib only.

Run: python3 server/test_native_host.py
Needs the shared tts worktree at the path below (adjust if moved).
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED_TTS_DIR = os.environ.get(
    "KOKORO_SHARED_TTS_DIR",
    "/Users/mtennie/Desktop/AI/claude-code-cli-tts/.claude/worktrees/"
    "tts-latency/tts")
PORT = 8899  # off the real 8880 so a live server doesn't interfere

ENV = dict(os.environ,
           KOKORO_SHARED_TTS_DIR=SHARED_TTS_DIR,
           KOKORO_HTTP_PORT=str(PORT),
           KOKORO_SESSIONS_DIR=tempfile.mkdtemp(),
           KOKORO_CLAIM_WINDOW="30",
           KOKORO_SERVER_SESSION_POLL_INTERVAL="1")
SESSIONS = ENV["KOKORO_SESSIONS_DIR"]
LEN_STRUCT = struct.Struct("<I")


def health_ok():
    try:
        with urllib.request.urlopen(
                "http://127.0.0.1:%d/health" % PORT, timeout=1) as r:
            return r.status == 200
    except OSError:
        return False


def read_frame(stream):
    raw = stream.read(LEN_STRUCT.size)
    assert len(raw) == LEN_STRUCT.size, "no frame from host"
    return json.loads(stream.read(LEN_STRUCT.unpack(raw)[0]))


def main():
    host = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "native_host.py")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=ENV)

    status = read_frame(host.stdout)
    assert status["type"] == "server-status", status
    assert status["ok"], "shared server never became healthy"
    assert not status["owned"], "shared spawn must not be owned/reaped"

    marker = "chrome-%d" % host.pid
    assert marker in os.listdir(SESSIONS), "leash marker missing"
    assert health_ok()

    # Keep the server alive past host death via a fake Claude session.
    open(os.path.join(SESSIONS, "session-test"), "w").close()

    host.stdin.close()  # EOF = Chrome quit
    host.wait(timeout=10)
    assert marker not in os.listdir(SESSIONS), "leash marker not removed"

    time.sleep(3)
    assert health_ok(), "shared server was reaped with a claim still active"

    # Last claim gone -> server exits within a few polls.
    os.unlink(os.path.join(SESSIONS, "session-test"))
    deadline = time.time() + 10
    while time.time() < deadline and health_ok():
        time.sleep(1)
    assert not health_ok(), "server outlived its last claim"
    print("ok")


if __name__ == "__main__":
    main()
