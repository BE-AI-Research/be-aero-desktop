// Notification center UI: a bell tile the dock renders at its end, with an
// unread badge, and a popover listing everything that asked for attention.
(function () {
  let aero = null;
  let state = { items: [], unread: 0 };
  let panel = null;
  let tileEl = null;
  let focusWebWidget = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ago(ts) {
    const d = Math.max(0, Date.now() - ts);
    if (d < 60000) return 'now';
    if (d < 3600000) return `${Math.floor(d / 60000)}m`;
    if (d < 86400000) return `${Math.floor(d / 3600000)}h`;
    return new Date(ts).toLocaleDateString();
  }

  const BELL = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21a2 2 0 0 0 4 0"/></svg>';

  function sourceGlyph(item) {
    if (item.icon) return `<img src="${esc(item.icon)}" alt="">`;
    if (item.source === 'ai') return '✨';
    if (item.source === 'web') return '🌐';
    return '🔔';
  }

  function renderPanel() {
    if (!panel) return;
    const list = panel.querySelector('.notify-list');
    list.innerHTML = '';
    if (!state.items.length) {
      const e = document.createElement('div');
      e.className = 'notify-empty';
      e.textContent = 'Nothing new.';
      list.appendChild(e);
      return;
    }
    for (const it of state.items) {
      const row = document.createElement('div');
      row.className = `notify-item${it.read ? '' : ' unread'}`;
      row.innerHTML = `<div class="n-ico">${sourceGlyph(it)}</div>
        <div class="n-body"><div class="n-title">${esc(it.title)}</div>
        ${it.body ? `<div class="n-text">${esc(it.body)}</div>` : ''}
        <div class="n-meta">${esc(it.sourceName || (it.source === 'ai' ? 'AI assistant' : it.source === 'web' ? 'Web widget' : 'BE-Aero Desktop'))} · ${ago(it.ts)}</div></div>
        <button class="n-x" title="Dismiss">✕</button>`;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.n-x')) { aero.notifyRemove(it.id); return; }
        aero.notifyOpen(it.id);
      });
      list.appendChild(row);
    }
  }

  function renderTile(barEl) {
    tileEl = document.createElement('div');
    tileEl.className = `tile notify-tile${state.unread ? ' has-unread' : ''}`;
    tileEl.title = state.unread ? `${state.unread} new notification${state.unread === 1 ? '' : 's'}` : 'Notifications';
    tileEl.innerHTML = `<div class="ticon">${BELL}</div>${state.unread ? `<span class="count">${state.unread > 99 ? '99+' : state.unread}</span>` : ''}`;
    tileEl.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(); });
    tileEl.addEventListener('contextmenu', (e) => { e.preventDefault(); aero.notifyClear(); });
    barEl.appendChild(tileEl);
  }

  function togglePanel(force) {
    const open = force === undefined ? panel.classList.contains('hidden') : !!force;
    panel.classList.toggle('hidden', !open);
    if (open) {
      renderPanel();
      // Anchor above the dock widget, inside the sidebar.
      const dock = document.querySelector('.tasks-widget');
      const r = dock ? dock.getBoundingClientRect() : { top: window.innerHeight - 80, left: 8, width: 300 };
      panel.style.left = `${Math.max(8, r.left)}px`;
      panel.style.width = `${Math.max(240, Math.min(window.innerWidth - 16, r.width))}px`;
      panel.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
      aero.notifyRead(null); // opening the center reads everything
    }
  }

  function onOpenItem(item) {
    if (!item) return;
    if (item.source === 'web' && item.sourceId && focusWebWidget) focusWebWidget(item.sourceId);
    else if (item.url && aero.openExternal) aero.openExternal(item.url);
    else if (item.source === 'ai') { const w = document.querySelector('.ai-widget'); if (w) w.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }

  function init(opts) {
    aero = opts.aero;
    focusWebWidget = opts.focusWebWidget || null;
    panel = document.createElement('div');
    panel.className = 'notify-panel widget-hit hidden';
    panel.innerHTML = `<div class="notify-head"><span>NOTIFICATIONS</span>
      <button class="icon-btn notify-clear" title="Clear all">✕ all</button>
      <button class="icon-btn notify-close" title="Close">✕</button></div>
      <div class="notify-list"></div>`;
    document.body.appendChild(panel);
    panel.querySelector('.notify-clear').addEventListener('click', () => aero.notifyClear());
    panel.querySelector('.notify-close').addEventListener('click', () => togglePanel(false));
    document.addEventListener('mousedown', (e) => {
      if (!panel.classList.contains('hidden') && !panel.contains(e.target) && !(tileEl && tileEl.contains(e.target))) togglePanel(false);
    });
    aero.onNotificationsChanged((s) => {
      state = s || { items: [], unread: 0 };
      if (tileEl) {
        tileEl.classList.toggle('has-unread', state.unread > 0);
        const c = tileEl.querySelector('.count');
        if (state.unread) {
          if (c) c.textContent = state.unread > 99 ? '99+' : state.unread;
          else { const span = document.createElement('span'); span.className = 'count'; span.textContent = state.unread; tileEl.appendChild(span); }
        } else if (c) c.remove();
      }
      if (!panel.classList.contains('hidden')) renderPanel();
      if (opts.onChange) opts.onChange(state);
    });
    aero.onNotificationOpen(onOpenItem);
    aero.notifyList().then((s) => { state = s || state; if (opts.onChange) opts.onChange(state); });
  }

  window.AeroNotify = { init, renderTile, togglePanel };
})();
