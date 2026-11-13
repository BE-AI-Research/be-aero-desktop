// File Pool sync over the mesh: every paired device that allows "File
// Pool" keeps the same folder contents.
//
// - An index of the pool (relative path -> size, mtime, SHA-256) is kept in
//   the app data folder. A watcher (and a rescan every minute) updates it.
// - When something changes, peers are told (pool.changed). They ask for
//   the manifest and pull what is new or newer, in 1 MB chunks, into a
//   temporary file; the hash is checked before the file is moved into
//   place, so a half-copied file never appears.
// - Deletes travel as tombstones and go to the Recycle Bin / Trash on the
//   other side. A file changed on both sides since they last agreed keeps
//   both: the other side's version arrives and the local one is kept as
//   "name (conflict DEVICE date).ext".
// - Every request is checked against the requester's "pool" permission by
//   the mesh, and every path is confined to the pool folder.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const CHUNK = 1024 * 1024;
const RESCAN_MS = 60 * 1000;
const PERIODIC_SYNC_MS = 2 * 60 * 1000;
const WATCH_DEBOUNCE_MS = 800;
const TMP_DIR = '.be-aero-sync';
const IGNORE = (rel) => {
  const base = path.basename(rel);
  return rel.split(/[\\/]/)[0] === TMP_DIR
    || /^~\$|^\.~lock\.|\.(tmp|part|partial|crdownload|swp)$/i.test(base)
    || /^(desktop\.ini|thumbs\.db|\.ds_store)$/i.test(base);
};
const toPosix = (rel) => rel.split(path.sep).join('/');

function within(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function walk(root, rel = '', out = []) {
  let dirents;
  try { dirents = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const d of dirents) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (IGNORE(r)) continue;
    if (d.isDirectory()) await walk(root, r, out);
    else if (d.isFile()) out.push(r);
  }
  return out;
}

