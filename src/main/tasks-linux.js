// Dock source for Linux: three tiers, best available wins.
//
// 1. GNOME Shell helper. Wayland lets no application enumerate another's
//    windows, but the compositor can: the small extension shipped in
//    resources/gnome-extension exports org.beaero.Dock on the session bus
//    (list, activate, minimize, close, with focus and minimized state).
// 2. X11 session: wmctrl + xprop give the same picture for every window.
// 3. /proc: which applications are RUNNING (the task manager's view), matched
//    to .desktop entries. No titles or window state; "focus" re-activates the
//    app (single-instance apps raise their window) and close sends SIGTERM.
//
// Every tier reports TaskWindows' shape: {hwnd, pid, title, exe, min, fg, app}
// where exe is the .desktop file (icons and grouping) and app the real name.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const EXT_UUID = 'be-aero-dock@be-ai-research';
const BUS = ['--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/beaero/Dock'];
const PROBE_MS = 30 * 1000;   // how long a failed tier stays benched

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

// gdbus prints a GVariant tuple: ('<base64 json>',). The helper base64-encodes
// its JSON so titles with quotes or escapes never meet gdbus's own quoting.
function parseGdbusB64(out) {
  const m = /\(\s*'([A-Za-z0-9+/=]*)'\s*,?\s*\)/.exec(String(out || '').trim());
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); } catch { return null; }
}

// One line of `wmctrl -lpx`: id, desktop, pid, WM_CLASS, host, title.
function parseWmctrl(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const wmClass = m[4] === 'N/A' ? '' : m[4];
    out.push({ id: parseInt(m[1], 16), desktop: Number(m[2]), pid: Number(m[3]), wmClass, title: m[6].trim() });
  }
  return out;
}

