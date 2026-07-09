#!/usr/bin/env bash
# Idempotent installer for the local native Kokoro companion server.
#
# Sets up a venv with kokoro-onnx, verifies the model files are present,
# installs a launchd agent that runs kokoro_server.py on login and keeps it
# alive, and does a health-check curl against the running server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR="$SCRIPT_DIR/.venv"
SERVER_PY="$SCRIPT_DIR/kokoro_server.py"
PORT="${KOKORO_HTTP_PORT:-8880}"

MODEL_DIR="${KOKORO_MODEL_DIR:-$HOME/.cache/kokoro}"
MODEL_PATH="${KOKORO_MODEL_PATH:-$MODEL_DIR/kokoro-v1.0.onnx}"
VOICES_PATH="${KOKORO_VOICES_PATH:-$MODEL_DIR/voices-v1.0.bin}"

PLIST_LABEL="com.highlighter.kokoro"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
ERR_LOG="/tmp/highlighter-kokoro.err"

echo "==> Highlighter native Kokoro server installer"

# 1. venv + kokoro-onnx --------------------------------------------------
if [ ! -d "$VENV_DIR" ]; then
    echo "==> Creating venv at $VENV_DIR"
    python3 -m venv "$VENV_DIR"
else
    echo "==> venv already exists at $VENV_DIR"
fi

echo "==> Installing/upgrading kokoro-onnx"
"$VENV_DIR/bin/pip" install --quiet --upgrade kokoro-onnx

# 2. Model files -----------------------------------------------------------
if [ ! -f "$MODEL_PATH" ] || [ ! -f "$VOICES_PATH" ]; then
    echo "==> Model files not found."
    echo "    Expected:"
    echo "      $MODEL_PATH"
    echo "      $VOICES_PATH"
    echo ""
    echo "    Download them with:"
    echo ""
    echo "    mkdir -p \"$MODEL_DIR\""
    echo "    curl -L -o \"$MODEL_PATH\" https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
    echo "    curl -L -o \"$VOICES_PATH\" https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
    echo ""
    echo "installed — FAILED: model files missing"
    exit 1
fi
echo "==> Model files present"

# 3. launchd plist -----------------------------------------------------------
PYTHON_BIN="$VENV_DIR/bin/python3"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${PYTHON_BIN}</string>
        <string>${SERVER_PY}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>${ERR_LOG}</string>
</dict>
</plist>
PLIST
echo "==> Wrote $PLIST_PATH"

# 4. (re)load the agent and health-check ------------------------------------
launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"
echo "==> Loaded launchd agent ${PLIST_LABEL}"

echo "==> Waiting for server to answer /health (up to 20s)"
ok=""
for _ in $(seq 1 20); do
    if response="$(curl -s -m 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null)"; then
        if [ -n "$response" ]; then
            ok="$response"
            break
        fi
    fi
    sleep 1
done

if [ -n "$ok" ]; then
    echo "==> Health check: $ok"
    echo "installed — server on http://127.0.0.1:${PORT}"
else
    echo "==> Health check failed after 20s. Check $ERR_LOG for details."
    echo "installed — FAILED: server did not respond on http://127.0.0.1:${PORT}"
    exit 1
fi
