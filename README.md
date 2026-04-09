# Highlighter

`Highlighter TTS` is a Chrome extension that lets you paint over text on a page and hear it read aloud.

## Features

- Highlight mode with a brush-style cursor
- Floating playback transport with skip, play/pause, settings, close, and highlight toggle
- ElevenLabs text-to-speech integration
- Voice filtering so the popup only shows selectable voices
- Speed controls matched to the supported ElevenLabs range

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

3. Open the extension popup and paste an ElevenLabs API key.

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
ELEVENLABS_API_KEY=your_key node tests/playwright-extension-check.mjs
```
