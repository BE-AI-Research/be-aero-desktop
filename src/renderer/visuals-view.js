// BE-Aero Desktop - assistant visuals: pages the assistant writes with
// show_visual, rendered in sandboxed frames (aero-visual://<id>/).
//   card(v)  - an inline card for the chat, sized to its content
//   desktop  - a widget per visual pinned to the desktop
// Frames get sandbox="allow-scripts" only: an opaque origin with no access to
// this page, and the CSP from main blocks network access.
(function () {
  'use strict';

  const MIN_H = 60;
  const MAX_CARD_H = 460;
  let aero = null;
  let hooks = {};
  const widgets = new Map();   // id -> { section, frame, rev }

  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  const srcFor = (id, rev) => `aero-visual://${id}/?r=${encodeURIComponent(rev || '')}`;

  function frame(id, rev) {
    const f = document.createElement('iframe');
    f.className = 'visual-frame';
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('loading', 'lazy');
    f.src = srcFor(id, rev);
    return f;
  }

  // Frames report their content height; cards follow it (within limits).
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__aeroVisual !== 1 || typeof d.height !== 'number') return;
    for (const f of document.querySelectorAll('.visual-card .visual-frame')) {
      if (f.contentWindow === e.source) { f.style.height = `${Math.max(MIN_H, Math.min(MAX_CARD_H, Math.ceil(d.height)))}px`; return; }
    }
  });

  // ---------------------------------------------------------------- chat
  function card(v, aeroApi) {
    aero = aero || aeroApi;
    const c = el('div', 'visual-card');
    c.dataset.visual = v.visual || v.id;
    const head = el('div', 'visual-head', c);
    el('span', 'visual-title', head, v.title || 'Visual');
    const pin = el('button', 'icon-btn visual-pin', head, '↗');
    pin.title = 'Open on the desktop';
    pin.addEventListener('click', async (e) => {
      e.stopPropagation();
      await aero.aiVisualWhere(c.dataset.visual, 'desktop');
      pin.disabled = true;
      pin.title = 'On the desktop';
    });
    const f = frame(c.dataset.visual, Date.now());
    f.style.height = '160px';
    c.appendChild(f);
    return c;
  }

  // ---------------------------------------------------------------- desktop
  function renderDesktop(list) {
    const want = new Map((Array.isArray(list) ? list : []).map((v) => [v.id, v]));
    for (const [id, w] of widgets) {
      if (!want.has(id)) { w.section.remove(); widgets.delete(id); }
    }
    const sidebar = document.getElementById('sidebar');
    for (const v of want.values()) {
      const have = widgets.get(v.id);
      if (have) {
        have.section.querySelector('.widget-title').textContent = (v.title || 'Visual').toUpperCase();
        if (have.rev !== v.updatedAt) { have.rev = v.updatedAt; have.frame.src = srcFor(v.id, v.updatedAt); }
        continue;
      }
      const section = el('section', 'widget widget-hit visual-widget');
      section.dataset.widget = `visual:${v.id}`;
      section.style.height = '360px';
      const head = el('div', 'plugin-head', section);
      el('h3', 'widget-title', head, (v.title || 'Visual').toUpperCase());
      const controls = el('div', 'webw-controls', head);
      const reload = el('button', 'icon-btn webw-btn', controls, '↻');
      reload.title = 'Reload';
      const toChat = el('button', 'icon-btn webw-btn', controls, '↙');
      toChat.title = 'Remove from the desktop (it stays in the chat)';
      const close = el('button', 'icon-btn webw-btn', controls, '✕');
      close.title = 'Delete this visual';
      const f = frame(v.id, v.updatedAt);
      section.appendChild(f);
      reload.addEventListener('click', () => { f.src = srcFor(v.id, Date.now()); });
      toChat.addEventListener('click', () => aero.aiVisualWhere(v.id, 'chat'));
      close.addEventListener('click', () => {
        if (!close.classList.contains('confirm')) { close.classList.add('confirm'); close.title = 'Click again to delete'; setTimeout(() => { close.classList.remove('confirm'); close.title = 'Delete this visual'; }, 2500); return; }
        aero.aiVisualDelete(v.id);
      });
      widgets.set(v.id, { section, frame: f, rev: v.updatedAt });
      sidebar.appendChild(section);
      if (hooks.onWidgetAdded) hooks.onWidgetAdded(section);
    }
  }

  async function init(opts) {
    aero = opts.aero;
    hooks = opts;
    if (aero.onAiVisuals) aero.onAiVisuals(renderDesktop);
    try { renderDesktop(await aero.aiVisuals()); } catch { /* AI disabled */ }
  }

  window.AeroVisuals = { init, card, renderDesktop };
})();
