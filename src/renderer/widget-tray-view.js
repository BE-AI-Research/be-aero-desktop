// The widget tray: a dock tile (left of the bell) for the widgets you made -
// AI widgets (also those made from .html files) and web widgets. Each one:
// show / hide, open its location (its folder, or its web page), delete.
// Built-in widgets are not listed here (they have Settings > Widgets).
(function () {
  'use strict';

  let aero = null;
  let tileEl = null;
  let panel = null;
  let list = [];

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M17 13.5v7M13.5 17h7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  function renderTile(target) {
    if (tileEl && tileEl.isConnected) tileEl.remove();
    tileEl = document.createElement('button');
    tileEl.className = 'dock-tile wtray-tile';
    tileEl.type = 'button';
    tileEl.title = 'Your widgets: show or hide, open, delete';
    tileEl.innerHTML = `<div class="dock-ico ticon">${ICON}</div>`;
    tileEl.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    // Left of the bell when the bell is already there.
    const bell = target.querySelector(':scope > .notify-tile');
    if (bell) target.insertBefore(tileEl, bell); else target.appendChild(tileEl);
  }

  async function load() {
    try { list = await aero.widgetsCreated(); } catch { list = []; }
    render();
  }

  function render() {
    if (!panel) return;
    const box = panel.querySelector('.wtray-list');
    box.textContent = '';
    if (!list.length) {
      box.innerHTML = '<div class="wtray-empty">No widgets yet. Ask the assistant to make one, right-click an .html file > Create widget, or add a web widget in Settings.</div>';
      return;
    }
    for (const w of list) {
      const row = document.createElement('div');
      row.className = `wtray-row${w.shown ? '' : ' off'}`;
      row.innerHTML = `
        <label class="wtray-switch" title="${w.shown ? 'Shown - click to hide' : 'Hidden - click to show'}"><input type="checkbox"${w.shown ? ' checked' : ''}><span></span></label>
        <span class="wtray-kind">${w.kind === 'ai' ? 'AI' : 'WEB'}</span>
        <span class="wtray-name" title="${esc(w.where)}">${esc(w.name)}</span>
        <button class="icon-btn wtray-open" title="${w.kind === 'ai' ? 'Open its folder' : 'Open the page in your browser'}">${w.kind === 'ai' ? '📂' : '↗'}</button>
        <button class="icon-btn wtray-del" title="Delete">🗑</button>`;
      row.querySelector('input').addEventListener('change', async (e) => { await aero.widgetsToggle(w.kind, w.id, e.target.checked); load(); });
      row.querySelector('.wtray-open').addEventListener('click', () => aero.widgetsOpen(w.kind, w.id));
      const del = row.querySelector('.wtray-del');
      del.addEventListener('click', async () => {
        if (!del.classList.contains('confirm')) {
          del.classList.add('confirm'); del.textContent = 'Delete?'; del.title = w.kind === 'ai' ? 'Click again: its folder goes to the Recycle Bin / Trash' : 'Click again to delete';
          setTimeout(() => { if (del.isConnected) { del.classList.remove('confirm'); del.textContent = '🗑'; del.title = 'Delete'; } }, 3000);
          return;
        }
        await aero.widgetsDelete(w.kind, w.id);
        load();
      });
      box.appendChild(row);
    }
  }

  function place() {
    if (!panel || !tileEl) return;
    const r = tileEl.getBoundingClientRect();
    const W = Math.min(340, window.innerWidth - 16);
    panel.style.width = `${W}px`;
    panel.style.left = `${Math.max(8, Math.min(window.innerWidth - W - 8, r.left + r.width / 2 - W / 2))}px`;
    const h = panel.offsetHeight || 200;
    if (r.top > window.innerHeight / 2) panel.style.top = `${Math.max(8, r.top - h - 8)}px`;
    else panel.style.top = `${r.bottom + 8}px`;
  }

  function outside(e) { if (panel && !panel.contains(e.target) && !(tileEl && tileEl.contains(e.target))) close(); }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    if (tileEl) tileEl.classList.remove('open');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  async function toggle() {
    if (panel) { close(); return; }
    panel = document.createElement('div');
    panel.className = 'wtray-panel widget-hit';
    panel.innerHTML = '<div class="wtray-head"><span>YOUR WIDGETS</span></div><div class="wtray-list"></div>';
    document.body.appendChild(panel);
    tileEl.classList.add('open');
    await load();
    place();
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey, true); }, 0);
  }

  function init(opts) {
    aero = opts.aero;
    if (!aero.widgetsCreated) return;
    // Keep an open panel current when widgets change elsewhere.
    if (aero.onAiWidgets) aero.onAiWidgets(() => { if (panel) load(); });
    if (aero.onSettingsChanged) aero.onSettingsChanged(() => { if (panel) load(); });
    window.addEventListener('resize', () => place());
  }

  window.AeroWidgetTray = { init, renderTile, close };
})();
