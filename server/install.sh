#!/usr/bin/env bash
# Idempotent installer for the local native Kokoro companion server.
#
# The server is Chrome-owned: it runs ONLY while the extension is engaged.
# Chrome spawns native_host.py via native messaging, which spawns
# kokoro_server.py and reaps it when Chrome disconnects.
#
# The runtime host is installed OUTSIDE the dev checkout, into
# ~/Library/Application Support/HighlighterTTS. macOS TCC protects ~/Desktop
# (and Documents/Downloads): a GUI app like Chrome is silently blocked from
# exec'ing anything under those dirs, so a host that lives in the checkout
# never runs when Chrome spawns it. Application Support is NOT TCC-protected.
# This installer COPIES the runtime files there, builds the venv there, and
# points Chrome's native-messaging manifest at that copy. It starts nothing —
# Chrome spawns the host on demand when the extension engages.
#
# Usage: ./install.sh <extension-id>
#   <extension-id> is the ID shown at chrome://extensions (Developer mode on)
#   for the loaded Highlighter extension. Without it, everything installs but
#   the manifest carries a placeholder you must edit, and we exit 2.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Runtime install location, outside TCC-protected dirs so Chrome can exec it.
INSTALL_DIR="$HOME/Library/Application Support/HighlighterTTS"
LAUNCHER="$INSTALL_DIR/native_host_launcher.sh"
PYTHON_BIN="$INSTALL_DIR/.venv/bin/python3"
NATIVE_HOST_PY="$INSTALL_DIR/native_host.py"

MODEL_DIR="${KOKORO_MODEL_DIR:-$HOME/.cache/kokoro}"
MODEL_PATH="${KOKORO_MODEL_PATH:-$MODEL_DIR/kokoro-v1.0.onnx}"
VOICES_PATH="${KOKORO_VOICES_PATH:-$MODEL_DIR/voices-v1.0.bin}"

HOST_NAME="com.highlighter.kokoro"
OLD_PLIST_PATH="$HOME/Library/LaunchAgents/${HOST_NAME}.plist"

EXTENSION_ID="${1:-}"

echo "==> Highlighter native Kokoro server installer"

# 1. Model files -----------------------------------------------------------
# ~/.cache/kokoro is not TCC-protected, so leaving the models there is fine.
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

# 2. Retire the old always-on launchd agent --------------------------------
# The server is Chrome-owned now; the login-time launchd agent is gone.
launchctl unload "$OLD_PLIST_PATH" >/dev/null 2>&1 || true
rm -f "$OLD_PLIST_PATH"
echo "==> Retired old launchd agent (if any)"

# 3. Install runtime files into Application Support (outside TCC) -----------
# Copy the two runtime Python files out of the checkout. These copies —
# never the ~/Desktop originals — are what Chrome execs. native_host.py
# resolves kokoro_server.py next to itself, so both must land together.
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/native_host.py" "$SCRIPT_DIR/kokoro_server.py" "$INSTALL_DIR/"
echo "==> Copied native_host.py + kokoro_server.py to $INSTALL_DIR"

# 4. venv + kokoro-onnx, inside the install dir ----------------------------
if [ ! -d "$INSTALL_DIR/.venv" ]; then
    echo "==> Creating venv at $INSTALL_DIR/.venv"
    python3 -m venv "$INSTALL_DIR/.venv"
else
    echo "==> venv already exists at $INSTALL_DIR/.venv"
fi
echo "==> Installing/upgrading kokoro-onnx"
"$INSTALL_DIR/.venv/bin/pip" install --quiet --upgrade kokoro-onnx

# 5. Native-host launcher wrapper ------------------------------------------
# Chrome native-messaging manifests support only a single "path" executable —
# there is NO "args" field — so we can't point path at the venv python with
# native_host.py as an argument; we point it at this 2-line wrapper. Its
# absolute paths point INTO the install dir, not the repo.
cat > "$LAUNCHER" <<LAUNCH
#!/bin/bash
exec "$PYTHON_BIN" "$NATIVE_HOST_PY"
LAUNCH
chmod +x "$LAUNCHER"
echo "==> Wrote launcher $LAUNCHER"

# 6. Native-messaging host manifest ----------------------------------------
if [ -z "$EXTENSION_ID" ]; then
    EXTENSION_ID="EXTENSION_ID"   # placeholder the user must edit
    MISSING_ID=1
    echo "==> No extension id given. Installing with a placeholder origin."
    echo "    Find the id at chrome://extensions (enable Developer mode),"
    echo "    then re-run: ./install.sh <extension-id>"
    echo "    (or edit allowed_origins in the manifest files below by hand)."
else
    MISSING_ID=0
fi

CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
CHROMIUM_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"

for DIR in "$CHROME_DIR" "$CHROMIUM_DIR"; do
    mkdir -p "$DIR"
    cat > "$DIR/${HOST_NAME}.json" <<MANIFEST
{
  "name": "${HOST_NAME}",
  "description": "Highlighter TTS companion server lifecycle host",
  "path": "${LAUNCHER}",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://${EXTENSION_ID}/"]
}
MANIFEST
    echo "==> Wrote $DIR/${HOST_NAME}.json"
done

# 7. Clear quarantine/provenance xattrs on the installed files -------------
# A GUI app can refuse to exec files carrying com.apple.quarantine.
xattr -c "$INSTALL_DIR"/* 2>/dev/null || true

# 8. Ad-hoc sign bundled native libraries ----------------------------------
# The pip wheels (espeakng-loader, onnxruntime, …) ship unsigned .dylib/.so
# files. Once Chrome — a GUI app — is the process that loads them, macOS
# flags each unsigned library ("could not verify it is free of malware").
# An ad-hoc signature gives the code a stable local identity, which
# suppresses the warning without altering behavior. We are only signing
# wheels pip fetched from PyPI, so this asserts a local identity, not
# authorship.
if command -v codesign >/dev/null 2>&1; then
    find "$INSTALL_DIR/.venv" \( -name "*.dylib" -o -name "*.so" \) -print0 2>/dev/null \
        | xargs -0 -I{} codesign --force --sign - "{}" >/dev/null 2>&1 || true
    echo "==> Ad-hoc signed bundled native libraries"
fi

# 9. Done — Chrome starts the server, not us -------------------------------
if [ "$MISSING_ID" -eq 1 ]; then
    echo "installed — host manifest has a PLACEHOLDER origin; re-run with your extension id"
    exit 2
fi

echo "installed into $INSTALL_DIR — native-messaging host registered. Chrome will start the Kokoro server on demand when the extension engages; this installer starts nothing."
