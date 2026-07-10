# Highlighter

`Highlighter TTS` is a Chrome extension that lets you paint over text on a page and hear it read aloud.

## How it works

All speech is generated on your device by the Kokoro-82M model — no API
key, no cloud calls, no per-use cost. The extension speaks through one of
two backends, chosen automatically:

1. **Native companion server (best):** if the optional local server (see
   Setup below) is running, the extension routes synthesis to it over
   `http://127.0.0.1:8880` for near-instant, gapless playback.
2. **Built-in in-browser engine (default):** otherwise the extension runs
   Kokoro itself via WASM. On first use it downloads the voice model
   (~92 MB — one time, cached permanently); until that finishes, playback
   falls back to your system voice. Synthesis runs on-CPU for consistent
   audio quality, and the engine unloads itself after 15 minutes of
   inactivity, re-warming automatically the next time it's needed.

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
- **Extension Invalidation Handling:** Gracefully handles script communication failures when the extension is updated or reloaded.

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
- Select this folder

No API key or account is required. The first time you use the extension
without the native server running, it downloads the Kokoro voice model
(~92 MB) and caches it permanently.

### Native companion server (recommended)

For near-instant, gapless playback, install the local Kokoro server:

```bash
bash server/install.sh
```

This installs a `launchd` agent (`com.highlighter.kokoro`) that serves
Kokoro on `http://127.0.0.1:8880`, starts automatically at login, and
unloads the model after 15 idle minutes to save memory (it reloads on
the next request). It requires the Kokoro model files at
`~/.cache/kokoro/`; `install.sh` prints download instructions if they're
missing. Once installed, the extension detects and uses the server
automatically — no configuration needed.

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

Load the extension unpacked from the repo root (chrome://extensions →
Developer mode → Load unpacked) after running the build.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
