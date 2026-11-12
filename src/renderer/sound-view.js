// Sound widget: output device, master volume, a slider per app playing
// sound, and a Bluetooth panel (radio, paired devices, connect/disconnect).
// The dropdown picks the device: this one, another of mine (its mixer, over
// the mesh), or "All devices" (each device's volume, side by side).
// Data comes from main (sound.js): Core Audio on Windows, pactl and
// bluetoothctl on Linux.
(function () {
  'use strict';

  let aero = null;
  let root = null;
  let timer = null;
  let btTimer = null;
  let state = null;
  let bt = null;
  const busy = new Set();          // ids being dragged or changed: refresh leaves them alone
  const iconCache = new Map();
  let picker = null;
  const dev = () => (picker ? picker.value() : '');
  const isAll = () => !!picker && dev() === AeroDevicePicker.ALL;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SPEAKER = (muted) => `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" opacity=".9"/>${muted ? '<path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' : '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'}</svg>`;
  const BT_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 7l10 10-5 4V3l5 4L7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function visible() {
    return root && !root.classList.contains('hidden') && !document.hidden;
  }

  // A slider that sends while dragging (throttled) and holds off refreshes.
  function slider(row, value, key, send) {
    const input = row.querySelector('input[type=range]');
    const pct = row.querySelector('.sound-pct');
    input.value = Math.round(value * 100);
    pct.textContent = `${input.value}%`;
    let last = 0;
    let pending = null;
    const flush = () => { if (pending !== null) { const v = pending; pending = null; last = Date.now(); send(v / 100); } };
    input.addEventListener('pointerdown', () => busy.add(key));
    input.addEventListener('input', () => {
      busy.add(key);
      pct.textContent = `${input.value}%`;
      pending = Number(input.value);
      if (Date.now() - last > 70) flush(); else setTimeout(flush, 80);
    });
    const done = () => { flush(); setTimeout(() => busy.delete(key), 600); };
    input.addEventListener('change', done);
    input.addEventListener('pointerup', done);
  }

  function rowHtml(cls, icon, name, muted) {
    return `<div class="sound-row ${cls}">
      <button class="icon-btn sound-mute" title="${muted ? 'Unmute' : 'Mute'}">${SPEAKER(muted)}</button>
      <span class="sound-ico">${icon}</span><span class="sound-name" title="${esc(name)}">${esc(name)}</span>
      <input type="range" min="0" max="100" step="1"><span class="sound-pct"></span></div>`;
  }

  async function iconFor(exe) {
    if (!exe || !aero.taskIcon) return null;
    if (iconCache.has(exe)) return iconCache.get(exe);
    let url = null;
    try { url = await aero.taskIcon(exe); } catch { url = null; }
    iconCache.set(exe, url);
    return url;
  }

  function render() {
    if (!root || !state) return;
    const body = root.querySelector('.sound-mixer');
    if (state.error) { body.innerHTML = `<div class="sound-empty">${esc(state.error)}</div>`; return; }
    const d0 = dev();
    for (const e of body.querySelectorAll('.sound-empty:not(.sound-empty-apps)')) e.remove();   // "Starting…" 
    // Device picker
    const sel = root.querySelector('.sound-device');
    sel.classList.toggle('hidden', !!state.all);
    root.querySelector('.sound-bt-btn').classList.toggle('hidden', !!d0);      // Bluetooth: this device only
    if (!busy.has('device') && !state.all) {
      sel.innerHTML = state.devices.map((d) => `<option value="${esc(d.id)}"${d.default ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
      sel.disabled = state.devices.length < 2;
    }
    // Master and apps: rebuild only what is not being dragged.
    const keyOf = (s) => `app:${s.id}`;
    const devKey = (d) => `dev:${d.id || 'self'}`;
    const want = state.all ? state.all.map(devKey) : ['master', ...state.sessions.map(keyOf)];
    for (const r of [...body.querySelectorAll('.sound-row')]) if (!want.includes(r.dataset.key)) r.remove();
    const put = (key, cls, icon, name, vol, muted, onVol, onMute) => {
      let row = body.querySelector(`.sound-row[data-key="${CSS.escape(key)}"]`);
      if (row && busy.has(key)) return row;
      const tmp = document.createElement('div');
      tmp.innerHTML = rowHtml(cls, icon, name, muted);
      const fresh = tmp.firstElementChild;
      fresh.dataset.key = key;
      fresh.classList.toggle('muted', !!muted);
      slider(fresh, vol, key, onVol);
      fresh.querySelector('.sound-mute').addEventListener('click', async () => { busy.add(key); await onMute(!muted); busy.delete(key); refresh(); });
      if (row) row.replaceWith(fresh); else body.appendChild(fresh);
      return fresh;
    };
    // All devices: one volume per device.
    if (state.all) {
      for (const d of state.all) {
        const key = devKey(d);
        if (d.error || !d.master) {
          let row = body.querySelector(`.sound-row[data-key="${CSS.escape(key)}"]`);
          if (!row) { row = document.createElement('div'); row.className = 'sound-row sound-row-off'; row.dataset.key = key; body.appendChild(row); }
          row.innerHTML = `<span class="sound-ico">${SPEAKER(true)}</span><span class="sound-name">${esc(d.name)}</span><span class="sound-off-why">${esc(d.error || 'no volume control')}</span>`;
          continue;
        }
        put(key, `master${d.self ? '' : ' remote'}`, '', d.name, d.master.volume, d.master.mute,
          (v) => aero.soundSet('master', null, v, d.id), (m) => aero.soundSet('master-mute', null, m, d.id));
      }
      const e = body.querySelector('.sound-empty-apps'); if (e) e.remove();
      return;
    }
    if (state.master) {
      put('master', 'master', '', d0 && picker ? `Volume on ${picker.name(d0)}` : 'Volume', state.master.volume, state.master.mute,
        (v) => aero.soundSet('master', null, v, d0), (m) => aero.soundSet('master-mute', null, m, d0));
    }
    const sessions = state.sessions.filter((s) => !s.system || state.sessions.length > 0);
    for (const s of sessions) {
      const row = put(keyOf(s), `app${s.active ? ' playing' : ''}`, `<span class="sound-letter">${esc((s.name || '?').slice(0, 1).toUpperCase())}</span>`, s.name, s.volume, s.mute,
        (v) => aero.soundSet('app', s.id, v, d0), (m) => aero.soundSet('app-mute', s.id, m, d0));
      if (s.exe && row && !row.dataset.iconDone && !d0) {                         // icons: from this device's files
        row.dataset.iconDone = '1';
        iconFor(s.exe).then((url) => { if (url && row.isConnected) row.querySelector('.sound-ico').innerHTML = `<img src="${esc(url)}" alt="">`; });
      }
    }
    // keep master first
    const m = body.querySelector('.sound-row[data-key="master"]');
    if (m && body.firstElementChild !== m) body.prepend(m);
    if (!state.sessions.length && !body.querySelector('.sound-empty-apps')) {
      const e = document.createElement('div'); e.className = 'sound-empty sound-empty-apps'; e.textContent = 'No apps are playing sound.'; body.appendChild(e);
    } else if (state.sessions.length) { const e = body.querySelector('.sound-empty-apps'); if (e) e.remove(); }
  }

  async function refresh() {
    if (!visible()) return;
    const d = dev();
    let next;
    if (isAll()) {
      const list = picker.devices();
      const all = await Promise.all(list.map(async (x) => {
        try {
          const s = await aero.soundState(x.id);
          return { id: x.id, name: x.self ? `${x.name} (this device)` : x.name, self: !!x.self, master: s && !s.error ? s.master : null, error: s && s.error ? s.error : '' };
        } catch (err) { return { id: x.id, name: x.name, error: err.message }; }
      }));
      next = { all, devices: [], sessions: [] };
    } else {
      try { next = await aero.soundState(d); } catch (err) { next = { error: err.message }; }
    }
    if (d !== dev()) return;                           // the dropdown moved on meanwhile
    state = next;
    if (state && state.error && /did not answer/.test(state.error)) state.error = 'Starting the sound helper…';
    render();
  }

  // ---------------------------------------------------------- Bluetooth
  function renderBt() {
    const box = root.querySelector('.sound-bt');
    if (!bt) { box.innerHTML = '<div class="sound-empty">Looking for Bluetooth…</div>'; return; }
    const radio = bt.radio;
    box.innerHTML = `<div class="sound-bt-top">
        <span>Bluetooth</span>
        ${radio === null ? '<span class="sound-bt-state">no radio found</span>' : `<button class="btn sound-bt-power">${radio ? 'Turn off' : 'Turn on'}</button>`}
        <button class="btn sound-bt-settings">Settings…</button></div>
      <div class="sound-bt-list">${(bt.devices || []).length ? bt.devices.map((d) => `
        <div class="sound-bt-dev${d.connected ? ' on' : ''}" data-id="${esc(d.id)}">
          <span class="sound-bt-dot"></span><span class="sound-bt-name" title="${esc(d.name)}">${esc(d.name)}</span>
          <span class="sound-bt-bat">${d.battery != null ? `${d.battery}%` : ''}</span>
          <button class="btn sound-bt-act"${radio === false ? ' disabled' : ''}>${d.connected ? 'Disconnect' : 'Connect'}</button>
        </div>`).join('') : '<div class="sound-empty">No paired devices. Pair one in Bluetooth settings.</div>'}</div>
      ${bt.error ? `<div class="sound-empty">${esc(bt.error)}</div>` : ''}`;
    const power = box.querySelector('.sound-bt-power');
    if (power) power.addEventListener('click', async () => { power.disabled = true; const r = await aero.soundBt('power', null, !radio); if (r && r.error) bt.error = r.error; await refreshBt(); });
    box.querySelector('.sound-bt-settings').addEventListener('click', () => aero.soundBt('settings'));
    for (const b of box.querySelectorAll('.sound-bt-act')) {
      b.addEventListener('click', async () => {
        const row = b.closest('.sound-bt-dev');
        const d = bt.devices.find((x) => x.id === row.dataset.id);
        b.disabled = true; b.textContent = d.connected ? 'Disconnecting…' : 'Connecting…';
        const r = await aero.soundBt('connect', d.id, !d.connected);
        if (r && r.error) bt.error = `${d.name}: ${r.error}`; else bt.error = '';
        setTimeout(refreshBt, 1500);
      });
    }
  }

  async function refreshBt() {
    if (!root || root.querySelector('.sound-bt').classList.contains('hidden')) return;
    const prevErr = bt && bt.error;
    try { const r = await aero.soundBt('state'); bt = r && r.result ? r.result : { radio: null, devices: [], error: (r && r.error) || 'Bluetooth is not available' }; } catch (err) { bt = { radio: null, devices: [], error: err.message }; }
    if (prevErr && !bt.error) bt.error = prevErr;
    renderBt();
  }

  function toggleBt() {
    const box = root.querySelector('.sound-bt');
    const open = box.classList.toggle('hidden') === false;
    root.querySelector('.sound-bt-btn').classList.toggle('on', open);
    clearInterval(btTimer);
    if (open) { bt = null; renderBt(); refreshBt(); btTimer = setInterval(refreshBt, 6000); }
  }

  function init(opts) {
    aero = opts.aero;
    root = document.querySelector('.sound-widget');
    if (!root || !aero.soundState) return;
    root.insertAdjacentHTML('afterbegin', `
      <div class="sound-head">
        <h3 class="widget-title">SOUND</h3>
        <span class="sound-pick"></span>
        <button class="icon-btn sound-bt-btn" title="Bluetooth devices">${BT_ICON}</button>
      </div>
      <select class="sound-device" title="Output device"></select>
      <div class="sound-mixer"><div class="sound-empty">Starting the sound helper…</div></div>
      <div class="sound-bt hidden"></div>`);
    const sel = root.querySelector('.sound-device');
    sel.addEventListener('focus', () => busy.add('device'));
    sel.addEventListener('blur', () => busy.delete('device'));
    sel.addEventListener('change', async () => { await aero.soundSet('default', sel.value, null, dev()); busy.delete('device'); sel.blur(); setTimeout(refresh, 300); });
    if (window.AeroDevicePicker && aero.mediaDevices) {
      picker = AeroDevicePicker.create({
        aero, key: 'sound', all: true,
        onChange: () => {
          // A different device: start the mixer over, and Bluetooth stays with this one.
          busy.clear();
          root.querySelector('.sound-mixer').innerHTML = '<div class="sound-empty">Asking…</div>';
          const btBox = root.querySelector('.sound-bt');
          if (dev() && !btBox.classList.contains('hidden')) toggleBt();
          refresh();
        }
      });
      root.querySelector('.sound-pick').replaceWith(picker.el);
    } else root.querySelector('.sound-pick').remove();
    root.querySelector('.sound-bt-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleBt(); });
    refresh();
    timer = setInterval(refresh, 2000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }

  window.AeroSound = { init, refresh };
})();
