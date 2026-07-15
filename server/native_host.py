#!/usr/bin/env python3
"""Chrome native-messaging lifecycle host for the Kokoro companion server.

Chrome spawns this process via chrome.runtime.connectNative when the
Highlighter extension engages, and it dies when Chrome quits or the port
disconnects. This is a lifecycle LEASH, not a data channel: audio still
flows over plain HTTP to kokoro_server.py on 127.0.0.1. All this process
does is (a) make sure the HTTP server exists while Chrome holds the port
open, and (b) reap that server when the port closes.

Wire protocol (Chrome native messaging): each message is a 4-byte
little-endian uint32 length prefix followed by that many bytes of UTF-8
JSON, on stdin/stdout. A short/zero read on stdin means Chrome closed the
port -> EOF -> we're done.

Python 3 stdlib only (no kokoro-onnx import here; this stays lightweight).
"""

import json
import os
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request

PORT = int(os.environ.get("KOKORO_HTTP_PORT", "8880"))
HOST = "127.0.0.1"
ERR_LOG = "/tmp/highlighter-kokoro.err"
HEALTH_TIMEOUT_S = 20
REAP_GRACE_S = 5
PORT_WATCH_INTERVAL_S = float(os.environ.get("KOKORO_PORT_WATCH_INTERVAL", "15"))

SESSIONS_DIR = os.environ.get(
    "KOKORO_SESSIONS_DIR",
    os.path.join(os.path.expanduser("~"), ".cache", "kokoro", "sessions"))
SHARED_TTS_DIR = os.environ.get(
    "KOKORO_SHARED_TTS_DIR",
    os.path.join(os.path.expanduser("~"), ".claude", "skills", "tts"))
MARKER_PATH = os.path.join(SESSIONS_DIR, "chrome-%d" % os.getpid())

# Guards the single shutdown path so the stdin-EOF/SIGTERM reap and the
# child-watch exit never both fire: whichever wins flips _shutting_down; the
# other backs off. Prevents a double-reap / racing exit.
_shutdown_lock = threading.Lock()
_shutting_down = False

# Native-messaging framing: 4-byte little-endian uint32 length + UTF-8 JSON.
LEN_STRUCT = struct.Struct("<I")


# --- Wire protocol -------------------------------------------------------

