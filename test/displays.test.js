const test = require('node:test');
const assert = require('node:assert');
const { unionRect, toRelative, nearestRect, clampToRects, overlapArea } = require('../src/shared/displays');

// A synthetic two-display topology with a vertical offset: the union box has
// dead zones above and below the secondary's band on the left, and below the
// primary on the right. (Values are coordinates-space-agnostic: the module is
// used with physical rects in main and window-CSS rects in the renderer.)
const PRIMARY = { x: 0, y: 0, w: 2560, h: 1440 };
const SECONDARY = { x: -1920, y: 681, w: 1920, h: 1200 };
const RECTS = [PRIMARY, SECONDARY];

test('unionRect spans every display including negative origins', () => {
  assert.deepStrictEqual(unionRect(RECTS), { x: -1920, y: 0, w: 4480, h: 1881 });
  assert.deepStrictEqual(unionRect([PRIMARY]), PRIMARY);
  assert.deepStrictEqual(unionRect([]), { x: 0, y: 0, w: 0, h: 0 });
  assert.deepStrictEqual(unionRect([{ x: 5, y: 5, w: 0, h: 10 }]), { x: 0, y: 0, w: 0, h: 0 });
});

test('toRelative rebases rects onto the window origin', () => {
  const rel = toRelative(RECTS, { x: -1920, y: 0 });
  assert.deepStrictEqual(rel[0], { x: 1920, y: 0, w: 2560, h: 1440 });
  assert.deepStrictEqual(rel[1], { x: 0, y: 681, w: 1920, h: 1200 });
});

test('nearestRect picks the display with the most overlap', () => {
  // Mostly on the primary, straddling the boundary.
  assert.strictEqual(nearestRect({ x: -100, y: 800, w: 400, h: 200 }, RECTS), PRIMARY);
  // Mostly on the secondary.
  assert.strictEqual(nearestRect({ x: -500, y: 800, w: 400, h: 200 }, RECTS), SECONDARY);
});

test('nearestRect falls back to distance in a dead zone', () => {
  // Top-left dead zone (above the secondary, left of the primary): the
  // secondary's centre is closer than the primary's.
  assert.strictEqual(nearestRect({ x: -1800, y: 100, w: 300, h: 200 }, RECTS), SECONDARY);
  assert.strictEqual(nearestRect({ x: 0, y: 0, w: 10, h: 10 }, []), null);
});

test('clampToRects pulls a dead-zone widget onto its nearest screen', () => {
  // Stranded above the secondary: pulled down to its top edge.
  const pulled = clampToRects({ x: -1800, y: 100, w: 300, h: 200 }, RECTS);
  assert.strictEqual(pulled.y, 681);
  assert.strictEqual(pulled.x, -1800, 'x already fine');
  // Stranded below the primary on the right: pulled back up.
  const up = clampToRects({ x: 2000, y: 1700, w: 300, h: 200 }, RECTS);
  assert.strictEqual(up.y, 1440 - 40);
});

test('clampToRects keeps a grab handle on screen horizontally', () => {
  // Pushed almost entirely off the right edge of the primary.
  const r = clampToRects({ x: 2550, y: 100, w: 300, h: 200 }, RECTS);
  assert.strictEqual(r.x, 2560 - 60);
  // Pushed off the left edge of the secondary.
  const l = clampToRects({ x: -2300, y: 800, w: 300, h: 200 }, RECTS);
  assert.strictEqual(l.x, -1920 - 300 + 60);
});

test('clampToRects leaves a well-placed widget untouched', () => {
  const geo = { x: 400, y: 300, w: 300, h: 200 };
  assert.deepStrictEqual(clampToRects(geo, RECTS), { x: 400, y: 300 });
  const sec = { x: -1200, y: 900, w: 300, h: 200 };
  assert.deepStrictEqual(clampToRects(sec, RECTS), { x: -1200, y: 900 });
});

test('single display behaves like the old single-screen clamp', () => {
  const r = clampToRects({ x: -500, y: -50, w: 300, h: 200 }, [PRIMARY]);
  assert.strictEqual(r.x, -300 + 60);
  assert.strictEqual(r.y, 0);
});

test('overlapArea is zero for disjoint rects', () => {
  assert.strictEqual(overlapArea(PRIMARY, { x: 3000, y: 0, w: 10, h: 10 }), 0);
  assert.ok(overlapArea(PRIMARY, SECONDARY) === 0, 'these two screens do not overlap');
});


// The development machine's actual map in window-CSS space (4K primary at
// 150% spanning with a 100% secondary; window renders at 1.5): primary
// (1280,0 2560x1440), secondary (0,454 1280x800). Verified live - these are
// the exact clamps the renderer applied.
test('real mixed-DPI map clamps exactly as observed live', () => {
  const P = { x: 1280, y: 0, w: 2560, h: 1440 };
  const S = { x: 0, y: 454, w: 1280, h: 800 };
  // Drop above the secondary: pulled down to its top edge.
  assert.deepStrictEqual(clampToRects({ x: 260, y: 60, w: 373, h: 348 }, [P, S]),
    { x: 260, y: 454 });
  // Drop below the secondary: pulled up to keep the grab strip reachable.
  assert.deepStrictEqual(clampToRects({ x: 260, y: 1380, w: 373, h: 348 }, [P, S]),
    { x: 260, y: 454 + 800 - 40 });
  // A legitimate secondary position is untouched.
  assert.deepStrictEqual(clampToRects({ x: 460, y: 792, w: 373, h: 348 }, [P, S]),
    { x: 460, y: 792 });
});
