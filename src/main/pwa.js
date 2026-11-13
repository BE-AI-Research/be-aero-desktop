// Web apps installed from Chrome or Edge ("Install app", PWAs) run inside
// chrome.exe / msedge.exe, so by program they all look like the browser.
// Windows tags each of their windows with its own app id, and the browser
// puts a Start Menu shortcut for each app ("...\Chrome Apps\YouTube
// Music.lnk", arguments "--app-id=<32 letters>"). This maps one to the
// other, so the dock can show a web app as itself: its name, its icon,
// launched and pinned through its shortcut.
//
// The window's id is "Chrome._crx_<id>", where <id> is the app id SHORTENED
// to its first 10 and last 16 letters (Chrome keeps the whole id under the
// length Windows allows), sometimes with a profile suffix after a dot.
const fs = require('fs');
const path = require('path');

const WIN_ID = /_crx_([a-p]{26,32})/i;
const ARG_ID = /--app-id=([a-p]{32})/i;
const RESCAN_MS = 60000;

const short = (id) => (id.length > 26 ? id.slice(0, 10) + id.slice(-16) : id);
// The key a window's app id and a shortcut's app id share.
const keyOfWindow = (aumid) => { const m = WIN_ID.exec(String(aumid || '')); return m ? short(m[1].toLowerCase()) : null; };
const keyOfApp = (appId) => short(String(appId).toLowerCase());

class PwaShortcuts {
  // readShortcut(lnk) -> { target, args, icon } (Electron's shell.readShortcutLink); dirs: Start Menu folders
  constructor({ readShortcut, dirs }) {
    this.readShortcut = readShortcut;
    this.dirs = dirs;
    this.map = new Map();          // key -> [{ lnk, name, icon, target }]
    this.scannedAt = 0;
  }

  scan() {
    this.scannedAt = Date.now();
    const map = new Map();
    const walk = (dir, depth) => {
      let list;
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of list) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
        if (!/\.lnk$/i.test(d.name)) continue;
        let link;
        try { link = this.readShortcut(p); } catch { continue; }
        const m = ARG_ID.exec(String((link && link.args) || ''));
        if (!m || !/(chrome_proxy|chrome|msedge_proxy|msedge|brave|vivaldi)\.exe$/i.test(String(link.target || ''))) continue;
        const key = keyOfApp(m[1]);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ lnk: p, name: d.name.replace(/\.lnk$/i, ''), icon: link.icon || '', target: String(link.target || '') });
      }
    };
    for (const d of this.dirs) walk(d, 0);
    this.map = map;
  }

  // The web app behind a window, or null (not a web app, or no shortcut).
  // exe: the window's program - the shortcut for the same browser install wins.
  lookup(aumid, exe = '') {
    const key = keyOfWindow(aumid);
    if (!key) return null;
    if (!this.map.has(key) && Date.now() - this.scannedAt > RESCAN_MS) this.scan();   // installed since
    const list = this.map.get(key);
    if (!list || !list.length) return null;
    const dir = path.dirname(String(exe || '')).toLowerCase();
    const score = (s) => (dir && path.dirname(s.target).toLowerCase() === dir ? 0 : 10) + (/ \(\d+\)$/.test(s.name) ? 1 : 0);
    return [...list].sort((a, b) => score(a) - score(b) || a.name.length - b.name.length)[0];
  }
}

module.exports = { PwaShortcuts, keyOfWindow, keyOfApp };
