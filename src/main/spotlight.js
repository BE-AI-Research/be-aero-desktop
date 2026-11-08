// Spotlight-style launcher window: global hotkey, index management, open/reveal.
const { BrowserWindow, ipcMain, shell, screen, globalShortcut, app, nativeImage, clipboard } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { buildIndex } = require('./indexer');
const { search, calculate } = require('./search');
const { uwpIcon } = require('./uwp');
const { normalize, isValid } = require('../shared/hotkey');
const { themeVars } = require('./themes');

const REINDEX_MS = 30 * 60 * 1000; // same cadence as HorusSearch's DB refresh
const TEXT_PREVIEW_EXTS = new Set(['.txt', '.md', '.json', '.js', '.ts', '.css', '.html', '.htm', '.xml',
  '.yml', '.yaml', '.ini', '.log', '.csv', '.py', '.cs', '.c', '.cpp', '.h', '.ps1', '.bat', '.cmd', '.sh']);
// Search engines offered for the "search the web" result. A value that is not
// a known key is treated as a URL template containing {q}.
const ENGINES = {
  bing: 'https://www.bing.com/search?q={q}',
  google: 'https://www.google.com/search?q={q}',
  duckduckgo: 'https://duckduckgo.com/?q={q}',
  brave: 'https://search.brave.com/search?q={q}'
};

function webSearchUrl(engine, q) {
  const template = ENGINES[engine] || (/\{q\}/.test(engine || '') ? engine : ENGINES.bing);
  return template.replace('{q}', encodeURIComponent(q));
}

const WIDTH = 760;
const HEIGHT = 520;

class Spotlight {
  constructor({ store, root, onSettingsChanged }) {
    this.store = store;
    this.root = root;
    this.onSettingsChanged = onSettingsChanged;
    this.win = null;
    this.index = { entries: [], stats: null };
    this.uwpRoots = {};
    this.indexing = null;
    this.iconCache = new Map();
    this.hotkey = null;
    this.timer = null;
  }

  init() {
    this.createWindow();
    this.registerIpc();
    this.applyHotkey(this.store.get('search').hotkey);
    this.reindex();
    this.timer = setInterval(() => this.reindex(), REINDEX_MS);
  }

