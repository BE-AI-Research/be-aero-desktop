// BE-Aero Desktop - widget layout: resizing (all modes) and free-form dragging.
// Docked mode: widgets stack in the sidebar; the corner grip changes height.
// Free-form mode: the window covers the whole work area and every widget is
// absolutely positioned; drag a widget's body to move it, the grip to resize.
(function () {
  'use strict';

  const DEFAULT_H = { toolbar: 30, search: 48, clock: 304, weather: 144, telemetry: 220, tasks: 64, media: 160, scratchpad: 224, files: 380 };
  const MIN = {
    toolbar: [180, 30], search: [200, 44], clock: [150, 150], weather: [220, 110],
    telemetry: [200, 130], tasks: [140, 54], media: [200, 110], scratchpad: [200, 120],
    files: [260, 220]
  };
  // Web widgets that have never been placed open in the MIDDLE of the home
  // display (cascaded), not in the sidebar column: they are content panes.
  const WEB_W = 560;
  const WEB_H = 380;
  const MAX_H = 1200;
  const GAP = 18;
  const COL_W = 304;
  const GRID = 10;
  const NO_DRAG = 'input, textarea, select, button, a, kbd, .resize-grip, .no-drag';

  let aero = null;
  let settings = null;
  let hooks = {};
  let saveTimer = null;
  const pending = { free: {}, docked: {} };

  const keyOf = (el) => el.dataset.widget || el.dataset.key;
  const items = () => [...document.querySelectorAll('#sidebar > [data-widget], #sidebar > [data-key]')];
  const isFree = () => settings && settings.dock === 'free';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function layoutOf(mode) {
    const base = (settings.layout && settings.layout[mode]) || {};
    return { ...base, ...pending[mode] };
  }

  // Persist geometry changes (batched so a burst of edits is one write).
  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!Object.keys(pending.free).length && !Object.keys(pending.docked).length) return;
    const patch = { layout: { free: pending.free, docked: pending.docked } };
    pending.free = {};
    pending.docked = {};
    aero.setSettings(patch);
  }

  function save(mode, key, geo) {
    pending[mode][key] = { ...(layoutOf(mode)[key] || {}), ...geo };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 120);
  }

  // Real display rects (window-relative) when main provided them; otherwise
  // the whole window acts as one screen.
  function screenRects() {
    const list = (settings && settings.displays) || [];
    return list.length ? list : [{ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }];
  }

  // Default free-form positions: a column on the edge of the display the
  // sidebar was docked to - not the edge of the whole multi-monitor span.
  function defaultFree() {
    const out = {};
    const home = (settings && settings.homeRect) || { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const x = settings.freeFrom === 'left' ? home.x + GAP : home.x + home.w - COL_W - GAP;
    let y = home.y + 16;
    let cascade = 0;
    // Once the user has arranged anything, a widget appearing for the first
    // time (turned on, restored from the dock, a new plugin) opens in the
    // middle of the display - not at the end of a column that may be off
    // screen. A fresh install with nothing arranged still gets the column.
    const savedFree = layoutOf('free');
    const arranged = Object.keys(savedFree).some((k) => k !== '_z');
    for (const el of items()) {
      if (el.classList.contains('hidden')) continue;
      const k = keyOf(el);
      if (arranged && !savedFree[k] && k !== 'toolbar' && !k.startsWith('web:') && !k.startsWith('visual:')) {
        const w = Math.max(COL_W, (MIN[k] || [0])[0]);
        const h = (layoutOf('docked')[k] || {}).h || DEFAULT_H[k] || 200;
        out[k] = { x: Math.round(home.x + (home.w - w) / 2 + cascade * 28), y: Math.round(home.y + Math.max(GAP, (home.h - h) / 2) + cascade * 28), w, h };
        cascade++;
        save('free', k, out[k]);          // it stays where it opened until moved
        continue;
      }
      if (k.startsWith('web:') || k.startsWith('visual:')) {
        const w = Math.min(WEB_W, Math.max(320, Math.floor(home.w * 0.45)));
        const h = Math.min(WEB_H, Math.max(240, Math.floor(home.h * 0.45)));
        out[k] = { x: Math.round(home.x + (home.w - w) / 2 + cascade * 28), y: Math.round(home.y + (home.h - h) / 2 + cascade * 28), w, h };
        cascade++;
        continue;
      }
      const docked = (layoutOf('docked')[k] || {}).h;
      const h = docked || DEFAULT_H[k] || 200;
      // A column that has run off the bottom of the display: open this one
      // in the middle instead (cascaded), where it is fully visible.
      if (y + h > home.y + home.h - GAP) {
        const w = Math.max(COL_W, (MIN[k] || [0])[0]);
        out[k] = { x: Math.round(home.x + (home.w - w) / 2 + cascade * 28), y: Math.round(home.y + Math.max(GAP, (home.h - h) / 2) + cascade * 28), w, h };
        cascade++;
        continue;
      }
      out[k] = { x, y, w: COL_W, h };
      y += h + GAP;
    }
    return out;
  }

  // Free-form stacking: the most recently touched widget is on top. Order
  // is saved with the layout ('_z'), so it survives restarts.
  function zOrder() {
    const saved = layoutOf('free');
    return Array.isArray(saved._z) ? saved._z.slice() : [];
  }
  // Layers (see styles.css): widgets stack among themselves in 10..900; the
  // toolbar (1000), the settings panel (2000) and popups (100000) always sit
  // above every widget, however often widgets are raised.
  const Z_WIDGET_BASE = 10;
  const Z_WIDGET_MAX = 900;
  function applyZ() {
    if (!isFree()) { for (const el of items()) el.style.zIndex = ''; return; }
    const order = zOrder().filter((k) => k !== 'toolbar');
    for (const el of items()) {
      const k = keyOf(el);
      if (k === 'toolbar') { el.style.zIndex = ''; continue; }
      const i = order.indexOf(k);
      el.style.zIndex = String(Math.min(Z_WIDGET_MAX, Z_WIDGET_BASE + (i < 0 ? 0 : i + 1)));
    }
  }
  function bringToFront(el) {
    if (!isFree() || keyOf(el) === 'toolbar') return;
    const k = keyOf(el);
    const order = zOrder().filter((x) => x !== k);
    order.push(k);
    pending.free._z = order;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 120);
    applyZ();
  }

  function apply() {
    if (!settings) return;
    const free = isFree();
    document.body.classList.toggle('free', free);
    document.body.classList.toggle('locked', !!settings.locked);
    const saved = layoutOf(free ? 'free' : 'docked');
    const defaults = free ? defaultFree() : {};
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    for (const el of items()) {
      const k = keyOf(el);
      const [minW, minH] = MIN[k] || [160, 80];
      if (free) {
        const g = { ...(defaults[k] || { x: vw - COL_W - GAP, y: 16, w: COL_W, h: DEFAULT_H[k] || 200 }), ...(saved[k] || {}) };
        const w = clamp(g.w || COL_W, minW, vw);
        const h = k === 'toolbar' ? DEFAULT_H.toolbar : clamp(g.h || DEFAULT_H[k], minH, vh);
        // Keep the widget on a REAL screen: the multi-monitor span contains
        // dead zones where no display lives, and a widget stranded there
        // (after an unplug or resolution change) would be invisible.
        const { x, y } = AeroDisplays.clampToRects({ x: g.x, y: g.y, w, h }, screenRects());
        Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      } else {
        const h = (saved[k] || {}).h;
        Object.assign(el.style, { left: '', top: '', width: '', height: h && k !== 'toolbar' ? `${clamp(h, minH, MAX_H)}px` : '' });
      }
    }
    applyZ();
    positionSettings();
    if (hooks.onResize) hooks.onResize();
  }

  // Settings panel: full-width in the sidebar, next to the toolbar in free mode.
  function positionSettings() {
    const panel = document.getElementById('settings');
    if (!panel) return;
    if (!isFree()) {
      Object.assign(panel.style, { left: '', top: '', right: '', width: '', maxHeight: '' });
      return;
    }
    const tb = document.getElementById('toolbar').getBoundingClientRect();
    const w = 330;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = clamp(tb.left, 8, vw - w - 8);
    const below = tb.bottom + 8;
    const top = below + 300 < vh ? below : 8;
    Object.assign(panel.style, {
      left: `${left}px`, right: 'auto', width: `${w}px`, top: `${top}px`, maxHeight: `${vh - top - 8}px`
    });
  }

  // Pointer helper: tracks a gesture with pointer capture so the window keeps
  // receiving mouse events even while click-through toggling is active.
  function track(e, el, onMove, onEnd) {
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    el.setPointerCapture(e.pointerId);
    if (hooks.setDragging) hooks.setDragging(true);
    const move = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved) document.body.classList.add('gesture');
      moved = true;
      onMove(dx, dy, ev);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('gesture');
      if (hooks.setDragging) hooks.setDragging(false);
      if (moved) {
        // Swallow the click that follows a drag so buttons/search don't fire.
        const stop = (c) => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener('click', stop, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 50);
      }
      onEnd(moved);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  const snap = (v) => (settings.snapToGrid ? Math.round(v / GRID) * GRID : Math.round(v));

  function startMove(e, el) {
    bringToFront(el);
    if (settings && settings.locked) return;
    const k = keyOf(el);
    const x0 = el.offsetLeft;
    const y0 = el.offsetTop;
    el.classList.add('moving');
    track(e, el, (dx, dy) => {
      el.style.left = `${snap(x0 + dx)}px`;
      el.style.top = `${snap(clamp(y0 + dy, 0, window.innerHeight - 40))}px`;
      if (k === 'toolbar') positionSettings();
    }, (moved) => {
      el.classList.remove('moving');
      if (!moved) return;
      const { x, y } = AeroDisplays.clampToRects(
        { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }, screenRects());
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      save('free', k, { x, y, w: el.offsetWidth, h: el.offsetHeight });
    });
  }

  function startResize(e, el) {
    e.stopPropagation();
    e.preventDefault();
    if (settings && settings.locked) return;
    const k = keyOf(el);
    const [minW, minH] = MIN[k] || [160, 80];
    const w0 = el.offsetWidth;
    const h0 = el.offsetHeight;
    const free = isFree();
    el.classList.add('resizing');
    track(e, e.currentTarget, (dx, dy) => {
      if (free) el.style.width = `${clamp(snap(w0 + dx), minW, window.innerWidth)}px`;
      if (k !== 'toolbar') el.style.height = `${clamp(snap(h0 + dy), minH, free ? window.innerHeight : MAX_H)}px`;
      if (hooks.onResize) hooks.onResize(k);
    }, (moved) => {
      el.classList.remove('resizing');
      if (!moved) return;
      if (free) save('free', k, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
      else save('docked', k, { h: el.offsetHeight });
    });
  }

  // Attach the grip and drag behaviour to one widget. Split out of init() so
  // widgets that appear later - plugin panes, app panes - get the same
  // treatment as the built-in ones.
  function adopt(el) {
    if (el.dataset.aeroAdopted) return;
    el.dataset.aeroAdopted = '1';
    {
      const grip = document.createElement('div');
      grip.className = 'resize-grip';
      grip.title = 'Drag to resize (double-click to reset)';
      grip.addEventListener('pointerdown', (e) => { if (e.button === 0) startResize(e, el); });
      grip.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const k = keyOf(el);
        const mode = isFree() ? 'free' : 'docked';
        const geo = isFree() ? { w: COL_W, h: DEFAULT_H[k] } : { h: null };
        save(mode, k, geo);
        if (isFree()) { el.style.width = `${COL_W}px`; el.style.height = `${DEFAULT_H[k]}px`; } else el.style.height = '';
        if (hooks.onResize) hooks.onResize(k);
      });
      el.appendChild(grip);

      el.addEventListener('pointerdown', (e) => {
        if (!isFree() || e.button !== 0) return;
        if (e.target.closest(NO_DRAG) && !e.target.closest('.drag-handle')) return;
        startMove(e, el);
      });
    }
    if (settings) apply();
  }

  function init(opts) {
    aero = opts.aero;
    hooks = opts;
    for (const el of items()) adopt(el);
    window.addEventListener('resize', apply);
    // Don't let a quit or reload swallow a geometry change still in the batch.
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  }

  function update(s) {
    settings = s;
    apply();
  }

  async function reset() {
    pending.free = {};
    pending.docked = {};
    const s = await aero.replaceSettings('layout', { free: {}, docked: {} });
    update(s);
  }

  window.AeroLayout = { init, adopt, update, reset, positionSettings };
})();