class PoolSync {
  // { poolDir(), indexFile, deviceName(), trash(path), log, onChange(info) }
  // shared(): false when this device keeps its File Pool to itself (no syncing either way).
  constructor({ poolDir, indexFile, deviceName = () => 'another device', trash, log = () => {}, onChange = () => {}, shared = () => true }) {
    this.shared = shared;
    this.poolDir = poolDir;
    this.indexFile = indexFile;
    this.deviceName = deviceName;
    this.trash = trash || (async (p) => fsp.rm(p, { force: true }));
    this.log = log;
    this.onChange = onChange;
    this.index = new Map();     // rel -> { size, mtime, hash, deleted, t, synced }
    this.mesh = null;
    this.watcher = null;
    this.timers = [];
    this.scanning = null;
    this.syncing = new Map();   // peerId -> Promise
    this.again = new Set();     // peers to sync again after the current run
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (j && j.dir === path.resolve(this.poolDir())) this.index = new Map(Object.entries(j.entries || {}));
    } catch { /* first run */ }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
      const tmp = `${this.indexFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ dir: path.resolve(this.poolDir()), entries: Object.fromEntries(this.index) }));
      fs.renameSync(tmp, this.indexFile);
    } catch (err) { this.log(`pool index not saved: ${err.message}`); }
  }

  // ---- local changes
  // Compare the folder with the index; returns the paths that changed.
  scan() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const root = this.poolDir();
      await fsp.mkdir(root, { recursive: true });
      const files = await walk(root);
      const present = new Set(files);
      const changed = [];
      for (const rel of files) {
        let st;
        try { st = await fsp.stat(path.join(root, rel)); } catch { continue; }
        const cur = this.index.get(rel);
        if (cur && !cur.deleted && cur.size === st.size && Math.abs(cur.mtime - st.mtimeMs) < 2) continue;
        let hash;
        try { hash = await hashFile(path.join(root, rel)); } catch { continue; }       // busy: next scan
        if (cur && !cur.deleted && cur.hash === hash) { cur.mtime = st.mtimeMs; cur.size = st.size; continue; }
        this.index.set(rel, { size: st.size, mtime: st.mtimeMs, hash, deleted: false, t: Date.now(), synced: cur && cur.synced });
        changed.push(rel);
      }
      for (const [rel, e] of this.index) {
        if (!e.deleted && !present.has(rel)) { this.index.set(rel, { ...e, deleted: true, t: Date.now() }); changed.push(rel); }
      }
      if (changed.length) { this.save(); this.onChange({ local: true, changed }); }
      return changed;
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  manifest() {
    return [...this.index].map(([rel, e]) => ({ rel, size: e.size, mtime: e.mtime, hash: e.hash, deleted: !!e.deleted, t: e.t }));
  }

  // ---- serving a peer
  async read(rel, offset = 0, length = CHUNK) {
    const r = String(rel || '');
    const file = path.join(this.poolDir(), r);
    if (!within(this.poolDir(), file) || IGNORE(r)) throw new Error('not in the pool');
    const e = this.index.get(r);
    if (!e || e.deleted) throw new Error('no such file in the pool');
    const fh = await fsp.open(file, 'r');
    try {
      const len = Math.max(0, Math.min(CHUNK, Number(length) || CHUNK));
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, Math.max(0, Number(offset) || 0));
      return { data: buf.subarray(0, bytesRead).toString('base64'), eof: (Number(offset) || 0) + bytesRead >= e.size };
    } finally { await fh.close(); }
  }

  // ---- pulling from a peer
  async syncWith(peerId) {
    if (!this.mesh) return null;
    if (this.syncing.has(peerId)) { this.again.add(peerId); return this.syncing.get(peerId); }
    const run = this.pullFrom(peerId).catch((err) => { this.log(`pool sync with ${peerId.slice(0, 7)}: ${err.message}`); return null; })
      .finally(() => {
        this.syncing.delete(peerId);
        if (this.again.delete(peerId)) setTimeout(() => this.syncWith(peerId), 200);
      });
    this.syncing.set(peerId, run);
    return run;
  }

  async pullFrom(peerId) {
    await this.scan();                             // our own view first
    const remote = await this.mesh.request(peerId, 'pool.manifest', {}, 60000);
    const peer = this.mesh.peers.get(peerId);
    const peerName = (peer && (peer.label || peer.name)) || 'another device';
    const root = this.poolDir();
    const done = { received: [], deleted: [], conflicts: [] };
    for (const r of (remote && remote.entries) || []) {
      const rel = String(r.rel || '');
      const file = path.join(root, rel);
      if (!within(root, file) || IGNORE(rel)) continue;
      const local = this.index.get(rel);
      if (r.deleted) {
        // Their delete wins when the file they deleted is exactly our copy (a
        // tombstone keeps the deleted content's hash), or when we have not
        // changed ours since we last agreed. A copy edited here is kept.
        const sameContent = local && local.hash === r.hash;
        if (local && !local.deleted && (sameContent || local.synced === local.hash) && (sameContent || (r.t || 0) >= (local.t || 0))) {
          try { await this.trash(file); } catch { /* already gone */ }
          this.index.set(rel, { ...local, deleted: true, t: r.t || Date.now() });
          done.deleted.push(rel);
        }
        continue;
      }
      if (local && !local.deleted && local.hash === r.hash) {
        if (local.synced !== r.hash) { local.synced = r.hash; }
        continue;                                          // same content
      }
      if (local && local.deleted && (local.t || 0) > (r.mtime || 0)) continue;   // our delete is newer
      if (local && !local.deleted) {
        // Both have the file, different content.
        const localChanged = local.synced !== local.hash;
        if (localChanged && (local.mtime || 0) >= (r.mtime || 0)) continue;     // ours is newer: they will pull it
        if (localChanged) {
          // Changed on both sides: keep ours under a conflict name.
          const ext = path.extname(rel);
          const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
          const conflictRel = `${rel.slice(0, rel.length - ext.length)} (conflict ${this.deviceName()} ${stamp})${ext}`;
          try { await fsp.rename(file, path.join(root, conflictRel)); done.conflicts.push(conflictRel); } catch { /* keep going */ }
        }
      }
      if (await this.fetch(peerId, r, file)) {
        this.index.set(rel, { size: r.size, mtime: r.mtime, hash: r.hash, deleted: false, t: Date.now(), synced: r.hash });
        done.received.push(rel);
      }
    }
    if (done.received.length || done.deleted.length || done.conflicts.length) {
      this.save();
      this.onChange({ from: peerName, ...done });
      if (done.conflicts.length) await this.scan();        // the conflict copies are new files to share
    }
    return done;
  }

  async fetch(peerId, r, file) {
    const tmpDir = path.join(this.poolDir(), TMP_DIR);
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${crypto.randomBytes(6).toString('hex')}.part`);
    const h = crypto.createHash('sha256');
    const fh = await fsp.open(tmp, 'w');
    try {
      let offset = 0;
      for (;;) {
        const c = await this.mesh.request(peerId, 'pool.read', { rel: r.rel, offset, length: CHUNK }, 60000);
        const buf = Buffer.from(c.data || '', 'base64');
        if (buf.length) { await fh.write(buf, 0, buf.length, offset); h.update(buf); offset += buf.length; }
        if (c.eof || !buf.length) break;
      }
    } catch (err) {
      await fh.close().catch(() => {});
      await fsp.rm(tmp, { force: true });
      this.log(`pull ${r.rel}: ${err.message}`);
      return false;
    }
    await fh.close();
    if (h.digest('hex') !== r.hash) { await fsp.rm(tmp, { force: true }); this.log(`pull ${r.rel}: content changed while copying; will retry`); return false; }
    const when = new Date(r.mtime || Date.now());
    await fsp.utimes(tmp, when, when);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.rename(tmp, file);
    return true;
  }

  // ---- wiring
  attach(mesh) {
    this.mesh = mesh;
    const off = () => { if (!this.shared()) throw new Error('this device does not share its File Pool'); };
    mesh.handle('pool.manifest', 'pool', async () => { off(); await this.scan(); return { entries: this.manifest() }; });
    mesh.handle('pool.read', 'pool', async (a) => { off(); return this.read(a.rel, a.offset, a.length); });
    mesh.handle('pool.changed', 'pool', async (_a, from) => { off(); setTimeout(() => this.syncWith(from.id), 300); return { ok: true }; });
    mesh.on('online', (id) => { if (this.allowed(id)) setTimeout(() => this.syncWith(id), 1000); });
  }

  allowed(peerId) {
    if (!this.shared()) return false;
    const p = this.mesh && this.mesh.peers.get(peerId);
    return !!(p && p.perms && p.perms.pool);
  }

  // Tell every online peer that may share the pool that something changed.
  announce() {
    if (!this.mesh) return;
    for (const id of this.mesh.conns.keys()) {
      if (this.allowed(id)) this.mesh.request(id, 'pool.changed', {}, 15000).catch(() => {});
    }
  }

  start() {
    const root = this.poolDir();
    fs.mkdirSync(root, { recursive: true });
    const kick = () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(async () => { const ch = await this.scan(); if (ch.length) this.announce(); }, WATCH_DEBOUNCE_MS);
    };
    try { this.watcher = fs.watch(root, { recursive: true }, (_ev, name) => { if (!name || !IGNORE(toPosix(String(name)))) kick(); }); } catch (err) { this.log(`pool watch: ${err.message} (rescans only)`); }
    this.timers.push(setInterval(kick, RESCAN_MS));
    this.timers.push(setInterval(() => { if (this.mesh) for (const id of this.mesh.conns.keys()) if (this.allowed(id)) this.syncWith(id); }, PERIODIC_SYNC_MS));
    kick();
  }

  stop() {
    if (this.watcher) { try { this.watcher.close(); } catch { /* closed */ } this.watcher = null; }
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.debounce);
  }
}

module.exports = { PoolSync, IGNORE, hashFile };
