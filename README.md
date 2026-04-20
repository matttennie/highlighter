# Highlighter

`Highlighter TTS` is a Chrome extension that lets you paint over text on a page and hear it read aloud.

## Features

- **Highlight Mode:** Brush-style cursor for intuitive text selection.
- **Floating Transport:** Play, pause, skip, and adjust settings from a draggable in-page player.
- **TTS Integration:** High-quality speech via Inworld AI (TTS 1.5 Max/Mini).
- **Voice Management:** Dynamic voice list fetched from the Inworld API.
- **Robustness:** Built-in fallbacks to browser `speechSynthesis` when API limits are hit or CSP blocks external audio.

## Stability & Robustness

This extension is built for production-grade reliability:
- **Stale Request Guard:** Prevents overlapping audio by invalidating old TTS requests during rapid skipping.
- **Injection Filtering:** Automatically skips injection on restricted URLs (e.g., `chrome://`, Chrome Web Store) to prevent console noise and permission errors.
- **Resource Management:** Explicit `Audio` object cleanup and event listener nulling to prevent memory leaks in long sessions.
- **Extension Invalidation Handling:** Gracefully handles script communication failures when the extension is updated or reloaded.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Load the extension in Chrome:

- Open `chrome://extensions`
- Enable `Developer mode`
- Click `Load unpacked`
- Select this folder

3. Open the extension popup and paste an Inworld API key.

## Usage

- Toggle highlight mode from the extension context menu or `Alt+H`
- Paint across text to select it
- Use the floating transport to play, pause, skip, change settings, or re-enter highlight mode

## Development

- Run tests:

```bash
npm test
```

- End-to-end extension check with Playwright:

```bash
INWORLD_API_KEY=your_key node tests/playwright-extension-check.mjs
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
