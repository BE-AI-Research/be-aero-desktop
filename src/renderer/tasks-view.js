// BE-Aero Desktop - Application dock (macOS-dock style).
//
// Pinned apps sit first and are always present - click launches them when
// they are not running. Every other running application follows, grouped by
// executable like the Windows taskbar. A dot under a tile means the app is
// running; click focuses (repeated clicks cycle that app's windows);
// right-click opens the management menu (windows, pin/unpin, new window,
// minimize all, close all). Minimized web widgets park at the end.
(function () {
  'use strict';

  const REFRESH_MS = 2500;

  let aero = null;
  let barEl = null;
  let timer = null;
  let lastKey = '';
  let pinnedApps = [];
  let minimizedWidgets = [];
  let onRestoreWidget = null;
  const iconCache = new Map();     // exe -> dataURL|null
  const cycle = new Map();         // app key -> next window index for click-cycling

  const el = (tag, cls, parent, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  };

  async function iconFor(exe) {
    if (!exe) return null;
    if (iconCache.has(exe)) return iconCache.get(exe);
    const url = await aero.taskIcon(exe);
    if (iconCache.size > 200) iconCache.clear();
    iconCache.set(exe, url);
    return url;
  }

  function tileEl(parent, { title, running, dim }) {
    const t = el('button', `dock-tile${running ? ' running' : ''}${dim ? ' dim' : ''}`, parent);
    t.title = title;
    const ic = el('div', 'dock-ico', t);
    el('div', 'dock-dot', t);
    return { t, ic };
  }

  async function onTileClick(tile) {
    if (!tile.windows.length) {
      // Pinned but not running: the dock is a launcher too.
      if (tile.exe) await aero.dockLaunch(tile.exe);
      setTimeout(() => { lastKey = ''; refresh(); }, 900);
      return;
    }
    const AeroDockM = window.AeroDock;
    const idx = cycle.get(tile.key) || 0;
    const target = AeroDockM.clickTarget(tile, idx);
    cycle.set(tile.key, idx + 1);
    if (target) await aero.taskAction('activate', target.hwnd);
  }

  async function refresh() {
    if (!barEl || barEl.closest('.widget').classList.contains('hidden')) return;
    const windows = await aero.listTasks();
    const tiles = window.AeroDock.buildDock(windows, pinnedApps);

    const key = JSON.stringify([
      tiles.map((t) => [t.key, t.pinned, t.running, t.windows.map((w) => [w.hwnd, w.min])]),
      minimizedWidgets.map((w) => [w.id, w.name, w.favicon])
    ]);
    if (key === lastKey) return;
    lastKey = key;

    barEl.textContent = '';

    for (const tile of tiles) {
      const allMin = tile.running && tile.windows.every((w) => w.min);
      const { t, ic } = tileEl(barEl, {
        title: tile.windows.length
          ? `${tile.name}\n${tile.windows.map((w) => `• ${w.title}`).join('\n')}`
          : `${tile.name} - click to open`,
        running: tile.running,
        dim: allMin
      });
      if (tile.windows.length > 1) el('span', 'dock-count', t, String(tile.windows.length));
      t.addEventListener('click', () => onTileClick(tile));
      t.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        await aero.dockMenu({ key: tile.key, exe: tile.exe, name: tile.name, windows: tile.windows });
        lastKey = '';
        setTimeout(refresh, 400);
      });
      iconFor(tile.exe).then((url) => {
        if (!t.isConnected) return;
        if (url) {
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          ic.appendChild(img);
        } else {
          ic.textContent = tile.name.slice(0, 1).toUpperCase();
        }
      });
    }

    if (minimizedWidgets.length) {
      el('div', 'dock-sep', barEl);
      for (const w of minimizedWidgets) {
        const { t, ic } = tileEl(barEl, { title: `${w.name || w.url}\nMinimized widget - click to restore`, running: true, dim: false });
        t.classList.add('dock-webwidget');
        if (w.favicon) {
          const img = document.createElement('img');
          img.src = w.favicon;
          img.alt = '';
          img.addEventListener('error', () => { ic.textContent = '🌐'; img.remove(); });
          ic.appendChild(img);
        } else {
          ic.textContent = '🌐';
        }
        t.addEventListener('click', () => onRestoreWidget && onRestoreWidget(w.id));
        t.addEventListener('contextmenu', (e) => { e.preventDefault(); onRestoreWidget && onRestoreWidget(w.id); });
      }
    }

    if (window.AeroNotify) AeroNotify.renderTile(barEl);
    if (!tiles.length && !minimizedWidgets.length && !window.AeroNotify) {
      // Wayland offers no way to list other applications' windows (that is a
      // compositor policy, not a bug here), so on Linux the dock is a parking
      // strip for pins and minimized web widgets rather than a taskbar.
      el('div', 'tempty', barEl, (aero && aero.platform === 'linux')
        ? 'Minimized web widgets park here'
        : 'No open applications');
    }
  }

  function init(opts) {
    aero = opts.aero;
    onRestoreWidget = opts.onRestoreWidget || null;
    barEl = document.getElementById('task-list');
    clearInterval(timer);
    timer = setInterval(refresh, REFRESH_MS);
    refresh();
  }

  // Pins live in settings; the sidebar pushes them here on every change.
  function update(settings) {
    const dock = settings.dock || {};
    if (barEl) {
      const align = { left: 'flex-start', right: 'flex-end' }[dock.align] || 'center';
      barEl.style.justifyContent = align;
    }
    const pinned = dock.pinned || [];
    const snapshot = JSON.stringify(pinned);
    if (snapshot !== JSON.stringify(pinnedApps)) {
      pinnedApps = pinned;
      lastKey = '';
      refresh();
    }
  }

  function setMinimizedWidgets(list) {
    minimizedWidgets = Array.isArray(list) ? list : [];
    lastKey = '';
    refresh();
  }

  window.AeroTasks = { init, update, refresh, setMinimizedWidgets };
})();
