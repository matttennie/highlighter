/**
 * Tests for the sentence-splitting regex used in content.js.
 * Validates that text is split into sentences correctly.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Sentence-splitting logic extracted from content.js extractSentencesFromBlock
const sentenceRe = /[^!.?…]*(?:[!.?…]+['"'"]?\s*)/g;

function splitSentences(text) {
  const results = [];
  let match, consumed = 0;
  sentenceRe.lastIndex = 0;

  while ((match = sentenceRe.exec(text)) !== null) {
    const raw = match[0];
    if (!raw.trim()) { consumed = match.index + raw.length; continue; }
    results.push(raw.trim());
    consumed = match.index + raw.length;
  }

  const tail = text.slice(consumed).trim();
  if (tail) results.push(tail);
  return results;
}

describe('Sentence splitting regex', () => {
  it('splits simple period-delimited sentences', () => {
    const result = splitSentences('Hello world. How are you.');
    assert.deepEqual(result, ['Hello world.', 'How are you.']);
  });

  it('splits sentences with different terminators', () => {
    const result = splitSentences('Hello world. How are you? I am fine!');
    assert.deepEqual(result, ['Hello world.', 'How are you?', 'I am fine!']);
  });

  it('handles ellipsis character', () => {
    const result = splitSentences('Wait for it\u2026 Then it happened.');
    assert.deepEqual(result, ['Wait for it\u2026', 'Then it happened.']);
  });

  it('handles three-dot ellipsis', () => {
    const result = splitSentences('Hmm... Okay.');
    assert.equal(result.length, 2);
    assert.equal(result[0], 'Hmm...');
    assert.equal(result[1], 'Okay.');
  });

  it('handles quoted sentence endings', () => {
    const result = splitSentences('She said "hello." Then left.');
    assert.deepEqual(result, ['She said "hello."', 'Then left.']);
  });

  it('handles smart-quoted endings', () => {
    const result = splitSentences('He whispered "run.\u201D She ran.');
    assert.equal(result.length, 2);
  });

  it('returns trailing text without punctuation', () => {
    const result = splitSentences('First sentence. Then some text');
    assert.equal(result.length, 2);
    assert.equal(result[0], 'First sentence.');
    assert.equal(result[1], 'Then some text');
  });

  it('handles text with no punctuation at all', () => {
    const result = splitSentences('No punctuation here');
    assert.deepEqual(result, ['No punctuation here']);
  });

  it('returns empty array for empty string', () => {
    const result = splitSentences('');
    assert.deepEqual(result, []);
  });

  it('returns empty array for whitespace-only string', () => {
    const result = splitSentences('   ');
    assert.deepEqual(result, []);
  });

  it('handles multiple punctuation marks', () => {
    const result = splitSentences('Really?! Yes. Maybe.');
    assert.equal(result.length, 3);
    assert.equal(result[0], 'Really?!');
    assert.equal(result[1], 'Yes.');
    assert.equal(result[2], 'Maybe.');
  });

  it('handles single sentence with terminal punctuation', () => {
    const result = splitSentences('Just one sentence.');
    assert.deepEqual(result, ['Just one sentence.']);
  });

  it('handles abbreviations (known limitation — splits on them)', () => {
    const result = splitSentences('Mr. Smith went home.');
    // Regex splits on the period in "Mr." — this is a known tradeoff
    assert.ok(result.length >= 2, 'abbreviations cause extra splits');
  });
});
