# Extension development and load path

## Canonical Chrome load path

Load the unpacked extension from the repository root: the `highlighter`
directory that directly contains `manifest.json`.

Do not leave Chrome pointed at either of these temporary locations:

- `.worktrees/<feature-branch>` — an isolated development checkout
- `kokoro-extension-test/` — a generated scratch build

A worktree is appropriate while a feature is being tested. After the feature
is committed and integrated, remove that temporary extension entry from
`chrome://extensions` and load the repository root instead. This keeps Chrome
on the maintained branch and prevents an old worktree from silently becoming
the active extension.

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
3. Click **Load unpacked** and select the repository root.
4. If Chrome already points at the repository root, click **Reload** instead.
5. Refresh any page that was open during the extension reload before testing.

Selecting Highlighter from the browser toolbar should show **Starting native
Kokoro server…** followed by **Ready — native Kokoro server**. If the server is
already active, the popup may go directly to Ready. Opening the popup wakes
only the native companion; the built-in WASM fallback remains lazy until Play
or Test Voice.
