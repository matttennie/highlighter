/**
 * Tests for stroke path-building logic extracted from content.js.
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
