import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
console.log(`build: bundled tts-engine and copied ${copied} ONNX runtime files`);
