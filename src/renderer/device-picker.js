// A device dropdown for widgets that can act on my other devices (Now
// Playing, Sound): this device, each connected device, and optionally
// "All devices". The choice is remembered per widget. Hidden while there
// is no other device to pick.
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ALL = '*';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private */ } }
  };

  // opts: { aero, key, all: bool, onChange(value) } -> { el, value(), devices(), name(id), refresh() }
  function create(opts) {
    const { aero, key, all = false, onChange = () => {} } = opts;
    const storeKey = `aero.devpick.${key}`;
    let value = store.get(storeKey) || '';
    let devices = [{ id: '', name: 'This device', self: true }];
    let menu = null;

    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'devpick hidden';
    el.title = 'Choose the device to control';

    const nameOf = (id) => (id === ALL ? 'All devices' : (devices.find((d) => d.id === id) || {}).name || 'Another device');
    function paint() {
      const self = !value;
      el.innerHTML = `<span class="devpick-n">${esc(self ? 'This device' : nameOf(value))}</span><span class="devpick-c">▾</span>`;
      el.classList.toggle('remote', !self);
      const online = value === ALL || !value || devices.some((d) => d.id === value);
      el.classList.toggle('off', !online);
      el.title = online ? `Controlling ${self ? 'this device' : nameOf(value)} - click to choose another` : `${nameOf(value)} is not connected right now`;
      el.classList.toggle('hidden', devices.length < 2 && !value);
    }

    async function refresh() {
      try { const list = await aero.mediaDevices(); if (Array.isArray(list) && list.length) devices = list; } catch { /* keep */ }
      paint();
    }

    function set(v) {
      value = v || '';
      store.set(storeKey, value);
      paint();
      onChange(value);
    }

    function close() {
      if (!menu) return;
      menu.remove(); menu = null;
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey, true);
    }
    function outside(e) { if (menu && !menu.contains(e.target) && !el.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') close(); }

    async function open() {
      if (menu) { close(); return; }
      await refresh();
      menu = document.createElement('div');
      menu.className = 'devpick-menu widget-hit';
      const items = devices.map((d) => ({ id: d.id, name: d.self ? `${d.name} (this device)` : d.name, icon: d.self ? '🖥️' : '💻' }));
      if (all && devices.length > 1) items.push({ id: ALL, name: 'All devices', icon: '🎚️' });
      if (value && value !== ALL && !devices.some((d) => d.id === value)) items.push({ id: value, name: `${nameOf(value)} (not connected)`, icon: '⚠️', off: true });
      menu.innerHTML = items.map((i) => `<button class="devpick-item${i.id === value ? ' on' : ''}${i.off ? ' off' : ''}" data-id="${esc(i.id)}"><span class="g">${i.icon}</span><span>${esc(i.name)}</span></button>`).join('');
      menu.addEventListener('click', (e) => {
        const b = e.target.closest('.devpick-item');
        if (!b) return;
        close();
        if (b.dataset.id !== value) set(b.dataset.id);
      });
      document.body.appendChild(menu);
      const r = el.getBoundingClientRect();
      const w = Math.max(180, r.width);
      menu.style.minWidth = `${w}px`;
      menu.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, r.right - w))}px`;
      const h = menu.offsetHeight;
      menu.style.top = `${r.bottom + 4 + h > window.innerHeight ? Math.max(6, r.top - h - 4) : r.bottom + 4}px`;
      setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey, true); }, 0);
    }

    el.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    if (aero.onDevicesChanged) {
      let t = null;
      aero.onDevicesChanged(() => { clearTimeout(t); t = setTimeout(refresh, 500); });
    }
    paint();
    refresh();
    return { el, value: () => value, devices: () => devices, name: nameOf, refresh, ALL };
  }

  window.AeroDevicePicker = { create, ALL };
})();
