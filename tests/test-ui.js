import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '..');
const contentJs = fs.readFileSync(path.join(rootDir, 'content', 'content.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(rootDir, 'content', 'content.css'), 'utf8');

describe('error presentation', () => {
  it('logs full response failures to the console', () => {
    assert.match(contentJs, /console\.error\('\[Highlighter TTS\] Response failure:'/);
  });

  it('uses a dedicated toast element for visible error messages', () => {
    assert.match(contentJs, /toastEl = document\.createElement\('div'\)/);
    assert.match(contentJs, /toastEl\.className = 'hltr-toast'/);
    assert.match(contentCss, /\.hltr-toast\s*\{/);
    assert.match(contentCss, /overflow-wrap:\s*anywhere/);
  });

  it('loads voice options dynamically and falls back to the configured voice', () => {
    assert.match(contentJs, /chrome\.runtime\.sendMessage\(\{ type: 'voices-request' \}/);
    assert.match(contentJs, /ensureVoiceOption\(selectEl, selectedVoice \|\| cachedVoice, 'Configured voice'\)/);
  });

  it('keeps the player open until explicitly closed and exposes player controls', () => {
    assert.match(contentJs, /hltr-highlight-btn/);
    assert.match(contentJs, /hltr-close-btn/);
    assert.match(contentJs, /toggleHighlightMode\(\)/);
    assert.doesNotMatch(contentJs, /if \(playerEl && playerEl\.classList\.contains\('hltr-visible'\)\) \{\s*sel\?\.removeAllRanges\(\);\s*hidePlayer\(\);\s*\}/);
  });

  it('styles the highlight button distinctly inside the player', () => {
    assert.match(contentCss, /\.hltr-highlight-btn\s*\{/);
    assert.match(contentCss, /\.hltr-close-btn\s*\{/);
  });

  it('does not log debugLog storage writes as settings changes', () => {
    assert.match(contentJs, /const relevantChangedKeys = \[\]/);
    assert.match(contentJs, /if \(!relevantChangedKeys\.length\) return;/);
    assert.doesNotMatch(contentJs, /changedKeys: Object\.keys\(changes\)/);
  });
});