def read_message():
    """Read one framed message from stdin. Return the decoded object, or
    None on EOF (short/zero read = Chrome closed the port)."""
    raw_len = sys.stdin.buffer.read(LEN_STRUCT.size)
    if len(raw_len) < LEN_STRUCT.size:
        return None  # EOF
    msg_len = LEN_STRUCT.unpack(raw_len)[0]
    if msg_len == 0:
        return None  # treat a zero-length frame as EOF too
    data = sys.stdin.buffer.read(msg_len)
    if len(data) < msg_len:
        return None  # short read = Chrome gone
    try:
        return json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {}  # malformed body: ignore as an unknown message, keep leashing


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(LEN_STRUCT.pack(len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def write_marker():
    """Leash marker: tells the shared server Chrome is a live consumer.
    Best-effort — a failed write only costs warmth precision, and a leaked
    marker is bounded by the server's claim window."""
    try:
        os.makedirs(SESSIONS_DIR, exist_ok=True)
        open(MARKER_PATH, "w").close()
    except OSError:
        pass


def remove_marker():
    try:
        os.unlink(MARKER_PATH)
    except OSError:
        pass


# --- Server lifecycle ----------------------------------------------------

def port_is_listening(port):
    """True if something already accepts connections on 127.0.0.1:port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            s.connect((HOST, port))
            return True
        except OSError:
            return False


def wait_for_health(port, timeout=HEALTH_TIMEOUT_S):
    """Poll GET /health until it answers 200, up to `timeout` seconds.
    kokoro_server answers /health instantly without loading the model."""
    url = "http://%s:%d/health" % (HOST, port)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def start_server(port):
    """Ensure a Kokoro HTTP server exists on `port`.

    Returns (owned, child, ok):
      owned  - True only for the bundled fallback we must watch and reap;
               the shared server is spawned detached and never owned.
      child  - the Popen handle when owned, else None.
      ok     - True if /health is answering.

    If the port is already listening, an external server (a manual run, or
    another Chrome profile's host) owns it: we never spawn and never kill it.
    """
    if port_is_listening(port):
        return False, None, True  # external server; not ours to reap

    here = os.path.dirname(os.path.abspath(__file__))
    shared_py = os.path.join(SHARED_TTS_DIR, ".venv", "bin", "python3")
    shared_srv = os.path.join(SHARED_TTS_DIR, "kokoro_server.py")
    shared = os.path.exists(shared_py) and os.path.exists(shared_srv)
    if shared:
        cmd = [shared_py, shared_srv]
    else:
        cmd = [sys.executable, os.path.join(here, "kokoro_server.py")]
    errlog = open(ERR_LOG, "ab")
    # Shared server: it manages its own lifetime via warmth claims, so we
    # detach it (start_new_session) and never own/reap it. Bundled fallback
    # keeps the old owned/reaped semantics.
    child = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=errlog,
        start_new_session=shared,
    )
    ok = wait_for_health(port)
    if shared:
        return False, None, ok  # not ours to watch or reap
    return True, child, ok


def reap(child):
    """SIGTERM the child, give it REAP_GRACE_S to exit, then SIGKILL."""
    if child.poll() is not None:
        return  # already dead
    child.terminate()  # SIGTERM
    try:
        child.wait(timeout=REAP_GRACE_S)
        return
    except subprocess.TimeoutExpired:
        pass
    child.kill()  # SIGKILL
    try:
        child.wait(timeout=REAP_GRACE_S)
    except subprocess.TimeoutExpired:
        pass  # nothing more we can do


# --- Main ----------------------------------------------------------------

def _on_sigterm(signum, frame):
    # Turn SIGTERM into a normal unwind so the finally-block reaps the child.
    raise SystemExit(0)


def _watch_child(child):
    """Wait on the spawned server; when it exits for ANY reason (idle
    self-exit included), drop the native port so Chrome respawns a fresh
    host+server on the next engagement. If the main thread is already tearing
    down (Chrome-close/SIGTERM), it owns the reap — we back off."""
    child.wait()  # blocks until the child exits, however it exits
    global _shutting_down
    with _shutdown_lock:
        if _shutting_down:
            return  # main thread is reaping already; don't race it
        _shutting_down = True
    # Child is already dead, so there is nothing to reap; a hard exit here just
    # closes stdout -> the extension sees onDisconnect. os._exit skips the
    # finally block, which is fine precisely because the child is gone.
    remove_marker()
    sys.stderr.flush()
    os._exit(0)


def _watch_port():
    """Shared/external server (not owned): when it exits — claims expired,
    manual kill — drop the leash so Chrome respawns host+server on the next
    engagement. Mirrors _watch_child for the owned case."""
    global _shutting_down
    while True:
        time.sleep(PORT_WATCH_INTERVAL_S)
        if port_is_listening(PORT):
            continue
        with _shutdown_lock:
            if _shutting_down:
                return
            _shutting_down = True
        remove_marker()
        sys.stderr.flush()
        os._exit(0)


def main():
    signal.signal(signal.SIGTERM, _on_sigterm)

    owned = False
    child = None
    try:
        write_marker()
        owned, child, ok = start_server(PORT)
        send_message({"type": "server-status", "ok": ok, "owned": owned, "port": PORT})

        # Watch the server we own: if it self-exits on idle, we must exit too.
        if owned and child is not None:
            threading.Thread(target=_watch_child, args=(child,), daemon=True).start()
        elif ok:
            threading.Thread(target=_watch_port, daemon=True).start()

        # Block reading stdin. The read loop IS the leash: it returns None
        # the moment Chrome closes the port, and the finally-block reaps.
        while True:
            msg = read_message()
            if msg is None:
                break  # EOF -> Chrome disconnected
            if isinstance(msg, dict) and msg.get("type") == "ping":
                send_message({"type": "pong"})
            # ignore every other message type
    finally:
        remove_marker()
        # Claim the shutdown so the child-watch thread backs off instead of
        # racing an os._exit against our reap.
        global _shutting_down
        with _shutdown_lock:
            already = _shutting_down
            _shutting_down = True
        # ponytail: single-host reaping. Two Chrome profiles each spawn their
        #   own host; the second sees the port TAKEN -> owned=False -> harmless.
        #   But if the FIRST host (owner) exits while profile 2 still leashes,
        #   the server dies under profile 2. Acceptable known ceiling; upgrade
        #   path is a pidfile refcount, not built now.
        if owned and child is not None and not already:
            reap(child)  # no-op if the child already self-exited (poll guard)
    return 0


if __name__ == "__main__":
    sys.exit(main())
