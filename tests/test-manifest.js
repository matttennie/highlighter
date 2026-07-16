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

  it('restricts host permissions to the local native companion server, with no content scripts', () => {
    // Only the loopback native Kokoro server needs a host permission — never <all_urls>.
    assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
    assert.equal(manifest.content_scripts, undefined);
    assert.doesNotMatch(JSON.stringify(manifest), /inworld/i);
    assert.doesNotMatch(JSON.stringify(manifest), /<all_urls>/);
  });

  it('requires Chrome 116+ for chrome.runtime.getContexts', () => {
    assert.ok(parseInt(manifest.minimum_chrome_version, 10) >= 116);
  });

  it('declares nativeMessaging for the Chrome-owned server lifecycle host', () => {
    assert.ok(manifest.permissions.includes('nativeMessaging'), 'nativeMessaging permission for connectNative');
  });

  it('pins the extension key so the id matches the installed native-messaging manifest', () => {
    // The allowed_origins in the installed native-messaging host manifest are
    // gated to chrome-extension://<id>/, and <id> is derived from this key.
    // Changing the key changes the id and breaks connectNative.
    assert.equal(
      manifest.key,
      'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0cnGDbD6hTs8s8d13JDM5wGOA76o9438wdc3yF9U0rK9Q5HAUhDk6L9Z2EKvmOFQ3kozZMciEXeu7ZgBmTAySPEOSpMW79U1X9dP4BJ7chscNxiwmu8fi0LFKdh5xM6foAvnaj4tjGJILmTHjfZryJXTBYrOR3sIx3ZFgGhe0pwqQDEGJklSML25CrhwTrNAYE8Xjky7U5pb7r03MMS87ZMVtENg9jXqSLtYN9Eu62jMRzkxwxzvvZXCWJlrj6RmeRcHb4E88gCd4G/0hjFoJy03xIVqq47YelEM8GH5kJRHQJY9BP3Bhozz2R08yZll5yx2HOxXNzCEbuS2/devgQIDAQAB',
    );
  });

  it('is version 0.2.0 with an on-device description', () => {
    assert.equal(manifest.version, '0.2.0');
    assert.match(manifest.description, /on-device|Kokoro/i);
  });

  it('enables cross-origin isolation so WASM inference can use threads', () => {
    assert.equal(manifest.cross_origin_opener_policy?.value, 'same-origin');
    assert.equal(manifest.cross_origin_embedder_policy?.value, 'require-corp');
  });
});
