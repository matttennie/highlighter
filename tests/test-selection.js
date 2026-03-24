/**
 * Unit tests for the sentence selection logic.
 * Runs in plain Node.js — no browser required.
 *
 * Tests the pure geometry of each code path in findFirstSentenceIdx.
 * Path 1 (DOM Range.compareBoundaryPoints) requires a browser and is not tested here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── Pure geometry extracted from findFirstSentenceIdx ─────────────────────────

const LINE_TOLERANCE = 14; // for END line detection

/**
 * Path 2 geometry: caret snapped to line above topPt.y (blank space between paras).
 * Find the first sentence at or just below topPt — NOT using wide lineHeight tolerance.
 */
function findFirst_blankSpace(sentences, topY) {
  const idx = sentences.findIndex(s => s.startLineY >= topY - 6);
  return idx !== -1 ? idx : sentences.length - 1;
}

/**
 * Path 3 geometry: no caret available — best-effort using estimated lineHeight.
 */
function findFirst_noRange(sentences, topY, rawLineHeight) {
  const tol = Math.min(rawLineHeight - 1, 47);
  return sentences.findIndex(s => s.startLineY >= topY - tol);
}

/**
 * End detection — unchanged from original.
 */
function findLastIdx(sentences, firstIdx, botY) {
  let lastIdx = -1;
  for (let i = firstIdx; i < sentences.length; i++) {
    if (sentences[i].endLineY > botY + LINE_TOLERANCE) break;
    if (sentences[i].endLineY <= botY + LINE_TOLERANCE) lastIdx = i;
  }
  return lastIdx;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSentences(lineYs) {
  return lineYs.map((y, i) => ({
    text: `Sentence ${i + 1} at y=${y}.`,
    startLineY: y,
    endLineY: y,
  }));
}

// ── Tests: Path 2 (blank space) ───────────────────────────────────────────────

describe('Path 2 — blank space between paragraphs', () => {
  // This is the critical regression: "Create a billing..." at y=260 (para A),
  // rocket-ship at y=295 (para B), user strokes at y=285 (in the gap).
  const sentences = makeSentences([260, 295]);

  it('stroke in gap (topY=285), caret snapped to para A (y=260, LH=24) → para B selected', () => {
    // caretY=260, caretLH=24 → 285 >= 284 → path 2
    // Expected: first sentence with startLineY >= 285-6=279 → y=295 (idx=1)
    const idx = findFirst_blankSpace(sentences, 285);
    assert.equal(idx, 1, `expected para B (idx=1, y=295), got idx=${idx} (y=${sentences[idx]?.startLineY})`);
  });

  it('stroke at very start of gap (topY=284, just past para A end)', () => {
    // para A line ends at 260+24=284; topY=284 is right at the boundary
    // threshold = 284-6 = 278 → y=295 >= 278 ✓ → idx=1
    const idx = findFirst_blankSpace(sentences, 284);
    assert.equal(idx, 1);
  });

  it('stroke right above para B (topY=293) → para B selected', () => {
    // threshold = 293-6 = 287 → y=295 >= 287 ✓ → idx=1
    const idx = findFirst_blankSpace(sentences, 293);
    assert.equal(idx, 1);
  });

  it('stroke right at para B start (topY=295) → para B selected', () => {
    // threshold = 289 → y=295 >= 289 ✓ → idx=1
    const idx = findFirst_blankSpace(sentences, 295);
    assert.equal(idx, 1);
  });

  it('para A is NOT included in any of the above scenarios', () => {
    for (const topY of [284, 285, 287, 290, 293, 295]) {
      const idx = findFirst_blankSpace(sentences, topY);
      assert.ok(
        sentences[idx].startLineY >= 290,
        `topY=${topY}: expected para B (y>=290), got idx=${idx} y=${sentences[idx]?.startLineY}`
      );
    }
  });
});

// ── Tests: Path 3 (geometry fallback, no caret) ───────────────────────────────

describe('Path 3 — geometry fallback (no caret)', () => {
  const sentences = makeSentences([0, 24, 48, 72, 96]);
  const LH = 24;

  it('stroke at top of line (topY=48) → correct line', () => {
    assert.equal(findFirst_noRange(sentences, 48, LH), 2);
  });

  it('stroke at middle of line (topY=60) → correct line', () => {
    // tol=23, threshold=37. y=48 >= 37 → idx=2 ✓
    assert.equal(findFirst_noRange(sentences, 60, LH), 2);
  });

  it('stroke at bottom of line (topY=70) → correct line', () => {
    // tol=23, threshold=47. y=48 >= 47 → idx=2 ✓
    assert.equal(findFirst_noRange(sentences, 70, LH), 2);
  });

  it('stroke at 3/4 of line (topY=90) → correct line', () => {
    // tol=23, threshold=67. y=72 >= 67 → idx=3 ✓
    assert.equal(findFirst_noRange(sentences, 90, LH), 3);
  });

  it('large LH (100) capped to tol=47 — does not reach 2 lines back', () => {
    // sentences at [0,50,100,150,200]. topY=220, tol=47, threshold=173.
    // y=150 < 173 → skip. y=200 >= 173 → idx=4 ✓
    const wide = makeSentences([0, 50, 100, 150, 200]);
    assert.equal(findFirst_noRange(wide, 220, 100), 4);
  });

  it('standard LH=24: geometry does NOT resolve the blank-space bug', () => {
    // Without caret (path 3), topY=285, LH=48 (big container): tol=47, threshold=238
    // y=260 >= 238 → para A included. This is why path 2 (blank space) is needed.
    const sentences2 = makeSentences([260, 295]);
    const idx = findFirst_noRange(sentences2, 285, 48);
    assert.equal(idx, 0, 'documents: geometry with LH=48 selects para above (path 2 fixes this)');
  });
});

// ── Tests: End detection ──────────────────────────────────────────────────────

describe('findLastIdx — end of stroke', () => {
  const sentences = makeSentences([0, 24, 48, 72, 96]);

  it('end on a line → selects through that line', () => {
    // botY=48, botY+14=62. endLineY=0 ✓, 24 ✓, 48 ✓, 72 > 62 BREAK → lastIdx=2
    assert.equal(findLastIdx(sentences, 0, 48), 2);
  });

  it('end mid-line (fallback) → includes the partial line', () => {
    const lastIdx = findLastIdx(sentences, 0, 58);
    // 58+14=72. endLineY=48 ✓, 72 ✓, 96>72 BREAK → lastIdx=3
    assert.ok(lastIdx >= 2);
  });
});
