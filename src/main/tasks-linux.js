// Process-based dock source for Linux.
//
// Wayland will not let one application enumerate another's windows (no
// compositor API exists), but /proc shows which applications are RUNNING -
// the task manager's view, which is exactly what the user asked the dock to
// mirror. Processes are matched to .desktop entries, so tiles carry real
// application names and icons. Limitations owned openly: no window titles
// or counts, "focus" means re-activating the app (which raises the existing
// window for single-instance applications - the common case on GNOME), and
// close asks the process to terminate.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
      else if (e.base && !p.flatpak && !p.snap) {
        const procBase = (p.argv0 || p.comm || '').toLowerCase();
        // /proc comm is truncated to 15 chars; compare accordingly.
        hit = procBase === e.base
          || (e.base.length > 15 && p.comm && e.base.startsWith(p.comm.toLowerCase()));
      }
      if (hit) { pids.push(p.pid); taken.add(p.pid); }
    }
    for (const pid of pids) {
      out.push({ hwnd: pid, pid, title: e.name, exe: e.file });
    }
  }
  return out;
}

function parseDesktopFile(file, text) {
  const section = String(text).split(/\n\[/)[0];
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
    name, file, exec,
    base: execBase(exec),
    flatpakId: isFlatpak ? id : null,
    snapName: isSnap ? id : null,
    icon: get('Icon')
  };
}

class LinuxTasks {
  constructor() {
    this.entries = [];
    this.entriesAt = 0;
    this.lastList = [];
    this.iconCache = new Map();
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
        const argv0 = path.basename((cmdline.split('\0')[0] || ''));
        let cg = null;
        try { cg = containerId(fs.readFileSync(`/proc/${n}/cgroup`, 'utf8')); } catch { /* fine */ }
        procs.push({ pid, comm, argv0, flatpak: cg && cg.flatpak, snap: cg && cg.snap });
      } catch { /* process vanished */ }
    }
    return procs;
  }

  async list() {
    this.refreshEntries();
    this.lastList = matchProcesses(this.readProcesses(), this.entries);
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

  // 'focus' re-activates the application (single-instance apps raise their
  // window); 'close' asks the process to terminate. Window-level verbs do
  // not exist without a window list.
  action(name, pid) {
    const w = this.lastList.find((x) => x.pid === pid);
    if (!w) return false;
    if (name === 'focus') return this.launch(w.exe);
    if (name === 'close') { try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; } }
    return false;
  }

  // Icon for a .desktop entry: an absolute Icon= path, else the hicolor
  // theme and pixmaps directories. SVGs ship as data: urls - the renderer
  // may draw them, nativeImage cannot.
  icon(file) {
    if (this.iconCache.has(file)) return this.iconCache.get(file);
    const e = this.entryFor(file);
    let url = null;
    if (e && e.icon) {
      const candidates = [];
      if (e.icon.startsWith('/')) candidates.push(e.icon);
      else {
        for (const size of ['256x256', '128x128', '64x64', '48x48', 'scalable']) {
          candidates.push(`/usr/share/icons/hicolor/${size}/apps/${e.icon}.png`);
          candidates.push(`/usr/share/icons/hicolor/${size}/apps/${e.icon}.svg`);
        }
        candidates.push(`/usr/share/pixmaps/${e.icon}.png`, `/usr/share/pixmaps/${e.icon}.svg`);
        if (e.flatpakId) {
          for (const base of ['/var/lib/flatpak/exports/share/icons/hicolor', path.join(HOME, '.local/share/flatpak/exports/share/icons/hicolor')]) {
            for (const size of ['256x256', '128x128', '64x64', 'scalable']) {
              candidates.push(`${base}/${size}/apps/${e.icon}.png`);
              candidates.push(`${base}/${size}/apps/${e.icon}.svg`);
            }
          }
        }
      }
      for (const c of candidates) {
        try {
          const buf = fs.readFileSync(c);
          if (!buf.length || buf.length > 512 * 1024) continue;
          url = c.endsWith('.svg')
            ? `data:image/svg+xml;base64,${buf.toString('base64')}`
            : `data:image/png;base64,${buf.toString('base64')}`;
          break;
        } catch { /* next candidate */ }
      }
    }
    if (this.iconCache.size > 200) this.iconCache.clear();
    this.iconCache.set(file, url);
    return url;
  }
}

module.exports = { LinuxTasks, execBase, containerId, matchProcesses, parseDesktopFile };
