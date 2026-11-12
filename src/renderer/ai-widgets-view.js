// AI widgets on the desktop: one widget per folder in AI Folder/AI Widgets,
// each in a sandboxed frame (aero-widget://<id>/). The frame talks to the
// app only through window.aeroWidget (load / save / fetch), relayed here.
(function () {
  'use strict';

  let aero = null;
  let hooks = {};
  const widgets = new Map();   // id -> { section, frame, rev, blocked }

  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  const srcFor = (id, rev) => `aero-widget://${id}/?r=${encodeURIComponent(rev || '')}`;

  // A frame's request: which widget sent it is decided by the frame, never
  // by anything inside the message.
  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (!d || d.__aeroWidget !== 1 || typeof d.op !== 'string') return;
    let id = null;
    for (const [wid, w] of widgets) if (w.frame.contentWindow === e.source) { id = wid; break; }
    if (!id) return;
    const r = await aero.aiWidgetBridge(id, d.op, d.args);
    try { e.source.postMessage({ __aeroWidgetReply: 1, rid: d.rid, ...(r && r.error ? { error: r.error } : { result: r ? r.result : null }) }, '*'); } catch { /* frame gone */ }
  });

  function blockedBar(section, w) {
    let bar = section.querySelector('.aiw-blocked');
    const pending = w.pendingHosts || [];
    if (!pending.length) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = el('div', 'aiw-blocked');
      section.insertBefore(bar, section.querySelector('.visual-frame'));
    }
    bar.textContent = '';
    el('span', '', bar, `Blocked: ${pending.join(', ')}`);
    const allow = el('button', 'btn', bar, 'Review…');
    allow.addEventListener('click', () => aero.aiWidgetApprove(w.id));
  }

  function render(list) {
    // Closed (hidden) widgets are not shown; the widget tray brings them back.
    const want = new Map((Array.isArray(list) ? list : []).filter((w) => !w.hidden).map((w) => [w.id, w]));
    for (const [id, w] of widgets) {
      if (!want.has(id)) { w.section.remove(); widgets.delete(id); }
    }
    const sidebar = document.getElementById('sidebar');
    for (const w of want.values()) {
      const rev = `${w.updatedAt}|${(w.approvedHosts || []).join(',')}`;
      const have = widgets.get(w.id);
      if (have) {
        have.section.querySelector('.widget-title').textContent = (w.title || 'Widget').toUpperCase();
        if (have.rev !== rev) { have.rev = rev; have.frame.src = srcFor(w.id, rev); }
        blockedBar(have.section, w);
        continue;
      }
      const section = el('section', 'widget widget-hit visual-widget aiw-widget');
      section.dataset.widget = `aiw:${w.id}`;
      section.style.height = `${Math.round(w.height || 240) + 40}px`;
      const head = el('div', 'plugin-head', section);
      el('h3', 'widget-title', head, (w.title || 'Widget').toUpperCase());
      const controls = el('div', 'webw-controls', head);
      const reload = el('button', 'icon-btn webw-btn', controls, '↻');
      reload.title = 'Reload';
      const folder = el('button', 'icon-btn webw-btn', controls, '✎');
      folder.title = 'Edit - open its folder (index.html)';
      const del = el('button', 'icon-btn webw-btn visual-del', controls);
      del.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      del.title = 'Remove this widget (its folder goes to the Recycle Bin)';
      const close = el('button', 'icon-btn webw-btn aiw-close', controls, '✕');
      close.title = 'Close - it keeps its saved state; bring it back from the widget tray in the dock';
      el('span', 'badge', head, 'AI');
      const f = document.createElement('iframe');
      f.className = 'visual-frame';
      f.setAttribute('sandbox', 'allow-scripts');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.src = srcFor(w.id, rev);
      section.appendChild(f);
      reload.addEventListener('click', () => { f.src = srcFor(w.id, Date.now()); });
      folder.addEventListener('click', () => aero.aiWidgetFolder(w.id));
      close.addEventListener('click', () => {
        // Give the widget a moment to save (it gets "aero:close"), then hide it.
        try { f.contentWindow.postMessage({ __aeroWidgetEvent: 'close' }, '*'); } catch { /* gone */ }
        setTimeout(() => aero.aiWidgetHidden(w.id, true), 400);
      });
      del.addEventListener('click', () => {
        if (!del.classList.contains('confirm')) { del.classList.add('confirm'); del.title = 'Click again to remove'; setTimeout(() => { del.classList.remove('confirm'); del.title = 'Remove this widget'; }, 2500); return; }
        aero.aiWidgetRemove(w.id);
      });
      widgets.set(w.id, { section, frame: f, rev });
      blockedBar(section, w);
      sidebar.appendChild(section);
      if (hooks.onWidgetAdded) hooks.onWidgetAdded(section);
    }
  }

  async function init(opts) {
    aero = opts.aero;
    hooks = opts;
    if (!aero.aiWidgets) return;
    aero.onAiWidgets(render);
    try { render(await aero.aiWidgets()); } catch { /* AI disabled */ }
  }

  window.AeroAiWidgets = { init, render };
})();
