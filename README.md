# Highlighter

`Highlighter TTS` is a Chrome extension that lets you paint over text on a page and hear it read aloud.

## How it works

All speech is generated on your device by the Kokoro-82M model — no API
key, no cloud calls, no per-use cost. The extension speaks through one of
two backends, chosen automatically:

1. **Native companion server (best):** after the optional local companion is
   installed (see Setup below), selecting Highlighter in Chrome's toolbar
   starts or reconnects to its server at `http://127.0.0.1:8880`. Starting it
   before text selection reduces time to first playback.
2. **Built-in in-browser engine (default):** otherwise the extension runs
   Kokoro itself via WASM. The engine starts only when you press Play or
   Test Voice; opening the toolbar popup wakes only the native companion and
   does not load this WASM fallback. On the first synthesis request it
   downloads the voice model (~92 MB — one time, cached permanently); until
   that finishes, playback falls back to your system voice. Synthesis runs
   on-CPU for consistent audio quality, and the engine unloads itself after 15
   minutes of inactivity, re-warming automatically when it is next needed.

Either way, playback adds brief natural pauses between sentences and
longer ones at paragraph breaks so speech doesn't sound rushed.

## Features

- **Highlight Mode:** Brush-style cursor for intuitive text selection.
- **Floating Transport:** Play, pause, skip, and adjust settings from a draggable in-page player.
- **On-Device TTS:** Speech synthesized locally by the Kokoro-82M model.
- **Voice Management:** Grouped list of on-device Kokoro voices with adjustable playback speed.
- **Robustness:** Falls back to the browser's `speechSynthesis` while the voice model is still downloading or if on-device synthesis fails.

## Stability & Robustness

This extension is built for production-grade reliability:
- **Stale Request Guard:** Prevents overlapping audio by invalidating old TTS requests during rapid skipping.
- **Injection Filtering:** Automatically skips injection on restricted URLs (e.g., `chrome://`, Chrome Web Store) to prevent console noise and permission errors.
- **Resource Management:** Explicit `Audio` object cleanup and event listener nulling to prevent memory leaks in long sessions.
- **Efficient Page Scanning:** Linear sentence segmentation and one-pass DOM range mapping are cached until page content mutates; viewport geometry is refreshed per stroke for correctness.
- **Bounded Brush Rendering:** Pointer jitter is decimated, retained path points are capped, and SVG updates are coalesced to animation frames.
- **Binary Audio Cache:** Synthesized base64 is decoded once into bounded LRU `Blob` entries, avoiding repeat decode/allocation work during replay and skip-back.
- **Extension Reload Recovery:** A stale page context still reveals the player with a clear reconnect warning and system-voice fallback; the next activation replaces stale UI/listeners cleanly.

## Setup

1. Install dependencies and build the offscreen TTS engine:

```bash
npm install
npm run build
```

2. Load the extension in Chrome:

- Open `chrome://extensions`
- Enable `Developer mode`
- Click `Load unpacked`
- Select `~/Desktop/AI/highlighter/chrome-extension`. This visible, generated
  folder is refreshed by `npm run build` and is the canonical unpacked-extension
  path. Do not leave Chrome pointed at the repository root, a temporary
  `.worktrees/...` checkout, or the `kokoro-extension-test` scratch build.

No API key or account is required. The first time you synthesize speech without
the native server running, it downloads the Kokoro voice model (~92 MB) and
caches it permanently. Opening the popup starts the installed native server,
but choosing a voice or enabling Highlight Mode does not start the WASM model
download.

### Native companion server (recommended)

For near-instant, gapless playback, install the local Kokoro server:

```bash
bash server/install.sh <extension-id>
```

This registers Chrome's native-messaging lifecycle host and installs its
runtime under `~/Library/Application Support/HighlighterTTS`. Selecting
Highlighter in the browser toolbar then starts Kokoro on
`http://127.0.0.1:8880` on demand instead of at login. The server exits after
its idle/lifecycle window and is started again on the next toolbar selection
or synthesis request. It requires the Kokoro model files at `~/.cache/kokoro/`;
`install.sh` prints download instructions if they're missing. The extension ID
is shown on `chrome://extensions` with Developer mode enabled.

#### Troubleshooting: “libespeak-ng.dylib” Not Opened popup (macOS)

The `espeakng_loader` pip wheel ships an unsigned `libespeak-ng.dylib`,
and `phonemizer` loads a fresh temp-dir *copy* of it on every model load.
macOS Gatekeeper records popup denials by content hash (cdhash), so once
the popup is dismissed, every identical copy stays blocked and the popup
recurs forever. Fix — re-sign with a **new identifier** (a plain re-sign
keeps the denied hash) and restart the server:

```bash
codesign --force --sign - --identifier highlighter-espeak-$(date +%s) \
  <venv>/lib/python*/site-packages/espeakng_loader/libespeak-ng*.dylib
pkill -f kokoro_server.py   # a running server keeps failing until restarted
```

Apply to whichever venv the server runs from (`server/.venv` and/or
`~/Library/Application Support/HighlighterTTS/.venv`). Must be re-run
after any venv rebuild or `espeakng_loader` reinstall. TODO: fold this
into `server/install.sh` as an install step before shipping to end users.

## Usage

- Toggle highlight mode from the extension context menu or `Alt+H`
- Paint across text to select it
- Use the floating transport to play, pause, skip, change settings, or re-enter highlight mode

## Development

```bash
npm install
npm run build   # bundles the offscreen TTS engine (required before loading)
npm test        # unit tests
```

Load the extension unpacked from `chrome-extension/` (`chrome://extensions` →
Developer mode → Load unpacked) after running the build. See
[Extension development and load path](docs/extension-development.md) for the
reload checklist and worktree handoff procedure.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
