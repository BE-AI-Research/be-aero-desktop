// Copy and move jobs for the file browser, with progress, speed, time left,
// pause, resume and stop.
//
// A job copies (or moves) a set of files and folders into a folder:
//   this PC -> this PC          chunked copy (a move on the same drive is a rename)
//   another device -> this PC   downloaded over the mesh (remote-files.js)
//   the relay -> this PC        downloaded and decrypted (relay-drive.js)
//   this PC -> relay storage    encrypted and uploaded, a few files at a time
// Every route reports bytes as they move and checks for pause / stop
// between chunks. A stopped copy removes its half-written file; a move
// only removes a source once it has been copied in full.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const CHUNK = 1024 * 1024;
const SPEED_WINDOW_MS = 4000;

class Cancelled extends Error { constructor() { super('stopped'); this.cancelled = true; } }

function within(child, parent) {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

async function freeName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 0; ; i++) {
    const n = i === 0 ? name : `${base} (${i + 1})${ext}`;
    try { await fsp.access(path.join(dir, n)); } catch { return n; }
  }
}

class Transfers {
  // { remote: RemoteFiles (isRemote urls, download, put, writable), trash(path), onChange(list) }
  constructor({ remote = null, trash, onChange = () => {} }) {
    this.remote = remote;
    this.trash = trash;
    this.onChange = onChange;
    this.jobs = new Map();
    this.timer = null;
  }

