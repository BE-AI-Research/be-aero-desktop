// Multi-monitor geometry, shared by main (window bounds) and the renderer
// (keeping free-form widgets on real screens).
//
// In free-form mode the window spans the bounding box of every display's work
// area. With monitors of different sizes or offsets that box contains dead
// zones - coordinates inside the box but outside every screen - so a widget's
// position is always clamped into the nearest actual display rectangle.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AeroDisplays = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Bounding box of a set of {x, y, w, h} rects.
  function unionRect(rects) {
    const list = (rects || []).filter((r) => r && r.w > 0 && r.h > 0);
    if (!list.length) return { x: 0, y: 0, w: 0, h: 0 };
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of list) {
      x1 = Math.min(x1, r.x);
      y1 = Math.min(y1, r.y);
      x2 = Math.max(x2, r.x + r.w);
      y2 = Math.max(y2, r.y + r.h);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // The same rects expressed relative to an origin (the window's top-left).
  function toRelative(rects, origin) {
    return (rects || []).map((r) => ({
      x: r.x - origin.x, y: r.y - origin.y, w: r.w, h: r.h
    }));
  }

  function overlapArea(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  }

  function centerDistance(a, b) {
    const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
    const dy = (a.y + a.h / 2) - (b.y + b.h / 2);
    return Math.hypot(dx, dy);
  }

  // The display rect a widget "belongs" to: the one it overlaps most, or the
  // nearest one when it floats entirely in a dead zone.
  function nearestRect(geo, rects) {
    const list = (rects || []).filter((r) => r && r.w > 0 && r.h > 0);
    if (!list.length) return null;
    let best = list[0];
    let bestArea = -1;
    for (const r of list) {
      const a = overlapArea(geo, r);
      if (a > bestArea) { best = r; bestArea = a; }
    }
    if (bestArea > 0) return best;
    let bestDist = Infinity;
    for (const r of list) {
      const d = centerDistance(geo, r);
      if (d < bestDist) { best = r; bestDist = d; }
    }
    return best;
  }

  // Clamp a widget's position so a usable part of it sits on a real screen.
  // Mirrors the old single-screen rule (at least `grabX` px horizontally and
  // the title bar vertically) but against the widget's own display.
  function clampToRects(geo, rects, { grabX = 60, grabY = 40 } = {}) {
    const home = nearestRect(geo, rects);
    if (!home) return { x: geo.x, y: geo.y };
    const x = Math.max(home.x - geo.w + grabX, Math.min(geo.x, home.x + home.w - grabX));
    const y = Math.max(home.y, Math.min(geo.y, home.y + home.h - grabY));
    return { x, y };
  }

  return { unionRect, toRelative, nearestRect, clampToRects, overlapArea };
});
