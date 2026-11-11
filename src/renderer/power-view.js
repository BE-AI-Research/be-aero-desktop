// BE-Aero Desktop - power menu: a tile at the far end of the dock, apart
// from the app icons, opening Lock / Switch user / Log off / Sleep /
// Restart / Shut down. Log off, restart and shut down ask for confirmation inside the menu.
(function () {
  'use strict';

  const ITEMS = [
    { id: 'lock', label: 'Lock', glyph: '🔒', confirm: false },
    { id: 'switchuser', label: 'Switch user', glyph: '👥', confirm: false },
    { id: 'logout', label: 'Log off', glyph: '↪', confirm: true },
    { id: 'sleep', label: 'Sleep', glyph: '☾', confirm: false },
    { id: 'restart', label: 'Restart', glyph: '↻', confirm: true },
    { id: 'shutdown', label: 'Shut down', glyph: '⏻', confirm: true }
  ];
  const GEAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.8l1.7 2.4 2.9-.6.9 2.8 2.7 1.3-.6 2.9L21.2 14l-2.4 1.7.6 2.9-2.8.9-1.3 2.7-2.9-.6L12 21.2l-1.7-2.4-2.9.6-.9-2.8-2.7-1.3.6-2.9L2.8 10l2.4-1.7-.6-2.9 2.8-.9 1.3-2.7 2.9.6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const POWER_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  let aero = null;
  let widget = null;
  let wrap = null;      // .dock-power container (tile + divider)
  let tile = null;
  let panel = null;
  let cfg = { enabled: true, side: 'right' };

  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    if (tile) tile.classList.remove('open');
  }
  function outside(e) { if (panel && !panel.contains(e.target) && !tile.contains(e.target)) closePanel(); }
  function onKey(e) { if (e.key === 'Escape') closePanel(); }

  function place() {
    if (!panel || !tile) return;
    const r = tile.getBoundingClientRect();
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const above = r.top > window.innerHeight * 0.4;
    let left = cfg.side === 'left' ? r.left : r.right - pw;
    left = Math.max(8, Math.min(window.innerWidth - pw - 8, left));
    panel.style.left = `${left}px`;
    panel.style.top = `${above ? Math.max(8, r.top - ph - 8) : r.bottom + 8}px`;
  }

  function renderItems() {
    panel.textContent = '';
    el('div', 'power-head', panel, 'Power');
    for (const it of ITEMS) {
      const b = el('button', `power-item power-${it.id}`, panel);
      b.dataset.action = it.id;
      el('span', 'power-glyph', b, it.glyph);
      el('span', 'power-label', b, it.label);
      b.addEventListener('click', () => (it.confirm ? askConfirm(it) : act(it)));
    }
    place();
  }

  function askConfirm(it) {
    panel.textContent = '';
    el('div', 'power-head', panel, `${it.label} now?`);
    el('div', 'power-note', panel, it.id === 'logout' ? 'Unsaved work in open apps may be lost.' : 'Open apps will be closed; unsaved work may be lost.');
    const row = el('div', 'power-confirm', panel);
    const yes = el('button', 'btn btn-danger power-yes', row, it.label);
    const no = el('button', 'btn power-no', row, 'Cancel');
    yes.addEventListener('click', () => act(it));
    no.addEventListener('click', renderItems);
    place();
    no.focus();
  }

  async function act(it) {
    panel.textContent = '';
    el('div', 'power-head', panel, `${it.label}…`);
    place();
    let r = null;
    try { r = await aero.powerAction(it.id); } catch (err) { r = { ok: false, error: String(err && err.message || err) }; }
    if (r && r.ok) { closePanel(); return; }
    panel.textContent = '';
    el('div', 'power-head', panel, `${it.label} failed`);
    el('div', 'power-note', panel, (r && r.error) || 'The system refused the request.');
    const back = el('button', 'btn power-no', panel, 'Back');
    back.addEventListener('click', renderItems);
    place();
  }

  function togglePanel() {
    if (panel) { closePanel(); return; }
    panel = el('div', 'power-panel widget-hit', document.body);
    tile.classList.add('open');
    renderItems();
    setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  function build() {
    if (wrap) return;
    wrap = el('div', 'dock-power');
    el('div', 'dock-sep power-sep', wrap);
    // Notifications bell, then the operating system's own Settings, then power.
    el('div', 'notify-slot', wrap);
    const gear = el('button', 'dock-tile os-settings-tile', wrap);
    gear.title = navigator.userAgent.includes('Windows') ? 'Windows Settings' : 'System Settings';
    el('span', 'dock-ico power-ico', gear).innerHTML = GEAR_SVG;
    gear.addEventListener('click', () => { closePanel(); if (aero && aero.openOsSettings) aero.openOsSettings(); });
    tile = el('button', 'dock-tile power-tile', wrap);
    tile.title = 'Power: lock, switch user, log off, sleep, restart, shut down';
    const ic = el('span', 'dock-ico power-ico', tile);
    ic.innerHTML = POWER_SVG;
    tile.addEventListener('click', togglePanel);
  }

  // settings.powerMenu = { enabled, side: 'left' | 'right' }
  function update(settings) {
    const pm = (settings && settings.powerMenu) || {};
    cfg = { enabled: pm.enabled !== false, side: pm.side === 'left' ? 'left' : 'right' };
    if (!widget) return;
    const bar0 = widget.querySelector('#task-list');
    if (!cfg.enabled) {
      closePanel();
      if (wrap) wrap.remove();
      widget.classList.remove('has-power', 'power-left', 'power-right');
      if (window.AeroNotify && bar0) AeroNotify.renderTile(bar0);      // the bell goes back to the dock's end
      return;
    }
    build();
    const bar = bar0;
    if (cfg.side === 'left') widget.insertBefore(wrap, bar); else widget.appendChild(wrap);
    wrap.classList.toggle('left', cfg.side === 'left');
    // Keep the bell on the gear's left on either side (the left group is drawn reversed).
    const slot = wrap.querySelector('.notify-slot');
    const gearEl = wrap.querySelector('.os-settings-tile');
    if (cfg.side === 'left') wrap.insertBefore(slot, gearEl.nextSibling); else wrap.insertBefore(slot, gearEl);
    if (window.AeroNotify) AeroNotify.renderTile(slot);
    widget.classList.add('has-power');
    widget.classList.toggle('power-left', cfg.side === 'left');
    widget.classList.toggle('power-right', cfg.side !== 'left');
  }

  function init(opts) {
    aero = opts.aero;
    widget = document.querySelector('.tasks-widget');
    window.addEventListener('resize', place);
  }

  window.AeroPower = { init, update, togglePanel, closePanel, ITEMS };
})();
