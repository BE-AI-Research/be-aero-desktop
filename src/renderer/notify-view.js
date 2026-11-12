// Notification center UI: a bell tile the dock renders at its end, with an
// unread badge, and a popover listing everything that asked for attention.
// Notifications are grouped by where they came from (an app, a web widget,
// the assistant): the newest is the group's parent, the older ones fold
// into a sub-tree under it ("3 earlier") - by conversation (the title: the
// sender or the room) when there are several, each with its own older ones.
(function () {
  let aero = null;
  let state = { items: [], unread: 0 };
  let panel = null;
  let tileEl = null;
  let focusWebWidget = null;
  const expanded = new Set();     // group keys whose older notifications are shown

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
    if (item.source === 'os') return '💬';
    return '🔔';
  }

  const sourceLabel = (it) => it.sourceName || (it.source === 'ai' ? 'AI assistant' : it.source === 'web' ? 'Web widget' : it.source === 'os' ? 'An app' : 'BE-Aero Desktop');
  const groupKey = (it) => `${it.source || 'system'}|${it.sourceId || it.sourceName || ''}`;
  // A conversation inside an app: its title (the sender or the room, for chat
  // apps), without case or counters like "(3)" / "3 new messages".
  const convKey = (it) => String(it.title || '').toLowerCase()
    .replace(/^\(\d+\)\s*/, '').replace(/\s*\(\d+( new)?( messages?)?\)$/, '').replace(/\s*[-·:]?\s*\d+ new messages?$/, '').trim() || '(untitled)';

  // Newest first in, groups out (in order of their newest item).
  function bucket(items, keyOf) {
    const byKey = new Map();
    for (const it of items) {
      const k = keyOf(it);
      if (!byKey.has(k)) byKey.set(k, { key: k, items: [] });
      byKey.get(k).items.push(it);
    }
    return [...byKey.values()];
  }

  // One notification row. opts: { level: 0 app parent | 1 conversation | 2 older
  // in a conversation, more: { key, count, label, unread }, dismiss: [items] }
  function itemRow(it, { level = 0, more = null, dismiss = [it] } = {}) {
    const row = document.createElement('div');
    row.className = `notify-item${it.read ? '' : ' unread'}${level ? ` child lvl${level}` : ''}`;
    const open = more && expanded.has(more.key);
    const meta = level === 0 ? `${esc(sourceLabel(it))} · ${ago(it.ts)}` : ago(it.ts);
    row.innerHTML = `<div class="n-ico">${sourceGlyph(it)}</div>
      <div class="n-body"><div class="n-title">${esc(it.title)}</div>
      ${it.body ? `<div class="n-text">${esc(it.body)}</div>` : ''}
      <div class="n-meta">${meta}</div>
      ${more ? `<button class="n-more${open ? ' open' : ''}" title="${open ? 'Hide' : 'Show'} the earlier ones"><span class="chev">▸</span>${esc(more.label)}${more.unread ? ` <span class="n-new">${more.unread} new</span>` : ''}</button>` : ''}</div>
      <button class="n-x" title="${dismiss.length > 1 ? `Dismiss these ${dismiss.length}` : 'Dismiss'}">✕</button>`;
    row.addEventListener('click', (e) => {
      if (e.target.closest('.n-more')) {
        if (expanded.has(more.key)) expanded.delete(more.key); else expanded.add(more.key);
        renderPanel();
        return;
      }
      if (e.target.closest('.n-x')) { for (const x of dismiss) aero.notifyRemove(x.id); return; }
      aero.notifyOpen(it.id);
    });
    return row;
  }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const unreadIn = (list) => list.filter((x) => !x.read).length;
  const tree = () => { const t = document.createElement('div'); t.className = 'notify-tree'; return t; };

  // An app's group: the newest notification is the parent. Its older ones
  // fold under it - straight in, or by conversation when there are several.
  function appGroup(g) {
    const box = document.createElement('div');
    box.className = 'notify-group';
    const [parent, ...rest] = g.items;
    const convs = bucket(g.items, convKey);
    // The conversations below the parent: the parent's own one only if it has older messages.
    const threads = bucket(rest, convKey);
    const byConv = threads.length > 1;
    const label = rest.length ? `${rest.length} earlier${byConv ? ` · ${plural(convs.length, 'conversation')}` : ''}` : '';
    box.appendChild(itemRow(parent, {
      level: 0,
      more: rest.length ? { key: g.key, label, unread: unreadIn(rest) } : null,
      dismiss: g.items
    }));
    if (!rest.length || !expanded.has(g.key)) return box;
    const t = tree();
    if (!byConv) {
      for (const it of rest) t.appendChild(itemRow(it, { level: 2 }));
    } else {
      for (const th of threads) {
        const k = `${g.key}#${th.key}`;
        const [head, ...older] = th.items;
        const conv = document.createElement('div');
        conv.className = 'notify-conv';
        conv.appendChild(itemRow(head, {
          level: 1,
          more: older.length ? { key: k, label: `${older.length} earlier`, unread: unreadIn(older) } : null,
          dismiss: th.items
        }));
        if (older.length && expanded.has(k)) {
          const t2 = tree();
          for (const it of older) t2.appendChild(itemRow(it, { level: 2 }));
          conv.appendChild(t2);
        }
        t.appendChild(conv);
      }
    }
    box.appendChild(t);
    return box;
  }

  function renderPanel() {
    if (!panel) return;
    const list = panel.querySelector('.notify-list');
    const top = list.scrollTop;
    list.innerHTML = '';
    if (!state.items.length) {
      expanded.clear();
      const e = document.createElement('div');
      e.className = 'notify-empty';
      e.textContent = 'Nothing new.';
      list.appendChild(e);
      return;
    }
    const gs = bucket(state.items, groupKey);
    // Forget open/closed state for groups and conversations that are gone.
    const live = new Set();
    for (const g of gs) { live.add(g.key); for (const th of bucket(g.items.slice(1), convKey)) live.add(`${g.key}#${th.key}`); }
    for (const k of [...expanded]) if (!live.has(k)) expanded.delete(k);
    for (const g of gs) list.appendChild(appGroup(g));
    list.scrollTop = top;
  }

  function renderTile(barEl) {
    // Same element shape as an app tile so it gets the dock's size, hover
    // and hit-area styling - a bare div had no layout and nothing to click.
    if (tileEl && tileEl.isConnected) tileEl.remove();     // one bell: it moves with the power group
    tileEl = document.createElement('button');
    tileEl.className = `dock-tile notify-tile${state.unread ? ' has-unread' : ''}`;
    tileEl.type = 'button';
    tileEl.title = state.unread ? `${state.unread} new notification${state.unread === 1 ? '' : 's'}` : 'Notifications';
    tileEl.innerHTML = `<div class="dock-ico ticon">${BELL}</div>${state.unread ? `<span class="count">${state.unread > 99 ? '99+' : state.unread}</span>` : ''}`;
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
      panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 248))}px`;
      panel.style.width = `${Math.max(240, Math.min(window.innerWidth - 16, r.width))}px`;
      if (r.top > window.innerHeight * 0.4) {
        panel.style.top = ''; panel.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
      } else {
        panel.style.bottom = ''; panel.style.top = `${Math.min(window.innerHeight - 120, r.bottom + 8)}px`;
      }
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