  isRemote(p) { return /^aero:\/\//i.test(String(p || '')); }

  list() {
    return [...this.jobs.values()].map((j) => ({
      id: j.id, kind: j.kind, title: j.title, dest: j.dest, state: j.state, total: j.total, done: j.done,
      files: j.files, filesDone: j.filesDone, current: j.current, speed: j.speed, eta: j.eta,
      errors: j.errors.slice(-5), errorCount: j.errors.length, startedAt: j.startedAt, finishedAt: j.finishedAt || null
    }));
  }

  emit(now = false) {
    if (now) { clearTimeout(this.timer); this.timer = null; this.onChange(this.list()); return; }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.onChange(this.list()); }, 250);
  }

  // -> the job id. paths: files/folders (local or aero://), dest: a folder.
  start(paths, dest, { move = false } = {}) {
    const list = [].concat(paths || []).map(String).filter(Boolean);
    if (!list.length) throw new Error('nothing to copy');
    const id = crypto.randomBytes(5).toString('hex');
    const names = list.map((p) => decodeURIComponent(String(p).split(/[\\/]/).pop() || p));
    const j = {
      id, kind: move ? 'move' : 'copy', paths: list, dest: String(dest),
      title: `${move ? 'Moving' : 'Copying'} ${list.length === 1 ? `"${names[0]}"` : `${list.length} items`}`,
      state: 'running', total: 0, done: 0, files: 0, filesDone: 0, current: '', speed: 0, eta: null,
      errors: [], results: [], startedAt: Date.now(), samples: [], paused: null, cancelled: false
    };
    this.jobs.set(id, j);
    this.run(j).catch(() => {});
    this.emit(true);
    return id;
  }

  pause(id) { const j = this.jobs.get(id); if (j && j.state === 'running') { j.state = 'paused'; let release; j.paused = new Promise((r) => { release = r; }); j.release = release; this.emit(true); } return !!j; }
  resume(id) { const j = this.jobs.get(id); if (j && j.state === 'paused') { j.state = 'running'; const r = j.release; j.paused = null; j.release = null; j.samples = []; if (r) r(); this.emit(true); } return !!j; }
  cancel(id) { const j = this.jobs.get(id); if (j && (j.state === 'running' || j.state === 'paused')) { j.cancelled = true; j.state = 'stopping'; if (j.release) { j.release(); j.release = null; j.paused = null; } this.emit(true); } return !!j; }
  clear(id) { const j = this.jobs.get(id); if (j && !['running', 'paused', 'stopping'].includes(j.state)) this.jobs.delete(id); this.emit(true); return true; }

  // The control object every route uses.
  ctl(j) {
    const self = this;
    return {
      get cancelled() { return j.cancelled; },
      async check() { if (j.paused) await j.paused; if (j.cancelled) throw new Cancelled(); },
      onBytes(n) {
        j.done += n;
        const now = Date.now();
        j.samples.push([now, j.done]);
        while (j.samples.length > 2 && now - j.samples[0][0] > SPEED_WINDOW_MS) j.samples.shift();
        const [t0, d0] = j.samples[0];
        j.speed = now > t0 ? Math.round(((j.done - d0) / (now - t0)) * 1000) : 0;
        j.eta = j.speed > 0 && j.total > j.done ? Math.round((j.total - j.done) / j.speed) : null;
        self.emit();
      },
      addTotal(bytes, files = 0) { j.total += Math.max(0, bytes || 0); j.files += files; self.emit(); },
      fileStart(name) { j.current = name; self.emit(); },
      fileDone() { j.filesDone += 1; self.emit(); }
    };
  }

  async run(j) {
    const ctl = this.ctl(j);
    try {
      const destRemote = this.isRemote(j.dest);
      if (destRemote) {
        if (!this.remote || !this.remote.writable(j.dest)) throw new Error('That folder is read-only from here.');
        j.results = await this.remote.put(j.paths, j.dest, ctl);
        if (j.kind === 'move' && !j.cancelled) for (const p of j.paths) if (!this.isRemote(p)) await this.trash(p).catch((err) => j.errors.push(`${path.basename(p)}: copied, but not removed (${err.message})`));
      } else {
        const dest = path.resolve(j.dest);
        await fsp.mkdir(dest, { recursive: true });
        // Size everything local first, so the bar is right from the start.
        for (const p of j.paths) if (!this.isRemote(p)) await this.measure(path.resolve(p), ctl);
        for (const src of j.paths) {
          await ctl.check();
          if (this.isRemote(src)) {
            const name = decodeURIComponent(String(src).split('/').pop() || 'file');
            const target = path.join(dest, await freeName(dest, name));
            ctl.fileStart(name);
            j.results.push(await this.remote.download(src, target, ctl));
            ctl.fileDone();
            continue;
          }
          const from = path.resolve(src);
          if (within(dest, from)) throw new Error(`Cannot put "${path.basename(from)}" inside itself.`);
          if (path.dirname(from) === dest && j.kind === 'move') { j.results.push(from); continue; }
          const target = path.join(dest, await freeName(dest, path.basename(from)));
          if (j.kind === 'move') {
            // Same drive: a rename, at once.
            try {
              const size = await this.sizeOf(from);
              await fsp.rename(from, target);
              ctl.onBytes(size); j.filesDone += await this.countFiles(target);
              j.results.push(target);
              continue;
            } catch (err) { if (err.code !== 'EXDEV' && err.code !== 'EPERM') throw err; }
          }
          await this.copyTree(from, target, ctl, j);
          if (j.kind === 'move') await this.trash(from);
          j.results.push(target);
        }
      }
      j.state = j.cancelled ? 'stopped' : j.errors.length ? 'done-with-errors' : 'done';
    } catch (err) {
      if (err && err.cancelled) j.state = 'stopped';
      else { j.state = 'failed'; j.errors.push(String(err && err.message || err)); }
    }
    j.finishedAt = Date.now();
    j.current = '';
    j.speed = 0; j.eta = null;
    this.emit(true);
    // Finished jobs stay listed a while, then go.
    setTimeout(() => { if (this.jobs.get(j.id) === j && j.state !== 'failed' && j.state !== 'done-with-errors') { this.jobs.delete(j.id); this.emit(true); } }, 15000);
  }

  async measure(p, ctl) {
    const st = await fsp.lstat(p);
    if (st.isDirectory()) { for (const d of await fsp.readdir(p)) await this.measure(path.join(p, d), ctl); return; }
    if (st.isFile()) ctl.addTotal(st.size, 1);
  }

  async sizeOf(p) {
    const st = await fsp.lstat(p);
    if (!st.isDirectory()) return st.size;
    let n = 0;
    for (const d of await fsp.readdir(p)) n += await this.sizeOf(path.join(p, d));
    return n;
  }

  async countFiles(p) {
    const st = await fsp.lstat(p);
    if (!st.isDirectory()) return 1;
    let n = 0;
    for (const d of await fsp.readdir(p)) n += await this.countFiles(path.join(p, d));
    return n;
  }

  async copyTree(from, to, ctl, j) {
    const st = await fsp.lstat(from);
    if (st.isDirectory()) {
      await fsp.mkdir(to, { recursive: true });
      for (const d of await fsp.readdir(from)) {
        await ctl.check();
        try { await this.copyTree(path.join(from, d), path.join(to, d), ctl, j); } catch (err) {
          if (err && err.cancelled) throw err;
          j.errors.push(`${d}: ${err.message}`);
        }
      }
      return;
    }
    if (st.isSymbolicLink()) { try { await fsp.symlink(await fsp.readlink(from), to); } catch { /* links that cannot be made here are skipped */ } return; }
    if (!st.isFile()) return;
    ctl.fileStart(path.basename(from));
    const part = `${to}.part`;
    const src = await fsp.open(from, 'r');
    const dst = await fsp.open(part, 'w');
    try {
      const buf = Buffer.alloc(CHUNK);
      let off = 0;
      for (;;) {
        await ctl.check();
        const { bytesRead } = await src.read(buf, 0, CHUNK, off);
        if (!bytesRead) break;
        await dst.write(buf, 0, bytesRead, off);
        off += bytesRead;
        ctl.onBytes(bytesRead);
      }
    } catch (err) {
      await dst.close().catch(() => {});
      await src.close().catch(() => {});
      await fsp.rm(part, { force: true });
      throw err;
    }
    await dst.close();
    await src.close();
    await fsp.utimes(part, st.atime, st.mtime).catch(() => {});
    await fsp.rename(part, to);
    ctl.fileDone();
  }
}

module.exports = { Transfers, Cancelled };
