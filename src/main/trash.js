// Recycle Bin / Trash for the dock tile: is it empty, open it, empty it.
//
// Windows: the count comes from SHQueryRecycleBin through the dock's
// PowerShell worker (tasks.js 'bin'); emptying runs Clear-RecycleBin in its
// own process (it can take a while and must not hold up the dock).
// Linux: the freedesktop.org trash in ~/.local/share/Trash (gio for the rest).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const POLL_MS = 15000;

function linuxTrashDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'Trash');
}

function run(cmd, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err) => resolve(!err));
  });
}

class Trash {
  // { tw (TaskWindows, Windows), onChange(state) }
  constructor({ tw = null, onChange = () => {} } = {}) {
    this.tw = tw;
    this.onChange = onChange;
    this.count = null;
    this.timer = null;
  }

  async query() {
    if (process.platform === 'win32') {
      if (!this.tw) return null;
      const line = await this.tw.send('bin');
      try { const r = JSON.parse(line); return Number(r.items) || 0; } catch { return null; }
    }
    try { return fs.readdirSync(path.join(linuxTrashDir(), 'files')).length; } catch { return 0; }
  }

  async refresh() {
    const n = await this.query();
    if (n !== null && n !== this.count) { this.count = n; this.onChange(this.state()); }
    return this.state();
  }

  state() { return { supported: true, count: this.count, empty: this.count === 0 }; }

  start() {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  open() {
    if (process.platform === 'win32') {
      spawn('explorer.exe', ['shell:RecycleBinFolder'], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    for (const [cmd, args] of [['gio', ['open', 'trash:///']], ['xdg-open', ['trash:///']]]) {
      try {
        const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        p.on('error', () => {});
        p.unref();
        return true;
      } catch { /* try the next */ }
    }
    return false;
  }

  async empty() {
    let ok;
    if (process.platform === 'win32') {
      ok = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Clear-RecycleBin -Force -ErrorAction SilentlyContinue']);
    } else {
      ok = await run('gio', ['trash', '--empty']);
      if (!ok) {
        // No gio: empty the freedesktop trash by hand (its two folders).
        const dir = linuxTrashDir();
        for (const sub of ['files', 'info', 'expunged']) {
          try {
            for (const n of fs.readdirSync(path.join(dir, sub))) fs.rmSync(path.join(dir, sub, n), { recursive: true, force: true });
            ok = true;
          } catch { /* not there */ }
        }
      }
    }
    await this.refresh();
    return ok;
  }
}

module.exports = { Trash };
