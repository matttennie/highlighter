/**
 * Tests for stroke path-building logic and selection geometry
 * extracted from content.js.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Extracted from content.js buildPathData
function buildPathData(points) {
  if (!points.length) return '';
  if (points.length === 1) {
    return `M${points[0].x},${points[0].y}L${points[0].x + 0.1},${points[0].y}`;
  }
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length; i++) d += `L${points[i].x},${points[i].y}`;
  return d;
}

describe('buildPathData', () => {
  it('returns empty string for no points', () => {
    assert.equal(buildPathData([]), '');
  });

  it('creates a tiny segment for a single point (tap)', () => {
    const d = buildPathData([{ x: 100, y: 200 }]);
    assert.equal(d, 'M100,200L100.1,200');
    // Ensures the SVG path renderer sees a visible segment
  });

  it('creates a line segment for two points', () => {
    const d = buildPathData([{ x: 5, y: 10 }, { x: 15, y: 25 }]);
    assert.equal(d, 'M5,10L15,25');
  });

  it('creates a polyline for multiple points', () => {
    const d = buildPathData([
      { x: 0, y: 0 },
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
    assert.equal(d, 'M0,0L10,20L30,40');
  });

  it('handles floating-point coordinates', () => {
    const d = buildPathData([{ x: 1.5, y: 2.7 }, { x: 3.14, y: 4.0 }]);
    assert.equal(d, 'M1.5,2.7L3.14,4');
  });

  it('handles negative coordinates', () => {
    const d = buildPathData([{ x: -10, y: -20 }, { x: 10, y: 20 }]);
    assert.equal(d, 'M-10,-20L10,20');
  });
});

// ── Selection path logic (stroke resolution geometry) ────────────────

const LINE_TOLERANCE = 14;

/**
 * Path 2 geometry: caret snapped to line above topPt.y (blank space between paras).
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
 * End detection — find last sentence index within stroke bounds.
 */
function findLastIdx(sentences, firstIdx, botY) {
  let lastIdx = -1;
  for (let i = firstIdx; i < sentences.length; i++) {
    if (sentences[i].endLineY > botY + LINE_TOLERANCE) break;
    if (sentences[i].endLineY <= botY + LINE_TOLERANCE) lastIdx = i;
  }
  return lastIdx;
}

function makeSentences(lineYs) {
  return lineYs.map((y, i) => ({
    text: `Sentence ${i + 1} at y=${y}.`,
    startLineY: y,
    endLineY: y,
  }));
}

describe('Path 2 — blank space between paragraphs', () => {
  const sentences = makeSentences([260, 295]);

  it('stroke in gap (topY=285) selects para B', () => {
    const idx = findFirst_blankSpace(sentences, 285);
    assert.equal(idx, 1, `expected para B (idx=1, y=295), got idx=${idx}`);
  });

  it('stroke at very start of gap (topY=284) selects para B', () => {
    const idx = findFirst_blankSpace(sentences, 284);
    assert.equal(idx, 1);
  });

  it('stroke right above para B (topY=293) selects para B', () => {
    const idx = findFirst_blankSpace(sentences, 293);
    assert.equal(idx, 1);
  });

  it('stroke right at para B start (topY=295) selects para B', () => {
    const idx = findFirst_blankSpace(sentences, 295);
    assert.equal(idx, 1);
  });

  it('para A is NOT included when stroke is in the gap', () => {
    for (const topY of [284, 285, 287, 290, 293, 295]) {
      const idx = findFirst_blankSpace(sentences, topY);
      assert.ok(
        sentences[idx].startLineY >= 290,
        `topY=${topY}: expected para B (y>=290), got idx=${idx} y=${sentences[idx]?.startLineY}`
      );
    }
  });
});

describe('Path 3 — geometry fallback (no caret)', () => {
  const sentences = makeSentences([0, 24, 48, 72, 96]);
  const LH = 24;

  it('stroke at top of line (topY=48) selects correct line', () => {
    assert.equal(findFirst_noRange(sentences, 48, LH), 2);
  });

  it('stroke at middle of line (topY=60) selects correct line', () => {
    assert.equal(findFirst_noRange(sentences, 60, LH), 2);
  });

  it('stroke at bottom of line (topY=70) selects correct line', () => {
    assert.equal(findFirst_noRange(sentences, 70, LH), 2);
  });

  it('stroke at 3/4 of line (topY=90) selects correct line', () => {
    assert.equal(findFirst_noRange(sentences, 90, LH), 3);
  });

  it('large LH (100) capped to tol=47 — does not reach 2 lines back', () => {
    const wide = makeSentences([0, 50, 100, 150, 200]);
    assert.equal(findFirst_noRange(wide, 220, 100), 4);
  });
});

describe('findLastIdx — end of stroke', () => {
  const sentences = makeSentences([0, 24, 48, 72, 96]);

  it('end on a line selects through that line', () => {
    assert.equal(findLastIdx(sentences, 0, 48), 2);
  });

  it('end mid-line (fallback) includes the partial line', () => {
    const lastIdx = findLastIdx(sentences, 0, 58);
    assert.ok(lastIdx >= 2);
  });
});
