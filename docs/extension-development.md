# Extension development and load path

## Canonical Chrome load path

Load the unpacked extension from this stable generated folder:

```text
~/Desktop/AI/highlighter/chrome-extension
```

`npm run build` recreates that directory from an explicit runtime-file
allowlist. It contains only the files Chrome needs and stays under the main
project directory, so cleaning disposable worktrees cannot remove the loaded
extension. Do not edit files inside it; edit the source tree and rebuild.

Do not leave Chrome pointed at either of these temporary locations:

- `.worktrees/<feature-branch>` — an isolated development checkout
- `kokoro-extension-test/` — a generated scratch build

Do not point normal Chrome at the repository root either. The source root is
used only by the live development watcher; normal installs and automated
regressions use `chrome-extension/`.

A worktree is appropriate while a feature is being tested. After the feature
is committed and integrated, run the build from the maintained checkout,
remove that temporary extension entry from `chrome://extensions`, and load
the maintained checkout's `chrome-extension/` directory instead. This keeps
Chrome on the maintained branch and prevents an old worktree from silently
becoming the active extension.

## Build and reload checklist

From the repository root:

```bash
npm install
npm run build
npm test
```

Then:

1. Open `chrome://extensions` and enable Developer mode.
2. If Highlighter points at a worktree or scratch directory, remove it.
3. Click **Load unpacked** and select `highlighter/chrome-extension`.
4. If Chrome already points at that exact folder, click **Reload** instead.
5. Refresh any page that was open during the extension reload before testing.

Selecting Highlighter from the browser toolbar should show **Starting native
Kokoro server…** followed by **Ready — native Kokoro server**. If the server is
already active, the popup may go directly to Ready. Opening the popup wakes
only the native companion; the built-in WASM fallback remains lazy until Play
or Test Voice.
