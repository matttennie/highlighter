import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));

describe('manifest.json', () => {
  it('declares the permissions the offscreen Kokoro engine needs', () => {
    assert.ok(manifest.permissions.includes('offscreen'), 'offscreen permission');
    assert.ok(manifest.permissions.includes('unlimitedStorage'), 'unlimitedStorage for the model cache');
    assert.ok(manifest.permissions.includes('activeTab'), 'activeTab for on-demand injection');
    assert.ok(manifest.permissions.includes('scripting'), 'scripting for on-demand injection');
  });

  it('allows WASM in extension pages', () => {
    assert.match(manifest.content_security_policy.extension_pages, /'wasm-unsafe-eval'/);
  });

  it('carries no remote API host permissions and no static content scripts', () => {
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_scripts, undefined);
    assert.doesNotMatch(JSON.stringify(manifest), /inworld/i);
  });

  it('requires Chrome 116+ for chrome.runtime.getContexts', () => {
    assert.ok(parseInt(manifest.minimum_chrome_version, 10) >= 116);
  });

  it('is version 0.2.0 with an on-device description', () => {
    assert.equal(manifest.version, '0.2.0');
    assert.match(manifest.description, /on-device|Kokoro/i);
  });
});
