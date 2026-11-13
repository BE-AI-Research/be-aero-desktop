// Notifications on the web widget frames themselves (Google Chat, Calendar,
// ...). Each frame's title bar gets a bell with its unread count that drops
// down that widget's own notifications, grouped by conversation as in the
// main bell; and a new one slides in as a banner at the top of the frame
// for a few seconds. Everything stays in the notification center too.
(function () {
  'use strict';

  const BANNER_MS = 6000;
  let aero = null;
  let items = [];
  let known = null;                // ids seen so far (no banners for what was there at start)
  let openFor = null;              // widget id whose drop-down is open
  let dropEl = null;

  const BELL = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21a2 2 0 0 0 4 0"/></svg>';
  const forWidget = (id) => items.filter((n) => n.source === 'web' && n.sourceId === id);

  function sections() { return [...document.querySelectorAll('section.web-widget[data-widget^="web:"]')]; }
  const idOf = (section) => section.dataset.widget.slice(4);

  // The bell on a frame's title bar: there while the widget has notifications.
  function paintBells() {
    for (const s of sections()) {
      const id = idOf(s);
      const mine = forWidget(id);
      const unread = mine.filter((n) => !n.read).length;
      let bell = s.querySelector(':scope > .plugin-head > .wn-bell');
      if (!mine.length) { if (bell) bell.remove(); if (openFor === id) closeDrop(); continue; }
      if (!bell) {
        bell = document.createElement('button');
        bell.type = 'button';
        bell.className = 'icon-btn wn-bell';
        bell.addEventListener('click', (e) => { e.stopPropagation(); toggleDrop(s); });
        const head = s.querySelector(':scope > .plugin-head');
        const badge = head && head.querySelector(':scope > .badge');
        if (!head) continue;
        if (badge) head.insertBefore(bell, badge); else head.appendChild(bell);
      }
      bell.classList.toggle('unread', unread > 0);
      bell.innerHTML = `${BELL}${unread ? `<span class="wn-count">${unread > 99 ? '99+' : unread}</span>` : ''}`;
      bell.title = unread ? `${unread} new notification${unread === 1 ? '' : 's'} - click to see them` : `${mine.length} notification${mine.length === 1 ? '' : 's'}`;
    }
  }

  function renderDrop() {
    if (!dropEl || !openFor) return;
    const list = dropEl.querySelector('.wn-list');
    const top = list.scrollTop;
    AeroNotify.renderConversations(list, forWidget(openFor), `web:${openFor}`, renderDrop);
    list.scrollTop = top;
  }

  function placeDrop(section) {
    const bell = section.querySelector('.wn-bell');
    const r = (bell || section).getBoundingClientRect();
    const w = Math.min(340, window.innerWidth - 16);
    dropEl.style.width = `${w}px`;
    dropEl.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    const h = dropEl.offsetHeight;
    dropEl.style.top = `${r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  }

  function outside(e) {
    if (!dropEl || dropEl.contains(e.target) || (e.target.closest && e.target.closest('.wn-bell'))) return;
    closeDrop();
  }
  function onKey(e) { if (e.key === 'Escape') closeDrop(); }

  function closeDrop() {
    if (dropEl) dropEl.remove();
    dropEl = null;
    openFor = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function toggleDrop(section) {
    const id = idOf(section);
    if (openFor === id) { closeDrop(); return; }
    closeDrop();
    openFor = id;
    const name = (section.querySelector('.widget-title') || {}).textContent || 'Web widget';
    dropEl = document.createElement('div');
    dropEl.className = 'notify-panel wn-drop widget-hit';
    dropEl.innerHTML = `<div class="notify-head"><span>${AeroNotify.esc(name)}</span><button class="icon-btn wn-clear" title="Dismiss all from this widget">✕ all</button></div><div class="notify-list wn-list"></div>`;
    dropEl.querySelector('.wn-clear').addEventListener('click', () => { for (const n of forWidget(id)) aero.notifyRemove(n.id); });
    document.body.appendChild(dropEl);
    renderDrop();
    placeDrop(section);
    // Seen now: mark this widget's notifications read.
    for (const n of forWidget(id)) if (!n.read) aero.notifyRead(n.id);
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey, true); }, 0);
  }

  // A new notification: a banner at the top of the frame it came from.
  function banner(n) {
    const s = sections().find((x) => idOf(x) === n.sourceId);
    if (!s || s.classList.contains('minimized') || s.classList.contains('hidden')) return;
    for (const old of s.querySelectorAll(':scope > .wn-banner')) old.remove();
    const b = document.createElement('div');
    b.className = 'wn-banner';
    b.innerHTML = `<div class="n-ico">${AeroNotify.sourceGlyph(n)}</div>
      <div class="n-body"><div class="n-title">${AeroNotify.esc(n.title)}</div>${n.body ? `<div class="n-text">${AeroNotify.esc(n.body)}</div>` : ''}</div>
      <button class="n-x" title="Close">✕</button>`;
    let t = null;
    const gone = () => { clearTimeout(t); b.classList.remove('in'); setTimeout(() => b.remove(), 220); };
    b.addEventListener('click', (e) => {
      if (e.target.closest('.n-x')) { gone(); return; }
      gone();
      toggleDrop(s);                 // the full list, this one included
    });
    b.addEventListener('pointerenter', () => clearTimeout(t));
    b.addEventListener('pointerleave', () => { t = setTimeout(gone, 2500); });
    s.appendChild(b);
    requestAnimationFrame(() => b.classList.add('in'));
    t = setTimeout(gone, BANNER_MS);
  }

  function update(state) {
    items = (state && state.items) || [];
    const ids = new Set(items.map((n) => n.id));
    if (known) {
      // Newest first: the first unseen web one gets the banner.
      const fresh = items.filter((n) => n.source === 'web' && n.sourceId && !known.has(n.id) && !n.read);
      if (fresh.length) banner(fresh[0]);
    }
    known = ids;
    paintBells();
    if (openFor) { if (forWidget(openFor).length) renderDrop(); else closeDrop(); }
  }

  function init(opts) {
    aero = opts.aero;
    if (!aero.onNotificationsChanged || !window.AeroNotify || !AeroNotify.renderConversations) return;
    aero.onNotificationsChanged(update);
    aero.notifyList().then(update).catch(() => {});
    // Web widgets added or rebuilt: put their bells back.
    const mo = new MutationObserver(() => paintBells());
    const root = document.getElementById('sidebar') || document.body;
    mo.observe(root, { childList: true });
    window.addEventListener('resize', () => { if (dropEl && openFor) { const s = sections().find((x) => idOf(x) === openFor); if (s) placeDrop(s); } });
  }

  window.AeroWebNotify = { init };
})();
