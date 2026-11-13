// The widget tray: a dock tile (left of the bell) for the widgets you made -
// AI widgets (also those made from .html files) and web widgets. Each one:
// show / hide, open its location (its folder, or its web page), delete.
// The + adds one: ask the assistant, pick an .html file, or a web page.
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
      box.innerHTML = '<div class="wtray-empty">No widgets yet. Click + to add one: the assistant can make one for you, or use an .html file or a web page.</div>';
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

  // The + : three ways to add a widget.
  function toggleAdd() {
    const add = panel.querySelector('.wtray-addbox');
    if (!add.classList.contains('hidden')) { add.classList.add('hidden'); place(); return; }
    add.classList.remove('hidden');
    add.innerHTML = `
      <button class="wtray-addopt" data-add="ai"><span class="g">🤖</span><span><b>Ask the assistant</b><small>Describe it; the AI makes it</small></span></button>
      <button class="wtray-addopt" data-add="html"><span class="g">📄</span><span><b>From an HTML file…</b><small>A page of your own, copied into AI Widgets</small></span></button>
      <button class="wtray-addopt" data-add="web"><span class="g">🌐</span><span><b>A web page…</b><small>Any site, shown live on the desktop</small></span></button>
      <div class="wtray-addmsg"></div>`;
    const msg = add.querySelector('.wtray-addmsg');
    add.querySelector('[data-add="ai"]').addEventListener('click', () => askAssistant());
    add.querySelector('[data-add="html"]').addEventListener('click', async () => {
      msg.textContent = '';
      const r = await aero.widgetsAddHtml();
      if (!r || r.canceled) return;
      if (r.error) { msg.textContent = r.error; msg.classList.add('err'); return; }
      add.classList.add('hidden');
      await load();
      place();
    });
    add.querySelector('[data-add="web"]').addEventListener('click', (e) => {
      if (add.querySelector('.wtray-webform')) return;
      const f = document.createElement('div');
      f.className = 'wtray-webform';
      f.innerHTML = '<input type="text" class="u" spellcheck="false" placeholder="Address, e.g. example.com"><input type="text" class="n" spellcheck="false" placeholder="Name (optional)"><button class="btn">Add</button>';
      e.currentTarget.after(f);
      const u = f.querySelector('.u');
      u.focus();
      const go = async () => {
        const r = await aero.widgetsAddWeb(u.value, f.querySelector('.n').value);
        if (!r || r.error) { msg.textContent = (r && r.error) || 'Could not add it.'; msg.classList.add('err'); return; }
        add.classList.add('hidden');
        await load();
        place();
      };
      f.querySelector('button').addEventListener('click', go);
      f.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') go(); if (ev.key === 'Escape') f.remove(); });
      place();
    });
    place();
  }

  // Show the AI chat with the request started; the user finishes the sentence.
  async function askAssistant() {
    close();
    try { const s = await aero.getSettings(); if (s.widgets && s.widgets.ai === false) await aero.setSettings({ widgets: { ai: true } }); } catch { /* shown */ }
    setTimeout(() => {
      const input = document.querySelector('.ai-widget .ai-input');
      if (!input) return;
      const w = input.closest('.ai-widget');
      if (w && w.scrollIntoView) w.scrollIntoView({ block: 'nearest' });
      input.value = 'Make me a widget that ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 150);
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
    panel.innerHTML = '<div class="wtray-head"><span>YOUR WIDGETS</span><button class="icon-btn wtray-add" title="Add a widget">＋</button></div><div class="wtray-addbox hidden"></div><div class="wtray-list"></div>';
    document.body.appendChild(panel);
    panel.querySelector('.wtray-add').addEventListener('click', toggleAdd);
    tileEl.classList.add('open');
    const mine = panel;
    await load();
    if (panel !== mine) return;                    // closed while loading
    place();
    setTimeout(() => { if (panel !== mine) return; document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey, true); }, 0);
  }

  function init(opts) {
    aero = opts.aero;
    if (!aero.widgetsCreated) return;
    // Keep an open panel current when widgets change elsewhere.
    if (aero.onAiWidgets) aero.onAiWidgets(() => { if (panel) load(); });
    if (aero.onSettingsChanged) aero.onSettingsChanged(() => { if (panel) load(); });
    if (aero.onWidgetsAsk) aero.onWidgetsAsk(() => askAssistant());      // from the BE-Aero menu
    window.addEventListener('resize', () => place());
  }

  window.AeroWidgetTray = { init, renderTile, close };
})();
