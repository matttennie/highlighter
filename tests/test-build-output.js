import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const projectDir = path.resolve(import.meta.dirname, '..');
const extensionDir = path.join(projectDir, 'chrome-extension');
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

describe('generated Chrome load directory', () => {
  it('copies every declared runtime file byte-for-byte', () => {
    for (const file of runtimeFiles) {
      const source = fs.readFileSync(path.join(projectDir, file));
      const packaged = fs.readFileSync(path.join(extensionDir, file));
      assert.deepEqual(packaged, source, `${file} differs from its source`);
    }
  });

  it('copies the complete local ONNX runtime and no unrelated files', () => {
    const sourceDir = path.join(projectDir, 'offscreen', 'ort');
    const packagedDir = path.join(extensionDir, 'offscreen', 'ort');
    const expected = fs.readdirSync(sourceDir).sort();
    const actual = fs.readdirSync(packagedDir).sort();

    assert.ok(expected.length > 0, 'source ONNX runtime is empty');
    assert.deepEqual(actual, expected);
    for (const file of expected) {
      assert.match(file, /^ort-.*\.(?:mjs|wasm)$/);
      assert.deepEqual(
        fs.readFileSync(path.join(packagedDir, file)),
        fs.readFileSync(path.join(sourceDir, file)),
        `${file} differs from its source`,
      );
    }
  });

  it('excludes source, tests, server code, and package metadata', () => {
    for (const excluded of [
      'offscreen/tts-engine.js',
      'tests',
      'server',
      'scripts',
      'node_modules',
      'package.json',
      'package-lock.json',
    ]) {
      assert.equal(
        fs.existsSync(path.join(extensionDir, excluded)),
        false,
        `${excluded} must not enter the Chrome artifact`,
      );
    }
  });
});
