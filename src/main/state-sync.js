// State sync over the mesh: small pieces of app state (notes, theme, pins,
// synced conversations, tasks, web widgets) kept the same on every paired
// device that allows "Synced state".
//
// Each item has a key ("scratchpad", "conv:abc", ...). The engine keeps, per
// key, the content hash and the time it last changed here (or the time of
// the remote change we applied). Devices compare manifests and fetch what is
// newer; the newest change wins (last writer wins per item). An item that
// disappears becomes a tombstone, so deletes travel too. Applying a remote
// value records its hash and time, so it is never sent back (no echo).
//
// What the items are, and how to read and write them, comes from adapters:
//   collect() -> Map(key -> value)          (only what should sync, now)
//   apply(key, value, from)                 (write a remote value here)
//   remove(key, from)                       (a remote delete)
const fs = require('fs');
const crypto = require('crypto');

const MAX_ITEM = 8 * 1024 * 1024;
const SCAN_MS = 15 * 1000;
const PERIODIC_MS = 2 * 60 * 1000;

const hashOf = (v) => crypto.createHash('sha256').update(JSON.stringify(v === undefined ? null : v)).digest('hex');

class StateSync {
  // { indexFile, collect(), apply(key, value, from), remove(key, from), tracked(key), log, onApplied(keys, from) }
  // tracked(key): false for an item that has stopped syncing (its category
  // turned off, a conversation moved to Local) - it is forgotten here, never
  // sent out as a delete, and remote copies of it are ignored.
  constructor({ indexFile, collect, apply, remove, tracked = () => true, log = () => {}, onApplied = () => {} }) {
    this.tracked = tracked;
    this.indexFile = indexFile;
    this.collect = collect;
    this.applyItem = apply;
    this.removeItem = remove;
    this.log = log;
    this.onApplied = onApplied;
    this.index = new Map();      // key -> { hash, t, deleted }
    this.cache = new Map();      // key -> value (from the last scan)
    this.mesh = null;
    this.timers = [];
    this.pulling = new Map();
    this.again = new Set();
    try { this.index = new Map(Object.entries(JSON.parse(fs.readFileSync(indexFile, 'utf8')))); } catch { /* first run */ }
  }

  save() {
    try {
      const tmp = `${this.indexFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.index)));
      fs.renameSync(tmp, this.indexFile);
    } catch (err) { this.log(`state index not saved: ${err.message}`); }
  }

  // Compare what is here now with the index; returns the keys that changed.
  scan() {
    let items;
    try { items = this.collect(); } catch (err) { this.log(`collect: ${err.message}`); this.ready = false; return []; }
    this.ready = true;
    const changed = [];
    const now = Date.now();
    this.cache = items;
    for (const [key, value] of items) {
      const h = hashOf(value);
      const cur = this.index.get(key);
      if (cur && !cur.deleted && cur.hash === h) continue;
      this.index.set(key, { hash: h, t: now, deleted: false });
      changed.push(key);
    }
    for (const [key, e] of [...this.index]) {
      if (items.has(key)) continue;
      if (!this.tracked(key)) { this.index.delete(key); continue; }        // stopped syncing: forget, do not delete elsewhere
      if (!e.deleted) { this.index.set(key, { ...e, deleted: true, t: now }); changed.push(key); }
    }
    if (changed.length) this.save();
    return changed;
  }

  manifest() {
    this.scan();
    if (!this.ready) throw new Error('not ready yet');
    return Object.fromEntries(this.index);
  }

  async pullFrom(peerId) {
    if (!this.mesh) return null;
    const peer = this.mesh.peers.get(peerId);
    const from = (peer && (peer.label || peer.name)) || 'another device';
    this.scan();
    if (!this.ready) return null;                                      // cannot read what is here yet: try later
    const remote = await this.mesh.request(peerId, 'state.manifest', {}, 30000);
    const want = [];
    const removed = [];
    for (const [key, r] of Object.entries(remote.index || {})) {
      if (!this.tracked(key)) continue;                                  // not syncing here
      const local = this.index.get(key);
      if (local && local.hash === r.hash && !!local.deleted === !!r.deleted) continue;
      if (local && (local.t || 0) >= (r.t || 0)) continue;            // ours is newer (or the same moment)
      if (r.deleted) {
        if (local && !local.deleted) {
          try { this.removeItem(key, from); } catch (err) { this.log(`remove ${key}: ${err.message}`); continue; }
          this.index.set(key, { hash: local.hash, t: r.t, deleted: true });
          removed.push(key);
        }
        continue;
      }
      want.push(key);
    }
    const applied = [];
    for (let i = 0; i < want.length; i += 20) {
      const keys = want.slice(i, i + 20);
      const res = await this.mesh.request(peerId, 'state.get', { keys }, 60000);
      for (const key of keys) {
        const item = res.items && res.items[key];
        if (!item) continue;
        try { this.applyItem(key, item.value, from); } catch (err) { this.log(`apply ${key}: ${err.message}`); continue; }
        this.index.set(key, { hash: hashOf(item.value), t: item.t, deleted: false });
        applied.push(key);
      }
    }
    if (applied.length || removed.length) {
      this.save();
      // Re-read so the cache matches what is now here.
      try { this.cache = this.collect(); } catch { /* next scan */ }
      this.onApplied([...applied, ...removed], from);
    }
    return { applied, removed };
  }

  sync(peerId) {
    if (this.pulling.has(peerId)) { this.again.add(peerId); return this.pulling.get(peerId); }
    const p = this.pullFrom(peerId).catch((err) => { this.log(`state sync: ${err.message}`); return null; })
      .finally(() => { this.pulling.delete(peerId); if (this.again.delete(peerId)) setTimeout(() => this.sync(peerId), 200); });
    this.pulling.set(peerId, p);
    return p;
  }

  allowed(peerId) {
    const p = this.mesh && this.mesh.peers.get(peerId);
    return !!(p && p.perms && p.perms.state);
  }

  // Something changed here: rescan, and tell the others.
  touch() {
    clearTimeout(this.touchTimer);
    this.touchTimer = setTimeout(() => {
      if (this.scan().length && this.mesh) {
        for (const id of this.mesh.conns.keys()) if (this.allowed(id)) this.mesh.request(id, 'state.changed', {}, 10000).catch(() => {});
      }
    }, 600);
  }

  attach(mesh) {
    this.mesh = mesh;
    mesh.handle('state.manifest', 'state', async () => ({ index: this.manifest() }));
    mesh.handle('state.get', 'state', async (a) => {
      const items = {};
      let size = 0;
      for (const key of (Array.isArray(a.keys) ? a.keys : []).slice(0, 50)) {
        const e = this.index.get(key);
        if (!e || e.deleted || !this.cache.has(key)) continue;
        const value = this.cache.get(key);
        const len = JSON.stringify(value).length;
        if (len > MAX_ITEM || size + len > 15 * 1024 * 1024) continue;
        size += len;
        items[key] = { value, t: e.t };
      }
      return { items };
    });
    mesh.handle('state.changed', 'state', async (_a, from) => { setTimeout(() => this.sync(from.id), 300); return { ok: true }; });
    mesh.on('online', (id) => { if (this.allowed(id)) setTimeout(() => this.sync(id), 1500); });
  }

  start() {
    this.scan();
    this.timers.push(setInterval(() => this.touch(), SCAN_MS));
    this.timers.push(setInterval(() => { if (this.mesh) for (const id of this.mesh.conns.keys()) if (this.allowed(id)) this.sync(id); }, PERIODIC_MS));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.touchTimer);
    this.mesh = null;
  }
}

module.exports = { StateSync, hashOf };
