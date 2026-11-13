// Application-dock model: turns a flat list of open windows plus the user's
// pinned apps into the ordered tiles the dock renders - pinned apps first
// (running or not), then every other running application, grouped by
// executable the way a taskbar groups by app.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AeroDock = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A friendlier label than "msedge": the exe base name, de-camelled and
  // title-cased, with the overrides people actually recognise.
  const NAME_OVERRIDES = {
    chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', explorer: 'File Explorer',
    devenv: 'Visual Studio', code: 'VS Code', vscodium: 'VSCodium', windowsterminal: 'Terminal',
    wt: 'Terminal', powershell: 'PowerShell', pwsh: 'PowerShell', mstsc: 'Remote Desktop',
    applicationframehost: 'Store app', olk: 'Outlook', 'ms-teams': 'Teams'
  };

  function appNameFromExe(exe) {
    if (typeof exe !== 'string' || !exe) return 'App';
    const base = exe.replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').replace(/\.desktop$/i, '').replace(/\.lnk$/i, '');
    const key = base.toLowerCase();
    if (NAME_OVERRIDES[key]) return NAME_OVERRIDES[key];
    return base
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .slice(0, 32);
  }

  const exeKey = (exe) => (typeof exe === 'string' ? exe.toLowerCase() : '');
  const baseKey = (exe) => exeKey(exe).replace(/\\/g, '/').split('/').pop().replace(/\.exe$/, '');

  // windows: [{hwnd, title, pid, exe, min}]  (tasks worker output)
  // pinned:  [{exe, name}]                   (settings.dock.pinned)
  // -> ordered tiles: { key, exe, name, pinned, running, windows: [...] }
  function buildDock(windows, pinned) {
    const byExe = new Map();
    for (const w of Array.isArray(windows) ? windows : []) {
      if (!w || !w.exe) continue;
      const key = exeKey(w.exe);
      if (!byExe.has(key)) byExe.set(key, []);
      byExe.get(key).push(w);
    }

    const tiles = [];
    const seen = new Set();

    for (const p of Array.isArray(pinned) ? pinned : []) {
      if (!p || !p.exe) continue;
      const key = exeKey(p.exe);
      if (seen.has(key)) continue;
      seen.add(key);
      let wins = byExe.get(key) || [];
      // Windows 11 system apps launch through a trampoline (C:/Windows/
      // notepad.exe) while the real process runs from a Store package path.
      // When the exact path has no windows, adopt a running app with the
      // same executable BASE NAME so pin and process stay one tile.
      if (!wins.length) {
        for (const [k, candidate] of byExe) {
          if (!seen.has(k) && baseKey(k) === baseKey(key)) {
            wins = candidate;
            seen.add(k);
            break;
          }
        }
      }
      tiles.push({
        key,
        exe: p.exe,
        name: p.name || appNameFromExe(p.exe),
        pinned: true,
        running: wins.length > 0,
        windows: wins
      });
    }

    for (const [key, wins] of byExe) {
      if (seen.has(key)) continue;
      tiles.push({
        key,
        exe: wins[0].exe,
        // A window source that knows the application's real name (Linux
        // .desktop entries) says so on each window.
        name: wins[0].app || appNameFromExe(wins[0].exe),
        pinned: false,
        running: true,
        windows: wins
      });
    }
    return tiles;
  }

  // Which window a plain click should go to. Taskbar behaviour: repeated
  // clicks cycle through the app's windows; cycleIndex is the caller's
  // remembered position for this app.
  function clickTarget(tile, cycleIndex) {
    const wins = (tile && tile.windows) || [];
    if (!wins.length) return null;
    const i = ((Number(cycleIndex) || 0) % wins.length + wins.length) % wins.length;
    return wins[i];
  }

  // Toggle an app in the pinned list (pure; returns the new list).
  function togglePinned(pinned, exe, name) {
    const list = Array.isArray(pinned) ? pinned : [];
    const key = exeKey(exe);
    if (!key) return list;
    const without = list.filter((p) => exeKey(p && p.exe) !== key);
    if (without.length !== list.length) return without;      // was pinned -> unpin
    return [...list, { exe, name: name || appNameFromExe(exe) }].slice(0, 24);
  }

  // Move one pinned app to a new position (pure; returns the new list).
  // toIndex is the slot in the list WITHOUT the moved app, clamped.
  function reorderPinned(pinned, exe, toIndex) {
    const list = Array.isArray(pinned) ? pinned : [];
    const key = exeKey(exe);
    const from = list.findIndex((p) => exeKey(p && p.exe) === key);
    if (from < 0) return list;
    const rest = list.filter((_, i) => i !== from);
    const at = Math.max(0, Math.min(rest.length, Math.floor(Number(toIndex) || 0)));
    rest.splice(at, 0, list[from]);
    return rest;
  }

  function isPinned(pinned, exe) {
    const key = exeKey(exe);
    return (Array.isArray(pinned) ? pinned : []).some((p) => exeKey(p && p.exe) === key);
  }

  return { buildDock, clickTarget, togglePinned, reorderPinned, isPinned, appNameFromExe, exeKey };
});