const HOME = require('os').homedir();
const APP_ROOTS = [
  path.join(HOME, '.local', 'share', 'applications'),
  path.join(HOME, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
  '/usr/local/share/applications',
  '/usr/share/applications',
  '/var/lib/flatpak/exports/share/applications',
  '/var/lib/snapd/desktop/applications'
];
const DESKTOP_CACHE_MS = 5 * 60 * 1000;

// ------------------------------------------------------------ icon themes
// Icons live in themes: <data dir>/icons/<theme>/<size>/<category>/<name>.
// An index of every icon file in the themes that matter (the current one,
// Adwaita, hicolor) is built once per session; per name it keeps the best
// file - scalable SVG first, then the largest PNG up to 256 px.
const ICON_DATA_DIRS = () => {
  const xdg = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [path.join(HOME, '.local', 'share'), ...xdg, '/var/lib/flatpak/exports/share', path.join(HOME, '.local', 'share', 'flatpak', 'exports', 'share')];
};
function currentIconTheme() {
  try {
    const out = require('child_process').execFileSync('gsettings', ['get', 'org.gnome.desktop.interface', 'icon-theme'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().replace(/^'|'$/g, '') || null;
  } catch { return null; }
}
// "256x256" -> 256, "scalable" -> Infinity (preferred), "32x32@2" -> 64.
function sizeRank(dir) {
  if (/scalable/i.test(dir)) return 1e6;
  const m = /(\d+)x\d+(?:@(\d+))?/.exec(dir);
  if (!m) return 0;
  const px = Number(m[1]) * (Number(m[2]) || 1);
  return px > 256 ? 256 - (px - 256) / 1000 : px;          // over 256: allowed, just below 256
}
function buildIconIndex(themes, dataDirs, fsImpl = fs) {
  const best = new Map();                                     // name -> { file, rank }
  const consider = (name, file, rank) => {
    const cur = best.get(name);
    if (!cur || rank > cur.rank) best.set(name, { file, rank });
  };
  for (const theme of themes) {
    for (const d of dataDirs) {
      const root = path.join(d, 'icons', theme);
      let sizes;
      try { sizes = fsImpl.readdirSync(root); } catch { continue; }
      for (const size of sizes) {
        let cats;
        try { cats = fsImpl.readdirSync(path.join(root, size)); } catch { continue; }
        for (const cat of cats) {
          let files;
          try { files = fsImpl.readdirSync(path.join(root, size, cat)); } catch { continue; }
          for (const f of files) {
            const m = /^(.+)\.(svg|png)$/i.exec(f);
            if (!m || /-symbolic$/.test(m[1])) continue;
            // Earlier themes win ties: + a small bonus per theme position.
            consider(m[1], path.join(root, size, cat, f), sizeRank(size) + (m[2].toLowerCase() === 'svg' ? 0.5 : 0) + (themes.length - themes.indexOf(theme)) * 0.001);
          }
        }
      }
    }
  }
  return best;
}
const SELF = /^be-aero-desktop/i;

// First real command word of an Exec= line: wrappers (env, VAR=x) and field
// codes (%u, %F, ...) stripped, basename, lowercased. 'flatpak' and 'snap'
// launches are matched through cgroups instead, so they return null here.
function execBase(execLine) {
  // Tokenize respecting double quotes: Exec='"/opt/My App/app" --flag'.
  const words = String(execLine || '').trim().match(/"[^"]*"|\S+/g) || [];
  for (const w of words) {
    const bare = w.replace(/^"+|"+$/g, '');
    if (!bare || bare === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(bare)) continue;
    const base = path.basename(bare).toLowerCase();
    if (base === 'flatpak' || base === 'snap' || base === 'sh' || base === 'bash') return null;
    return base;
  }
  return null;
}

// The flatpak app id of a process, from its cgroup (app-flatpak-<id>-<pid>),
// or null. Snaps show up as snap.<name>.<command> the same way.
function containerId(cgroupText) {
  const fm = /app-flatpak-([\w.]+)-\d+/.exec(String(cgroupText || ''));
  if (fm) return { flatpak: fm[1] };
  const sm = /snap\.([\w-]+)\./.exec(String(cgroupText || ''));
  if (sm) return { snap: sm[1] };
  return null;
}

// Match running processes to desktop entries. Pure, testable.
// procs: [{pid, comm, argv0, flatpak, snap}], entries: [{name, file, exec, flatpakId, snapName}]
// Folders too general to identify an app by: a program in /usr/bin is not
// "the same app" as every other program there.
const SHARED_DIRS = /^\/(usr\/(local\/)?(s?bin|lib(exec|64)?(\/[^/]+)?|share)|s?bin|lib(64)?|opt)$/;

// Running processes -> one dock entry per app. A process belongs to an app
// when it runs from a Flatpak / Snap container of that app, has the app's
// command name, or runs from the app's own install folder - the last one
// catches wrapper launchers (google-chrome-stable -> /opt/google/chrome/
// google-chrome, a script, -> /opt/google/chrome/chrome). An app's many
// processes (browsers run dozens) are one tile: its oldest process.
function matchProcesses(procs, entries) {
  const out = [];
  const taken = new Set();
  for (const e of entries) {
    const pids = [];
    for (const p of procs) {
      if (taken.has(p.pid)) continue;
      let hit = false;
      if (e.flatpakId && p.flatpak) hit = p.flatpak === e.flatpakId;
      else if (e.snapName && p.snap) hit = p.snap === e.snapName;
      else if (e.webAppId) hit = !!p.args && p.args.includes(`--app-id=${e.webAppId}`);   // a browser web app: only its own processes
      else if (e.base && !p.flatpak && !p.snap) {
        if (p.webApp) continue;                                       // belongs to a web app shortcut, not the browser
        const procBase = (p.argv0 || p.comm || '').toLowerCase();
        // /proc comm is truncated to 15 chars; compare accordingly.
        hit = procBase === e.base
          || (e.base.length > 15 && p.comm && e.base.startsWith(p.comm.toLowerCase()))
          || (!!e.binDir && !!p.dir && (p.dir === e.binDir || p.dir.startsWith(`${e.binDir}/`)));
      }
      if (hit) { pids.push(p.pid); taken.add(p.pid); }
    }
    if (pids.length) {
      const pid = Math.min(...pids);
      out.push({ hwnd: pid, pid, title: e.name, exe: e.file, processes: pids.length });
    }
  }
  return out;
}

// An Exec= command's real install folder (symlinks followed), or '' when it
// is a shared system folder (see SHARED_DIRS).
function execDir(exec, which = whichSync) {
  const words = String(exec || '').replace(/%[a-zA-Z]/g, '').trim().split(/\s+/);
  let i = 0;
  if (words[i] === 'env') { i++; while (words[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++; }
  const cmd = words[i];
  if (!cmd || /^(flatpak|snap|sh|bash|python3?|java|gio)$/.test(path.basename(cmd))) return '';
  let full = cmd.startsWith('/') ? cmd : which(cmd);
  if (!full) return '';
  try { full = fs.realpathSync(full); } catch { return ''; }
  const dir = path.dirname(full);
  return SHARED_DIRS.test(dir) ? '' : dir;
}

function whichSync(cmd) {
  for (const d of String(process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':')) {
    const f = path.join(d, cmd);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return '';
}

function parseDesktopFile(file, text) {
  // The [Desktop Entry] group, wherever it starts: many files open with
  // comment lines (LibreOffice, vim, xterm), and taking "everything before
  // the first [" read only those comments - the whole app was dropped.
  const t = String(text);
  const start = t.search(/^\[Desktop Entry\][ \t]*$/m);
  if (start < 0) return null;
  const body = t.slice(t.indexOf('\n', start) + 1);
  const next = body.search(/^\[/m);
  const section = next < 0 ? body : body.slice(0, next);
  const get = (k) => {
    const m = new RegExp('^' + k + '=(.*)$', 'm').exec(section);
    return m ? m[1].trim() : '';
  };
  if (/^true$/i.test(get('NoDisplay')) || /^true$/i.test(get('Hidden'))) return null;
  const type = get('Type');
  if (type && type !== 'Application') return null;
  const name = get('Name');
  const exec = get('Exec');
  if (!name || !exec) return null;
  const id = path.basename(file, '.desktop');
  const isFlatpak = /(^|\/)flatpak(\s|$)/.test(exec.split(/\s+/)[0]) || /\bflatpak run\b/.test(exec);
  const isSnap = /^\/snap\/|\bsnap run\b/.test(exec);
  return {
    name, file, exec, id,
    base: execBase(exec),
    flatpakId: isFlatpak ? id : null,
    snapName: isSnap ? id : null,
    wmClass: get('StartupWMClass'),
    icon: get('Icon'),
    binDir: isFlatpak || isSnap ? '' : execDir(exec),
    // Chrome / Edge / Brave web-app shortcuts run the browser with --app-id.
    webAppId: (/--app-id=([A-Za-z0-9_-]+)/.exec(exec) || [])[1] || ''
  };
}

// Resolve a compositor-reported window to a desktop entry: by desktop id
// (what GNOME's window tracker hands back), then StartupWMClass, then the
// WM_CLASS against the entry id or its command, then the owning process.
function entryForWindow(win, entries, procs) {
  const appId = String(win.app || '').replace(/\.desktop$/i, '').toLowerCase();
  const cls = String(win.wmClass || '').split('.').pop().toLowerCase();
  const clsAll = String(win.wmClass || '').toLowerCase().split('.');
  if (appId) {
    const e = entries.find((x) => x.id.toLowerCase() === appId);
    if (e) return e;
  }
  if (cls) {
    const byClass = entries.find((x) => x.wmClass && x.wmClass.toLowerCase() === cls)
      || entries.find((x) => x.id.toLowerCase() === cls || clsAll.includes(x.id.toLowerCase()))
      || entries.find((x) => x.base && (x.base === cls || clsAll.includes(x.base)));
    if (byClass) return byClass;
  }
  if (win.pid && procs) {
    const p = procs.find((x) => x.pid === win.pid);
    if (p) {
      const hit = matchProcesses([p], entries)[0];
      if (hit) return entries.find((x) => x.file === hit.exe) || null;
    }
  }
  return null;
}

class LinuxTasks {
  constructor() {
    this.entries = [];
    this.entriesAt = 0;
    this.lastList = [];
    this.iconCache = new Map();
    this.source = 'proc';          // 'shell' | 'x11' | 'proc'
    this.benched = { shell: 0, x11: 0 };
    this.procsAt = 0;
    this.procs = [];
  }

  // The window source in use and whether the GNOME helper could be installed.
  status() {
    const gnome = /gnome/i.test(process.env.XDG_CURRENT_DESKTOP || '') || /gnome/i.test(process.env.DESKTOP_SESSION || '');
    const wayland = (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' || !!process.env.WAYLAND_DISPLAY;
    return { source: this.source, gnome, wayland, helperUuid: EXT_UUID, helperInstalled: fs.existsSync(path.join(os.homedir(), '.local/share/gnome-shell/extensions', EXT_UUID)) || fs.existsSync(path.join('/usr/share/gnome-shell/extensions', EXT_UUID)) };
  }

  // Copy the shipped extension into the user's extensions directory and ask
  // GNOME to enable it. On Wayland the shell loads it at the next login.
  async installHelper(fromDir) {
    const dest = path.join(os.homedir(), '.local/share/gnome-shell/extensions', EXT_UUID);
    try {
      fs.mkdirSync(dest, { recursive: true });
      for (const f of fs.readdirSync(fromDir)) fs.copyFileSync(path.join(fromDir, f), path.join(dest, f));
    } catch (err) { return { ok: false, error: err.message }; }
    const enabled = await run('gnome-extensions', ['enable', EXT_UUID], 5000);
    this.benched.shell = 0;
    return { ok: true, enabled: enabled !== null, dest };
  }

  cachedProcs() {
    if (Date.now() - this.procsAt > 5000) { this.procs = this.readProcesses(); this.procsAt = Date.now(); }
    return this.procs;
  }

  toWindow(w, e) {
    return {
      hwnd: w.id, pid: w.pid, title: w.title || (e ? e.name : w.wmClass || 'Window'),
      exe: e ? e.file : `${String(w.wmClass || 'app').split('.').pop().toLowerCase()}.desktop`,
      app: e ? e.name : (String(w.wmClass || '').split('.').pop() || 'App'),
      min: !!w.minimized, fg: !!w.focused
    };
  }

  // Tier 1: the GNOME Shell helper.
  async listShell() {
    if (Date.now() < this.benched.shell) return null;
    const out = await run('gdbus', ['call', ...BUS, '--method', 'org.beaero.Dock.List']);
    const list = out && parseGdbusB64(out);
    if (!Array.isArray(list)) { this.benched.shell = Date.now() + PROBE_MS; return null; }
    const procs = this.cachedProcs();
    return list.filter((w) => w && !SELF.test(String(w.wmClass || '')) && w.pid !== process.pid)
      .map((w) => this.toWindow(w, entryForWindow(w, this.entries, procs)));
  }

  // Tier 2: an X11 session with wmctrl (+ xprop for state/focus).
  async listX11() {
    if (Date.now() < this.benched.x11) return null;
    if (!process.env.DISPLAY || (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland') return null;
    const out = await run('wmctrl', ['-lpx']);
    if (out === null) { this.benched.x11 = Date.now() + PROBE_MS; return null; }
    const wins = parseWmctrl(out).filter((w) => w.pid !== process.pid && !SELF.test(w.wmClass));
    const active = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
    const am = /0x[0-9a-fA-F]+/.exec(active || '');
    const activeId = am ? parseInt(am[0], 16) : -1;
    const states = await Promise.all(wins.map((w) => run('xprop', ['-id', `0x${w.id.toString(16)}`, '_NET_WM_STATE', '_NET_WM_WINDOW_TYPE'], 2000)));
    const procs = this.cachedProcs();
    const list = [];
    wins.forEach((w, i) => {
      const st = states[i] || '';
      if (/_NET_WM_WINDOW_TYPE_(DOCK|DESKTOP|TOOLBAR|MENU|SPLASH|NOTIFICATION|TOOLTIP)/.test(st)) return;
      if (/_NET_WM_STATE_SKIP_TASKBAR/.test(st)) return;
      list.push(this.toWindow({ ...w, minimized: /_NET_WM_STATE_HIDDEN/.test(st), focused: w.id === activeId }, entryForWindow(w, this.entries, procs)));
    });
    return list;
  }

  refreshEntries() {
    if (Date.now() - this.entriesAt < DESKTOP_CACHE_MS) return;
    const entries = [];
    const seen = new Set();
    for (const root of APP_ROOTS) {
      let names;
      try { names = fs.readdirSync(root); } catch { continue; }
      for (const f of names) {
        if (!f.endsWith('.desktop') || seen.has(f) || SELF.test(f)) continue;
        try {
          const e = parseDesktopFile(path.join(root, f), fs.readFileSync(path.join(root, f), 'utf8'));
          if (e) { entries.push(e); seen.add(f); }
        } catch { /* unreadable */ }
      }
    }
    this.entries = entries;
    this.entriesAt = Date.now();
  }

  readProcesses() {
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    const procs = [];
    let pids;
    try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return procs; }
    for (const n of pids) {
      const pid = Number(n);
      if (pid === process.pid) continue;
      try {
        if (uid >= 0 && fs.statSync(`/proc/${n}`).uid !== uid) continue;
        const comm = fs.readFileSync(`/proc/${n}/comm`, 'utf8').trim();
        const cmdline = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8');
        const arg0 = cmdline.split('\0')[0] || '';
        const argv0 = path.basename(arg0);
        const dir = arg0.startsWith('/') ? path.dirname(arg0) : '';
        let cg = null;
        try { cg = containerId(fs.readFileSync(`/proc/${n}/cgroup`, 'utf8')); } catch { /* fine */ }
        const args = cmdline.split(' ').join(' ');
        procs.push({ pid, comm, argv0, dir, args, webApp: /--app-id=/.test(args), flatpak: cg && cg.flatpak, snap: cg && cg.snap });
      } catch { /* process vanished */ }
    }
    return procs;
  }

  async list() {
    // The dock polls every couple of seconds; a /proc walk is cheap but there
    // is no reason to repeat it faster than applications come and go.
    if (this.listAt && Date.now() - this.listAt < 1200) return this.lastList;
    this.refreshEntries();
    let list = await this.listShell();
    let source = 'shell';
    if (!list) { list = await this.listX11(); source = 'x11'; }
    if (!list) {
      source = 'proc';
      list = matchProcesses(this.readProcesses(), this.entries).map((w) => ({ ...w, app: w.title, min: false, fg: false }));
    }
    this.source = source;
    this.lastList = list;
    this.listAt = Date.now();
    return this.lastList;
  }

  entryFor(file) {
    this.refreshEntries();
    return this.entries.find((e) => e.file === file) || null;
  }

  launch(file) {
    const e = this.entryFor(file);
    if (!e) return false;
    const child = spawn('gio', ['launch', e.file], { detached: true, stdio: 'ignore' });
    child.once('error', () => {
      const cmd = e.exec.replace(/%[fFuUdDnNickvm]/g, '').trim();
      if (cmd) spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' }).unref();
    });
    child.unref();
    return true;
  }

  // Window verbs. With a real window source (shell helper, X11) they act on
  // the window; on the /proc tier 'activate' re-launches the application
  // (single-instance apps raise their window) and 'close' sends SIGTERM.
  async action(name, id) {
    const w = this.lastList.find((x) => x.hwnd === id) || this.lastList.find((x) => x.pid === id);
    if (!w) return false;
    const verb = name === 'focus' || name === 'restore' ? 'activate' : name;
    if (this.source === 'shell') {
      const method = { activate: 'Activate', minimize: 'Minimize', close: 'Close', maximize: 'Activate' }[verb];
      if (!method) return false;
      const out = await run('gdbus', ['call', ...BUS, '--method', `org.beaero.Dock.${method}`, String(w.hwnd)]);
      this.listAt = 0;
      return out !== null && /true/.test(out);
    }
    if (this.source === 'x11') {
      const hex = `0x${Number(w.hwnd).toString(16)}`;
      let out = null;
      if (verb === 'activate' || verb === 'maximize') out = await run('wmctrl', ['-ia', hex]);
      else if (verb === 'minimize') {
        out = await run('xdotool', ['windowminimize', hex]);
        if (out === null) out = await run('wmctrl', ['-ir', hex, '-b', 'add,hidden']);
      } else if (verb === 'close') out = await run('wmctrl', ['-ic', hex]);
      this.listAt = 0;
      return out !== null;
    }
    if (verb === 'activate') return this.launch(w.exe);
    if (verb === 'close') { try { process.kill(w.pid, 'SIGTERM'); return true; } catch { return false; } }
    return false;
  }

  // Icon for a .desktop entry: an absolute Icon= path, else the hicolor
  // theme and pixmaps directories. SVGs ship as data: urls - the renderer
  // may draw them, nativeImage cannot.
  // The icon theme index, built on first use (a few thousand files).
  themeIndex() {
    if (!this.iconIndex) {
      const themes = [...new Set([currentIconTheme(), 'Adwaita', 'hicolor'].filter(Boolean))];
      this.iconIndex = buildIconIndex(themes, ICON_DATA_DIRS());
    }
    return this.iconIndex;
  }

  // An Icon= value -> a file: an absolute path, a themed name (with or
  // without an extension), /usr/share/pixmaps; else the theme's generic
  // application icon rather than nothing.
  iconFile(iconName) {
    const name = String(iconName || '').trim();
    if (!name) return null;
    if (name.startsWith('/')) { try { if (fs.statSync(name).isFile()) return name; } catch { /* missing */ } }
    const bare = path.basename(name).replace(/\.(png|svg|xpm)$/i, '');
    const idx = this.themeIndex();
    if (idx.has(bare)) return idx.get(bare).file;
    for (const ext of ['png', 'svg']) {
      const p = `/usr/share/pixmaps/${bare}.${ext}`;
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
    return null;
  }

  icon(file) {
    if (this.iconCache.has(file)) return this.iconCache.get(file);
    const e = this.entryFor(file);
    let url = null;
    const idx = this.themeIndex();
    const generic = idx.get('application-x-executable') || idx.get('applications-other');
    for (const f of [e && this.iconFile(e.icon), generic && generic.file].filter(Boolean)) {
      try {
        const buf = fs.readFileSync(f);
        if (!buf.length || buf.length > 2 * 1024 * 1024) continue;
        url = f.toLowerCase().endsWith('.svg')
          ? `data:image/svg+xml;base64,${buf.toString('base64')}`
          : `data:image/png;base64,${buf.toString('base64')}`;
        break;
      } catch { /* next */ }
    }
    if (this.iconCache.size > 200) this.iconCache.clear();
    this.iconCache.set(file, url);
    return url;
  }
}

module.exports = { LinuxTasks, execBase, execDir, containerId, matchProcesses, parseDesktopFile, parseWmctrl, parseGdbusB64, entryForWindow, EXT_UUID, buildIconIndex, sizeRank };
