import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const extensionDir = 'chrome-extension';

// Bundle the offscreen TTS engine. ESM because offscreen.html loads it
// with <script type="module">.
await build({
  entryPoints: ['offscreen/tts-engine.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'offscreen/tts-engine.bundle.js',
  // transformers.js references the Node backend behind a runtime guard;
  // mark it external so esbuild doesn't try to resolve it for the browser.
  external: ['onnxruntime-node'],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

// ONNX Runtime's WASM binaries must ship inside the extension package —
// MV3 forbids remote code, and transformers.js would otherwise pull them
// from a CDN at runtime.
const distDir = 'node_modules/@huggingface/transformers/dist';
const outDir = 'offscreen/ort';
mkdirSync(outDir, { recursive: true });
let copied = 0;
for (const f of readdirSync(distDir)) {
  if (f.startsWith('ort-') && (f.endsWith('.wasm') || f.endsWith('.mjs'))) {
    copyFileSync(join(distDir, f), join(outDir, f));
    copied++;
  }
}
if (copied === 0) {
  throw new Error(`no ort-*.wasm/.mjs files found in ${distDir} — transformers.js layout changed?`);
}

// Chrome should load a stable, visible artifact inside the project rather
// than the repository root or a disposable worktree. Recreate it from an
// explicit runtime allowlist so removed files cannot linger between builds
// and development-only files never enter the unpacked extension.
rmSync(extensionDir, { recursive: true, force: true });
const runtimeFiles = [
  'manifest.json',
  'background.js',
  'content/content.css',
  'content/content.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'popup/popup.html',
  'popup/popup.js',
  'offscreen/offscreen.html',
  'offscreen/tts-engine.bundle.js',
];

for (const file of runtimeFiles) {
  const destination = join(extensionDir, file);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(file, destination);
}

for (const file of readdirSync(outDir)) {
  if (file.startsWith('ort-') && (file.endsWith('.wasm') || file.endsWith('.mjs'))) {
    const destination = join(extensionDir, outDir, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(outDir, file), destination);
  }
}

console.log(
  `build: bundled tts-engine, copied ${copied} ONNX runtime files, and refreshed ${extensionDir}/`,
);
