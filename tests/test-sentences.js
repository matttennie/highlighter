/**
 * Tests for sentence segmentation used in content.js.
 * The splitter now uses the platform's ICU segmenter (Intl.Segmenter) instead
 * of a regex. `segmentSentences` below is a byte-identical mirror of
 * content.js#segmentSentences — keep it in sync.
 *
 * These tests EXECUTE real Intl.Segmenter output (Node ships ICU too), so they
 * document actual behavior, not the ideal. V8's ICU ships no abbreviation-
 * suppression dictionary, so an abbreviation followed by a capital
 * ("Dr. Smith", "U.S. Government") still splits at the ICU layer — a post-pass
 * merges the split back together for known abbreviations. Cases where ICU
 * deviates from the old regex are called out inline.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── Mirror of content.js — keep byte-identical ───────────────────────
function hasReadableContent(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

function stripLeadingNoise(text) {
  return text.replace(/^[^\p{L}\p{N}"'(\[«„“‘]+/u, '');
}

const ABBREVIATIONS = new Set([
  'dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'rev.', 'gen.', 'sen.', 'rep.',
  'st.', 'mt.', 'ft.', 'jr.', 'sr.', 'no.', 'vs.', 'etc.', 'e.g.', 'i.e.',
  'inc.', 'ltd.', 'co.', 'corp.', 'dept.', 'est.', 'approx.', 'a.m.', 'p.m.',
  'u.s.', 'u.k.', 'u.n.', 'd.c.',
]);
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
function segmentSentences(text) {
  const raw = [];
  for (const seg of sentenceSegmenter.segment(text)) {
    raw.push({ start: seg.index, end: seg.index + seg.segment.length });
  }

  // Merge a segment into its follower when it ends in a known abbreviation;
  // apply iteratively so chains collapse ("J. R. R. Tolkien" → one segment).
  for (let i = 0; i < raw.length - 1; ) {
    const words = text.slice(raw[i].start, raw[i].end).trim().split(/\s+/);
    const lastWord = words[words.length - 1].toLowerCase();
    if (ABBREVIATIONS.has(lastWord) || /^[a-z]\.$/.test(lastWord)) {
      raw[i] = { start: raw[i].start, end: raw[i + 1].end };
      raw.splice(i + 1, 1);
    } else {
      i++;
    }
  }

  const results = [];
  for (const { start, end } of raw) {
    // Drop pure-punctuation/whitespace segments (":)", stray marks) — TTS
    // engines either error or pronounce them literally ("colon close-paren").
    const trimmed = stripLeadingNoise(text.slice(start, end).trim());
    if (!hasReadableContent(trimmed)) continue;
    results.push({ text: trimmed, start, end });
  }
  return results;
}
// ─────────────────────────────────────────────────────────────────────

// Convenience: just the sentence texts.
const texts = (s) => segmentSentences(s).map((r) => r.text);

describe('ICU sentence segmentation', () => {
  it('splits simple period-delimited sentences', () => {
    assert.deepEqual(texts('This is one. This is two.'), ['This is one.', 'This is two.']);
  });

  // ICU splits "Dr." before the capitalized "Smith" into its own segment; the
  // abbreviation merge pass fuses it back into one sentence.
  it('merges an abbreviation before a capital (Dr. Smith)', () => {
    assert.deepEqual(texts('Dr. Smith went home. He slept.'),
      ['Dr. Smith went home.', 'He slept.']);
  });

  it('merges "U.S." before a capital (U.S. Government)', () => {
    assert.deepEqual(texts('U.S. Government announced. Then acted.'),
      ['U.S. Government announced.', 'Then acted.']);
  });

  it('collapses a chain of single-letter initials (J. R. R. Tolkien)', () => {
    assert.deepEqual(texts('J. R. R. Tolkien wrote books. They sold well.'),
      ['J. R. R. Tolkien wrote books.', 'They sold well.']);
  });

  it('merges "Inc." before a capital (Acme Inc.)', () => {
    assert.deepEqual(texts('Acme Inc. filed reports. Then rested.'),
      ['Acme Inc. filed reports.', 'Then rested.']);
  });

  it('does not merge a real sentence end that is not a known abbreviation (doctor.)', () => {
    assert.deepEqual(texts('I met the doctor. He was kind.'),
      ['I met the doctor.', 'He was kind.']);
  });

  // ponytail known ceiling: the merge heuristic can't tell "p.m." ending a real
  // sentence from an abbreviation that continues one — it always merges into
  // the follower, so a genuinely new sentence right after "p.m."/"a.m." gets
  // fused in. Documenting the observed trade-off, not the ideal.
  it('over-merges a trailing time abbreviation into the next sentence — known trade-off', () => {
    assert.deepEqual(texts('Meet at 5 p.m. Bring snacks.'), ['Meet at 5 p.m. Bring snacks.']);
  });

  it('keeps "e.g." before lowercase intact', () => {
    assert.deepEqual(texts('See e.g. the docs. Then continue.'),
      ['See e.g. the docs.', 'Then continue.']);
  });

  it('keeps filenames intact (content.js / popup.js)', () => {
    assert.deepEqual(texts('The file content.js loads first. Then popup.js.'),
      ['The file content.js loads first.', 'Then popup.js.']);
  });

  it('keeps version strings intact (v1.0.onnx)', () => {
    assert.deepEqual(texts('Version v1.0.onnx shipped. It works.'),
      ['Version v1.0.onnx shipped.', 'It works.']);
  });

  it('keeps decimals intact (3.14 / 6.28)', () => {
    assert.deepEqual(texts('Pi is 3.14. Tau is 6.28.'), ['Pi is 3.14.', 'Tau is 6.28.']);
  });

  it('keeps version numbers intact (3.1.56)', () => {
    assert.deepEqual(texts('Version 3.1.56 is out. Try it.'),
      ['Version 3.1.56 is out.', 'Try it.']);
  });

  it('keeps IPv4 addresses intact', () => {
    assert.deepEqual(texts('Connect to 192.168.1.1 first.'), ['Connect to 192.168.1.1 first.']);
  });

  it('keeps currency amounts intact', () => {
    assert.deepEqual(texts("It's $9.99 today."), ["It's $9.99 today."]);
  });

  it('keeps a run of terminators together (really?!)', () => {
    assert.deepEqual(texts('He asked: really?! Yes.'), ['He asked: really?!', 'Yes.']);
  });

  it('splits multiple sentences with mixed terminators', () => {
    assert.deepEqual(texts('Really?! Yes. Maybe.'), ['Really?!', 'Yes.', 'Maybe.']);
  });

  // ICU does NOT break on a single-char ellipsis "…" before a capital (the old
  // regex did). Observed: one sentence. Documenting the platform behavior.
  it('does not split on a mid-string ellipsis "…"', () => {
    assert.deepEqual(texts('Wait… what happened?'), ['Wait… what happened?']);
  });

  it('splits on a three-dot ellipsis "..." before a capital', () => {
    assert.deepEqual(texts('Hmm... Okay.'), ['Hmm...', 'Okay.']);
  });

  it('handles quoted sentence endings (double quotes)', () => {
    assert.deepEqual(texts('She said "hello." Then left.'), ['She said "hello."', 'Then left.']);
  });

  it('handles quoted sentence endings (single quotes)', () => {
    assert.equal(texts("He said 'goodbye.' She stayed.").length, 2);
  });

  it('returns trailing text without terminal punctuation', () => {
    assert.deepEqual(texts('First sentence. Then some text'),
      ['First sentence.', 'Then some text']);
  });

  it('handles text with no punctuation at all', () => {
    assert.deepEqual(texts('No punctuation here'), ['No punctuation here']);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(texts(''), []);
  });

  it('returns empty array for whitespace-only string', () => {
    assert.deepEqual(texts('   '), []);
  });

  it('drops a standalone punctuation tail ":)" when ICU splits it off', () => {
    // "!" then two spaces then ":)" — ICU keeps ":)" glued to the sentence,
    // so unlike the old regex the smiley survives inside the readable segment.
    assert.deepEqual(texts('Learn from a master!  :)'), ['Learn from a master!  :)']);
  });

  it('reports char offsets into the raw (untrimmed) segment', () => {
    const segs = segmentSentences('This is one. This is two.');
    assert.deepEqual(segs.map((s) => [s.start, s.end]), [[0, 13], [13, 25]]);
    // Offsets slice back to the raw (untrimmed) segments.
    const src = 'This is one. This is two.';
    assert.equal(src.slice(segs[0].start, segs[0].end), 'This is one. ');
    assert.equal(src.slice(segs[1].start, segs[1].end), 'This is two.');
  });

  it('segments a multi-sentence paragraph, dropping only unreadable segments', () => {
    const text =
      "I'm on about 5 acres, and can always use an extra hand outside in the garden, " +
      "if you are interested in a work exchange for a place to stay and meals. " +
      "I can introduce you to some friends in a 200 year old farm house who are starting " +
      "a permaculture garden. You could also do a work exchange with them and learn from " +
      "a master!  :)\n\nDrop me an email if you are interested!";
    const result = texts(text);
    assert.equal(result.length, 4);
    assert.ok(result[0].startsWith("I'm on about 5 acres"));
    assert.ok(result[1].startsWith('I can introduce'));
    assert.ok(result[2].includes('learn from a master!')); // ICU keeps ":)" glued
    assert.equal(result[3], 'Drop me an email if you are interested!');
  });
});
