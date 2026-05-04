/**
 * Tests for the sentence-splitting regex used in content.js.
 * Validates that text is split into sentences correctly.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Sentence-splitting logic extracted from content.js extractSentencesFromBlock.
// Keep in sync with the production regex.
const sentenceRe = /[^!?…]*?(?:[!?…]+|\.(?!\d)|(?<!\d)\.)+["'”’]?\s*/g;

function hasReadableContent(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

function stripLeadingNoise(text) {
  return text.replace(/^[^\p{L}\p{N}"'(\[«„“‘]+/u, '');
}

function splitSentences(text) {
  const results = [];
  let consumed = 0;
  for (const match of text.matchAll(sentenceRe)) {
    const raw = match[0];
    const trimmed = stripLeadingNoise(raw.trim());
    if (!hasReadableContent(trimmed)) {
      consumed = match.index + raw.length;
      continue;
    }
    results.push(trimmed);
    consumed = match.index + raw.length;
  }
  const tail = stripLeadingNoise(text.slice(consumed).trim());
  if (hasReadableContent(tail)) results.push(tail);
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
    const result = splitSentences('Wait for it… Then it happened.');
    assert.deepEqual(result, ['Wait for it…', 'Then it happened.']);
  });

  it('handles three-dot ellipsis', () => {
    const result = splitSentences('Hmm... Okay.');
    assert.equal(result.length, 2);
    assert.equal(result[0], 'Hmm...');
    assert.equal(result[1], 'Okay.');
  });

  it('handles quoted sentence endings with double quotes', () => {
    const result = splitSentences('She said "hello." Then left.');
    assert.deepEqual(result, ['She said "hello."', 'Then left.']);
  });

  it('handles quoted sentence endings with single quotes', () => {
    const result = splitSentences("He said 'goodbye.' She stayed.");
    assert.equal(result.length, 2);
  });

  it('handles smart-quoted endings', () => {
    const result = splitSentences('He whispered "run.” She ran.');
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

  it('keeps version numbers intact', () => {
    const result = splitSentences('Version 3.1.56 is out. Try it.');
    assert.deepEqual(result, ['Version 3.1.56 is out.', 'Try it.']);
  });

  it('keeps decimal numbers intact mid-sentence', () => {
    const result = splitSentences('Pi is 3.14 and that matters.');
    assert.deepEqual(result, ['Pi is 3.14 and that matters.']);
  });

  it('keeps decimal numbers intact even before a real terminator', () => {
    const result = splitSentences('Pi is 3.14. End.');
    assert.deepEqual(result, ['Pi is 3.14.', 'End.']);
  });

  it('keeps IPv4 addresses intact', () => {
    const result = splitSentences('Connect to 192.168.1.1 first.');
    assert.deepEqual(result, ['Connect to 192.168.1.1 first.']);
  });

  it('keeps currency amounts intact', () => {
    const result = splitSentences("It's $9.99 today.");
    assert.deepEqual(result, ["It's $9.99 today."]);
  });

  it('drops standalone punctuation tails like ":)"', () => {
    const result = splitSentences('Learn from a master!  :)');
    assert.deepEqual(result, ['Learn from a master!']);
  });

  it('drops a standalone smiley between sentences', () => {
    const result = splitSentences('First sentence. :) Second sentence.');
    assert.equal(result.length, 2);
    assert.equal(result[0], 'First sentence.');
    assert.ok(result[1].endsWith('Second sentence.'));
  });

  it('handles the work-exchange paragraph cleanly', () => {
    const text =
      "I'm on about 5 acres, and can always use an extra hand outside in the garden, " +
      "if you are interested in a work exchange for a place to stay and meals. " +
      "I can introduce you to some friends in a 200 year old farm house who are starting " +
      "a permaculture garden. You could also do a work exchange with them and learn from " +
      "a master!  :)\n\nDrop me an email if you are interested!";
    const result = splitSentences(text);
    assert.equal(result.length, 4);
    assert.ok(result[0].startsWith("I'm on about 5 acres"));
    assert.ok(result[1].startsWith("I can introduce"));
    assert.ok(result[2].endsWith("master!"));
    assert.equal(result[3], 'Drop me an email if you are interested!');
  });
});