  createWindow() {
    this.win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'spotlight-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    this.win.loadFile(path.join(this.root, 'src', 'renderer', 'spotlight.html'));
    this.win.webContents.on('did-finish-load', () => this.applyTheme(this.store.get('theme')));
    // Like Spotlight / HorusSearch: disappear when focus moves elsewhere.
    this.win.on('blur', () => this.hide());
    if (!app.isPackaged) {
      this.win.webContents.on('console-message', (e) => {
        console.log(`[spotlight:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
      });
    }
  }

  // Centre horizontally, a third of the way down the display under the cursor.
  position() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = display.workArea;
    this.win.setBounds({
      x: Math.round(wa.x + (wa.width - WIDTH) / 2),
      y: Math.round(wa.y + wa.height * 0.18),
      width: WIDTH,
      height: HEIGHT
    });
  }

  // Push the current theme's CSS variables into the launcher window. Called
  // on load and whenever the theme changes while the app runs.
  applyTheme(theme) {
    if (!this.win) return;
    this.win.webContents.send('spotlight:theme', themeVars(theme));
  }

  show(query = '') {
    if (!this.win) return;
    this.position();
    this.win.show();
    this.win.focus();
    this.win.webContents.send('spotlight:show', { query, stats: this.index.stats });
  }

  hide() {
    if (this.win && this.win.isVisible()) {
      this.win.hide();
      this.win.webContents.send('spotlight:hidden');
    }
  }

  toggle() {
    if (this.win && this.win.isVisible()) this.hide(); else this.show();
  }

  // Register the hotkey; fall back to Ctrl+Space if the preferred one is taken.
  applyHotkey(accel) {
    if (this.hotkey) globalShortcut.unregister(this.hotkey);
    this.hotkey = null;
    // The user's choice first, then fallbacks: other launchers (PowerToys Run,
    // Gemini, IMEs) often already own Alt+Space and Ctrl+Space.
    const wanted = isValid(accel) ? normalize(accel) : null;
    const candidates = [...new Set([wanted, 'Alt+Space', 'Control+Space', 'Control+Alt+Space',
      'Super+Shift+Space', 'Alt+Shift+Space'].filter(Boolean))];
    for (const c of candidates) {
      try {
        if (globalShortcut.register(c, () => this.toggle())) {
          this.hotkey = c;
          break;
        }
      } catch (err) {
        console.warn('Invalid hotkey', c, err.message);
      }
    }
    if (!this.hotkey) console.warn('Could not register any Spotlight hotkey');
    else if (this.hotkey !== wanted) console.warn(`Spotlight hotkey ${accel} is taken; using ${this.hotkey}`);
    else console.log(`Spotlight hotkey: ${this.hotkey}`);
    return this.hotkey;
  }

  async reindex() {
    if (this.indexing) return this.indexing;
    const extraRoots = this.store.get('search').extraRoots || [];
    this.indexing = buildIndex({ extraRoots })
      .then((idx) => {
        this.index = idx;
        this.uwpRoots = idx.uwpRoots || {};
        console.log(`Spotlight index: ${idx.stats.apps} apps (${idx.stats.uwp || 0} UWP), `
          + `${idx.stats.files} files in ${idx.stats.ms}ms`);
        if (this.win) this.win.webContents.send('spotlight:indexed', idx.stats);
        return idx.stats;
      })
      .catch((err) => { console.error('Indexing failed', err); return null; })
      .finally(() => { this.indexing = null; });
    return this.indexing;
  }

  query(q) {
    const text = (q || '').trim();
    const result = search(text, this.index.entries, {
      launchCounts: this.store.get('search').launchCounts || {}
    });
    const calc = calculate(text);
    return { ...result, calc, query: text, webEngine: this.store.get('search').webEngine || 'bing',
      indexing: !!this.indexing && !this.index.stats };
  }

  async open(item) {
    if (!item || !item.path) return;
    const p = item.path;
    // Remember launches so frequently used items rank higher.
    const s = this.store.get('search');
    const counts = { ...(s.launchCounts || {}) };
    counts[p] = (counts[p] || 0) + 1;
    this.store.set({ search: { launchCounts: counts } });

    this.hide();
    if (/^ms-settings:/i.test(p)) {
      await shell.openExternal(p);
    } else if (/^shell:/i.test(p)) {
      spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const err = await shell.openPath(p);
      if (err) {
        // No associated program: show "Open with" like HorusSearch does.
        spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', p], { detached: true, stdio: 'ignore' }).unref();
      }
    }
  }

  reveal(item) {
    if (!item || !item.path || /^(ms-settings|shell):/i.test(item.path)) return;
    this.hide();
    shell.showItemInFolder(item.path);
  }

  // Windows hands back the same generic glyph for every .lnk, so a Start Menu
  // full of shortcuts would show one identical icon. Resolve the shortcut to
  // what it actually points at and take the icon from there instead.
  iconCandidates(p) {
    const ext = path.extname(p).toLowerCase();
    const out = [];
    const add = (c) => { if (c && typeof c === 'string' && !out.includes(c)) out.push(c); };

    if (ext === '.lnk') {
      try {
        const link = shell.readShortcutLink(p);
        // An explicitly assigned icon wins, but only when it is a real image
        // or executable - icon libraries (.dll/.ico with an index) give the
        // generic glyph again, so the target is the better source.
        if (link.icon && /\.(exe|ico|png)$/i.test(link.icon)) add(link.icon);
        add(link.target);
      } catch { /* malformed or unreadable shortcut */ }
    } else if (ext === '.url') {
      try {
        const ini = fsSync.readFileSync(p, 'utf8');
        const iconFile = /^IconFile=(.+)$/im.exec(ini);
        if (iconFile) add(iconFile[1].trim());
      } catch { /* unreadable */ }
    }
    add(p); // always fall back to the entry itself
    return out;
  }

  // Favicon for a .url internet shortcut: most carry no usable IconFile, so
  // ask the site itself for /favicon.ico. Returns a data url or null.
  async urlFavicon(p) {
    let origin = null;
    try {
      const ini = fsSync.readFileSync(p, 'utf8');
      const m = /^URL=(.+)$/im.exec(ini);
      if (m) origin = new URL(m[1].trim()).origin;
    } catch { return null; }
    if (!origin || !/^https?:/i.test(origin)) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${origin}/favicon.ico`, { signal: controller.signal, redirect: 'follow' });
      clearTimeout(timer);
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !/image\//i.test(type)) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 256 * 1024) return null;
      return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
    } catch { return null; }
  }

  async icon(p) {
    if (!p) return null;
    if (this.iconCache.has(p)) return this.iconCache.get(p);

    // UWP / AppX / PWA entries have no file to read an icon from; their logo
    // comes out of the package manifest.
    const appsFolder = /^shell:AppsFolder\\(.+)$/i.exec(p);
    if (appsFolder) {
      const url = await uwpIcon(appsFolder[1], this.uwpRoots).catch(() => null);
      if (this.iconCache.size > 2000) this.iconCache.clear();
      this.iconCache.set(p, url);
      return url;
    }
    if (/^(ms-settings|shell):/i.test(p)) return null;
    let url = null;
    for (const candidate of this.iconCandidates(p)) {
      try {
        const img = await app.getFileIcon(candidate, { size: 'large' });
        if (img && !img.isEmpty()) { url = img.toDataURL(); break; }
      } catch { /* missing file - try the next candidate */ }
    }
    // Internet shortcuts whose IconFile went nowhere get the real favicon;
    // the generic white-page-with-arrow icon helps nobody tell sites apart.
    if (path.extname(p).toLowerCase() === '.url') {
      const hadIconFile = this.iconCandidates(p).length > 1;
      if (!hadIconFile || !url) {
        const fav = await this.urlFavicon(p);
        if (fav) url = fav;
      }
    }
    if (this.iconCache.size > 2000) this.iconCache.clear();
    this.iconCache.set(p, url);
    return url;
  }

  // Details for the preview pane: shell thumbnail, size, dates, text snippet.
  async preview(item) {
    if (!item || !item.path) return null;
    if (/^shell:AppsFolder\\/i.test(item.path)) {
      return { path: item.path, uwp: true, aumid: item.aumid || item.path.slice('shell:AppsFolder\\'.length) };
    }
    if (/^(ms-settings|shell):/i.test(item.path)) return null;
    const out = { path: item.path };
    try {
      const st = await fs.stat(item.path);
      out.size = st.isFile() ? st.size : null;
      out.modified = st.mtimeMs;
      out.created = st.birthtimeMs;
      out.isDir = st.isDirectory();
      if (out.isDir) {
        const kids = await fs.readdir(item.path).catch(() => []);
        out.children = kids.length;
      }
    } catch {
      out.missing = true;
      return out;
    }
    if (!out.isDir) {
      try {
        const thumb = await nativeImage.createThumbnailFromPath(item.path, { width: 256, height: 256 });
        if (!thumb.isEmpty()) out.thumbnail = thumb.toDataURL();
      } catch { /* no thumbnail handler */ }
      const ext = path.extname(item.path).toLowerCase();
      if (TEXT_PREVIEW_EXTS.has(ext) && out.size < 5 * 1024 * 1024) {
        try {
          const fh = await fs.open(item.path, 'r');
          const buf = Buffer.alloc(1500);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          await fh.close();
          out.text = buf.subarray(0, bytesRead).toString('utf8');
        } catch { /* locked */ }
      }
    }
    return out;
  }

  registerIpc() {
    ipcMain.handle('spotlight:query', (_e, q) => this.query(q));
    ipcMain.handle('spotlight:icon', (_e, p) => this.icon(p));
    ipcMain.handle('spotlight:preview', (_e, item) => this.preview(item));
    ipcMain.handle('spotlight:reindex', () => this.reindex());
    ipcMain.handle('spotlight:info', () => ({ hotkey: this.hotkey, stats: this.index.stats }));
    ipcMain.on('spotlight:open', (_e, item) => this.open(item));
    ipcMain.on('spotlight:reveal', (_e, item) => this.reveal(item));
    ipcMain.on('spotlight:hide', () => this.hide());
    ipcMain.on('spotlight:show', (_e, q) => this.show(typeof q === 'string' ? q : ''));
    ipcMain.on('spotlight:copy', (_e, text) => { clipboard.writeText(String(text)); });
    // Web search. openExternal goes through ShellExecute, so the query lands
    // in whichever browser Windows has set as default.
    ipcMain.on('spotlight:web', (_e, q) => {
      this.hide();
      shell.openExternal(webSearchUrl(this.store.get('search').webEngine, q));
    });
    ipcMain.on('spotlight:clear-history', () => {
      // Assign directly: store.set deep-merges, which would keep old counts.
      this.store.get('search').launchCounts = {};
      this.store.save();
    });
  }

  destroy() {
    clearInterval(this.timer);
    if (this.hotkey) globalShortcut.unregister(this.hotkey);
  }
}

module.exports = { Spotlight, webSearchUrl, ENGINES };
