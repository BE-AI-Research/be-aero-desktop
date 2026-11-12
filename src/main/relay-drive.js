// Relay storage on my devices: Shared storage (a folder all my devices can
// open, even when the others are off) and a copy of the File Pool, both on
// the BE-Aero Relay Server and both encrypted here first (drive-crypto.js).
//
// Paths in the file browser: aero://<relay id>/0/<path> (Shared storage),
// aero://<relay id>/1/<path> (the File Pool copy, kept by whichever of my
// devices is online - read-only in the browser).
//
// Transfers: uploads resume where the relay says they stopped, downloads
// resume from their .part file; both take a control object (pause, stop,
// progress) so the file browser's transfer dialog can drive them. A few
// files go at a time; the index is kept here and refreshed with only what
// changed (drive.index since).
//
// Conflicts: each object carries an opaque key (HMAC of its path with our
// shared key) and a commit names the version it replaces. When another
// device changed the file meanwhile the relay says "conflict":
//   same content            -> ours is dropped
//   File Pool copy          -> the newer file wins
//   Shared storage          -> ours is kept beside it as "name (conflict DEVICE date).ext"
//
// The key: made by the first device that needs it, given to my other paired
// devices (permission "Browse files") over the mesh, or sealed through the
// relay for one that is offline. Everyone uses the oldest key they know.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { encryptChunk, decryptChunk, sealMeta, openMeta, encryptedSize, PLAIN_CHUNK, ENC_CHUNK } = require('./mesh/drive-crypto');

const NS = ['drive', 'pool'];
const ROOT_NAMES = ['Shared storage', 'File Pool (copy on relay)'];
const INDEX_MS = 500;            // a refresh only carries what changed: cheap
const MIRROR_MS = 5 * 60 * 1000;
const PARALLEL = 3;
const RETRIES = 4;

const clean = (rel) => String(rel || '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.' && x !== '..').join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Errors worth another try: the connection dropped or timed out, the relay restarted.
const transient = (err) => /offline|timed out|timeout|closed|ECONN|EPIPE|socket|no answer|not connected|restart/i.test(String(err && err.message || err));

// "report.txt" -> "report (conflict Laptop 2026-11-12).txt"
function conflictName(p, device) {
  const dir = path.posix.dirname(p);
  const ext = path.posix.extname(p);
  const base = path.posix.basename(p, ext);
  const d = new Date().toISOString().slice(0, 10);
  const name = `${base} (conflict ${String(device || 'device').replace(/[\\/:*?"<>|]/g, '')} ${d})${ext}`;
  return dir === '.' ? name : `${dir}/${name}`;
}

// Run fn over items, n at a time.
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

class RelayDrive {
  // { getMesh, relayClient, keyring (DriveKeyring), pool: { dir(), index() -> Map, onChange(cb) }, deviceName(), log }
  constructor({ getMesh, relayClient, keyring, pool: poolSrc = null, deviceName = () => 'device', log = () => {} }) {
    this.getMesh = getMesh;
    this.relay = relayClient;
    this.keyring = keyring;
    this.pool = poolSrc;
    this.deviceName = deviceName;
    this.log = log;
    this.cache = new Map();        // relayId -> { at, seq, objects: Map(id -> raw), entries, unreadable, used, maxBytes }
    this.mirroring = null;
    this.timer = null;
  }

  mesh() { const m = this.getMesh(); if (!m) throw new Error('Device connections are off (Settings > Devices).'); return m; }
  relays() { const m = this.getMesh(); return m ? [...m.peers.values()].filter((p) => p.role === 'relay' && m.conns.has(p.id)) : []; }
  isRelay(id) { const m = this.getMesh(); const p = m && m.peers.get(id); return !!(p && p.role === 'relay'); }
  req(relayId, op, args, timeout = 60000) { return this.mesh().request(relayId, op, args, timeout); }

  // ---- the key
  myDevices() { const m = this.getMesh(); return m ? [...m.peers.values()].filter((p) => p.role !== 'relay' && p.perms && p.perms.files) : []; }

  key({ create = false } = {}) {
    let k = this.keyring.current();
    if (!k && create) { k = this.keyring.create(); this.shareKeys(); }
    return k;
  }

  // An opaque, stable key for a path: the relay can match versions of one
  // file without learning its name.
  pathKey(ns, p) {
    const k = this.key({ create: true });
    return crypto.createHmac('sha256', k.key).update(`${ns}\0${clean(p)}`).digest('hex').slice(0, 40);
  }

  shareKeys(only = null) {
    const m = this.getMesh();
    if (!m || !this.keyring.has()) return;
    const keys = this.keyring.export();
    for (const p of this.myDevices()) {
      if (only && p.id !== only) continue;
      if (m.conns.has(p.id)) m.request(p.id, 'drive.keys', { keys }, 10000).catch(() => {});
      else if (this.relay && this.relay.reachable(p.id)) this.relay.send(p.id, 'drivekey', 'keys', { keys }).catch(() => {});
    }
  }

  receiveKeys(keys) { const n = this.keyring.merge(keys); if (n) { this.cache.clear(); this.log(`relay storage: ${n} key(s) from another device`); } return n; }

  attach(mesh) {
    mesh.handle('drive.keys', 'files', async (a) => ({ added: this.receiveKeys(a && a.keys) }));
    mesh.on('online', (id) => setTimeout(() => {
      const p = mesh.peers.get(id);
      if (p && p.role !== 'relay') this.shareKeys(id);
      if (p && p.role === 'relay') this.mirrorPool().catch(() => {});
    }, 2000));
    clearInterval(this.timer);
    this.timer = setInterval(() => this.mirrorPool().catch(() => {}), MIRROR_MS);
    if (this.pool && this.pool.onChange) {
      let t = null;
      this.pool.onChange(() => { clearTimeout(t); t = setTimeout(() => this.mirrorPool().catch(() => {}), 15000); });
    }
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  // ---- what the relay holds (kept here, refreshed with what changed)
  decode(o) {
    const meta = openMeta(this.keyring, o.meta);
    if (!meta || !NS.includes(meta.ns)) return null;
    return { id: o.id, ns: meta.ns, path: clean(meta.path), dir: !!meta.dir, size: Number(meta.size) || 0, mtime: Number(meta.mtime) || o.at, hash: meta.hash || '', stored: o.size, at: o.at, keyId: meta.keyId, key: o.key || '', by: meta.by || '' };
  }

  async index(relayId, { fresh = false } = {}) {
    let c = this.cache.get(relayId);
    if (c && !fresh && Date.now() - c.at < INDEX_MS) return c;
    const r = await this.req(relayId, 'drive.index', { since: c ? c.seq : 0 }, 60000);
    if (!c || r.full || r.version !== 2) c = { seq: 0, objects: new Map() };
    if (r.full || !c.objects.size) c.objects = new Map();
    for (const o of r.objects || []) c.objects.set(o.id, o);
    for (const id of r.removed || []) c.objects.delete(id);
    c.seq = Number(r.seq) || 0;
    c.at = Date.now();
    c.used = r.used;
    c.maxBytes = r.maxBytes;
    c.entries = [];
    c.unreadable = 0;
    for (const o of c.objects.values()) { const e = this.decode(o); if (e) c.entries.push(e); else c.unreadable++; }
    this.cache.set(relayId, c);
    return c;
  }

  // What we just did, without asking the relay again.
  noteCommitted(relayId, raw, removedIds = []) {
    const c = this.cache.get(relayId);
    if (!c) return;
    if (raw) c.objects.set(raw.id, raw);
    for (const id of removedIds) c.objects.delete(id);
    c.entries = [];
    c.unreadable = 0;
    for (const o of c.objects.values()) { const e = this.decode(o); if (e) c.entries.push(e); else c.unreadable++; }
  }

  find(idx, ns, rel) { const p = clean(rel); return idx.entries.filter((e) => e.ns === ns && e.path === p && !e.dir).sort((a, b) => b.at - a.at)[0] || null; }
  under(idx, ns, rel) { const p = clean(rel); return idx.entries.filter((e) => e.ns === ns && (e.path === p || e.path.startsWith(`${p}/`))); }

  roots() { return ROOT_NAMES.map((name, index) => ({ index, name, kind: index === 1 ? 'pool' : 'folder' })); }

  async list(relayId, root, rel) {
    const idx = await this.index(relayId, { fresh: true });      // what changed since the last look: cheap
    const ns = NS[root];
    const base = clean(rel);
    const pre = base ? `${base}/` : '';
    const out = new Map();
    for (const e of idx.entries) {
      if (e.ns !== ns || !e.path.startsWith(pre) || e.path === base) continue;
      const rest = e.path.slice(pre.length);
      const name = rest.split('/')[0];
      if (rest.includes('/')) { if (!out.has(name)) out.set(name, { name, dir: true, size: null, mtime: e.mtime }); continue; }
      const cur = out.get(name);
      if (e.dir) { if (!cur) out.set(name, { name, dir: true, size: null, mtime: e.mtime }); continue; }
      if (!cur || (!cur.dir && cur.at < e.at)) out.set(name, { name, dir: false, size: e.size, mtime: e.mtime, at: e.at });
    }
    return { entries: [...out.values()], unreadable: idx.unreadable, used: idx.used, maxBytes: idx.maxBytes };
  }

  // ---- reading (resumable: a .part file carries on from where it stopped)
  async download(relayId, root, rel, target, ctl = null) {
    const idx = await this.index(relayId);
    const e = this.find(idx, NS[root], rel);
    if (!e) throw new Error('not a file on the relay');
    const key = this.keyring.get(e.keyId);
    if (!key) throw new Error('this file was stored with a key this device does not have yet');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${e.id.slice(1, 9)}.part`;
    // Resume: whole plaintext chunks already written map to encrypted offsets.
    let wrote = 0;
    try { wrote = (await fsp.stat(tmp)).size; } catch { wrote = 0; }
    wrote -= wrote % PLAIN_CHUNK;
    if (wrote > e.size) wrote = 0;
    const fh = await fsp.open(tmp, wrote ? 'r+' : 'w');
    try {
      await fh.truncate(wrote);
      if (ctl && wrote) ctl.onBytes(wrote);
      let off = (wrote / PLAIN_CHUNK) * ENC_CHUNK;
      while (off < e.stored) {
        if (ctl) await ctl.check();
        let c = null;
        for (let attempt = 0; ; attempt++) {
          try { c = await this.req(relayId, 'drive.read', { id: e.id, offset: off, length: ENC_CHUNK }, 60000); break; } catch (err) {
            if (attempt >= RETRIES || !transient(err)) throw err;
            await sleep(1000 * 2 ** attempt);
          }
        }
        const buf = Buffer.from(c.data || '', 'base64');
        if (!buf.length) break;
        const plain = decryptChunk(key, buf);
        await fh.write(plain, 0, plain.length, wrote);
        wrote += plain.length;
        off += buf.length;
        if (ctl) ctl.onBytes(plain.length);
      }
    } finally { await fh.close(); }
    if (wrote !== e.size) throw new Error('the copy on the relay is incomplete');
    if (e.hash) {
      const h = await new Promise((resolve, reject) => {
        const x = crypto.createHash('sha256');
        fs.createReadStream(tmp).on('data', (d) => x.update(d)).on('end', () => resolve(x.digest('hex'))).on('error', reject);
      });
      if (h !== e.hash) { await fsp.rm(tmp, { force: true }); throw new Error('the copy on the relay does not match its checksum'); }
    }
    if (e.mtime) { const t = new Date(e.mtime); await fsp.utimes(tmp, t, t).catch(() => {}); }
    await fsp.rename(tmp, target);
    return target;
  }

  // ---- writing
  async hashFile(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
  }

  // One file up: resumable, retried, conflict-checked. -> { id, path, skipped?, conflictCopy? }
  async upload(relayId, root, rel, file, { hash: knownHash = null, ctl = null } = {}) {
    const k = this.key({ create: true });
    const ns = NS[root];
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error('only files can be stored');
    let p = clean(rel);
    if (!p) throw new Error('no name');
    const hash = knownHash || await this.hashFile(file);
    const idx = await this.index(relayId);
    const existing = this.find(idx, ns, p);
    if (existing && existing.hash === hash) { if (ctl) ctl.onBytes(st.size); return { id: existing.id, path: p, skipped: 'same content' }; }
    const metaOf = (pp) => sealMeta(k.id, k.key, { ns, path: pp, size: st.size, mtime: st.mtimeMs, hash, by: this.deviceName() });
    const size = encryptedSize(st.size);
    const { id } = await this.req(relayId, 'drive.begin', { meta: metaOf(p), size, key: this.pathKey(ns, p), base: existing ? existing.id : null }, 30000);
    // Send the encrypted chunks. After a dropped connection, ask the relay how
    // far it got and carry on from the last whole chunk.
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(PLAIN_CHUNK);
      let encOff = 0;
      let credited = 0;
      let failures = 0;
      for (;;) {
        const plainOff = (encOff / ENC_CHUNK) * PLAIN_CHUNK;
        if (plainOff >= st.size) break;
        if (ctl) await ctl.check();
        const { bytesRead } = await fh.read(buf, 0, PLAIN_CHUNK, plainOff);
        if (!bytesRead) break;
        const enc = encryptChunk(k.key, buf.subarray(0, bytesRead));
        try {
          await this.req(relayId, 'drive.chunk', { id, offset: encOff, data: enc.toString('base64') }, 120000);
          encOff += enc.length;
          failures = 0;
          const done = plainOff + bytesRead;
          if (ctl && done > credited) { ctl.onBytes(done - credited); credited = done; }
        } catch (err) {
          if (!transient(err) || ++failures > RETRIES) throw err;
          await sleep(1000 * 2 ** failures);
          const s2 = await this.req(relayId, 'drive.status', { id }, 30000).catch(() => null);
          if (s2 && typeof s2.next === 'number') encOff = Math.floor(s2.next / ENC_CHUNK) * ENC_CHUNK;
          else if (s2 && !s2.exists) throw new Error('the relay lost this upload; it will start again next time');
        }
      }
    } catch (err) {
      if (ctl && ctl.cancelled) await this.req(relayId, 'drive.abort', { id }, 15000).catch(() => {});
      throw err;
    } finally { await fh.close(); }
    // Commit, settling a conflict if another device changed this file meanwhile.
    let r = await this.req(relayId, 'drive.commit', { id }, 60000);
    let conflictCopy = null;
    if (r.conflict) {
      const theirs = (r.current || []).map((o) => this.decode(o)).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
      const top = theirs[0];
      if (top && top.hash === hash) {
        await this.req(relayId, 'drive.abort', { id }, 15000).catch(() => {});
        await this.index(relayId, { fresh: true });
        return { id: top.id, path: p, skipped: 'same content' };
      }
      if (ns === 'pool') {
        if (top && top.mtime > st.mtimeMs) {
          await this.req(relayId, 'drive.abort', { id }, 15000).catch(() => {});
          await this.index(relayId, { fresh: true });
          return { id: top.id, path: p, skipped: 'a newer copy is there' };
        }
        r = await this.req(relayId, 'drive.commit', { id, force: true }, 60000);
      } else {
        conflictCopy = conflictName(p, this.deviceName());
        p = conflictCopy;
        r = await this.req(relayId, 'drive.commit', { id, asNew: { meta: metaOf(p), key: this.pathKey(ns, p) } }, 60000);
      }
    }
    if (!r.ok) throw new Error('the relay did not store it');
    await this.index(relayId, { fresh: true });
    return { id, path: p, ...(conflictCopy ? { conflictCopy } : {}) };
  }

  // Local files and folders into Shared storage (several at a time).
  async put(relayId, destRel, local, ctl = null) {
    const files = [];
    const walk = async (src, into) => {
      const st = await fsp.stat(src);
      if (!st.isDirectory()) { files.push({ src, rel: into, size: st.size }); return; }
      await this.mkdir(relayId, into);
      for (const d of await fsp.readdir(src, { withFileTypes: true })) await walk(path.join(src, d.name), `${into}/${d.name}`);
    };
    await walk(local, clean(destRel ? `${destRel}/${path.basename(local)}` : path.basename(local)));
    if (ctl && ctl.addTotal) ctl.addTotal(files.reduce((n, f) => n + f.size, 0), files.length);
    return pool(files, PARALLEL, async (f) => {
      const r = await this.upload(relayId, 0, f.rel, f.src, { ctl });
      if (ctl && ctl.fileDone) ctl.fileDone(f.rel);
      return r;
    });
  }

  async mkdir(relayId, rel) {
    const k = this.key({ create: true });
    const p = clean(rel);
    const idx = await this.index(relayId);
    if (idx.entries.some((e) => e.ns === 'drive' && e.dir && e.path === p)) return p;
    const meta = sealMeta(k.id, k.key, { ns: 'drive', path: p, dir: true, size: 0, mtime: Date.now(), by: this.deviceName() });
    const { id } = await this.req(relayId, 'drive.begin', { meta, size: 0, key: this.pathKey('drive', `${p}/`) }, 30000);
    const r = await this.req(relayId, 'drive.commit', { id }, 30000);
    if (r.conflict) await this.req(relayId, 'drive.abort', { id }, 15000).catch(() => {});        // made by another device meanwhile
    await this.index(relayId, { fresh: true });
    return p;
  }

  async rename(relayId, rel, newName) {
    const n = String(newName || '').trim();
    if (!n || /[\\/]/.test(n)) throw new Error('That name is not allowed.');
    const idx = await this.index(relayId, { fresh: true });
    const from = clean(rel);
    const to = clean([...from.split('/').slice(0, -1), n].join('/'));
    if (idx.entries.some((e) => e.ns === 'drive' && (e.path === to || e.path.startsWith(`${to}/`)))) throw new Error(`"${n}" already exists here.`);
    const k = this.key({ create: true });
    for (const e of this.under(idx, 'drive', from)) {
      const np = to + e.path.slice(from.length);
      const meta = sealMeta(k.id, k.key, { ns: 'drive', path: np, dir: e.dir, size: e.size, mtime: e.mtime, hash: e.hash, by: this.deviceName() });
      await this.req(relayId, 'drive.meta', { id: e.id, meta, key: this.pathKey('drive', e.dir ? `${np}/` : np) }, 30000);
    }
    await this.index(relayId, { fresh: true });
    return to;
  }

  async remove(relayId, root, rels) {
    const idx = await this.index(relayId, { fresh: true });
    const ids = [];
    for (const r of [].concat(rels || [])) ids.push(...this.under(idx, NS[root], r).map((e) => e.id));
    for (let i = 0; i < ids.length; i += 500) await this.req(relayId, 'drive.remove', { ids: ids.slice(i, i + 500) }, 60000);
    await this.index(relayId, { fresh: true });
    return ids.length;
  }

  // ---- the File Pool copy: new and changed files go up (a few at a time);
  // a file deleted here goes when the relay's copy is that same version.
  mirrorPool() {
    if (this.mirroring) return this.mirroring;
    this.mirroring = this.mirrorNow().catch((err) => this.log(`pool copy: ${err.message}`)).finally(() => { this.mirroring = null; });
    return this.mirroring;
  }

  async mirrorNow() {
    if (!this.pool || !this.myDevices().length) return;
    const relay = this.relays()[0];
    if (!relay) return;
    const local = this.pool.index();
    if (!local || !local.size) return;
    this.key({ create: true });
    const idx = await this.index(relay.id, { fresh: true });
    const todo = [];
    const gone = [];
    for (const [rel, e] of local) {
      const remote = this.find(idx, 'pool', rel);
      if (e.deleted) { if (remote && remote.hash && remote.hash === e.hash) gone.push(remote.id); continue; }
      if (remote && (remote.hash === e.hash || remote.mtime > e.mtime)) continue;
      todo.push({ rel, e });
    }
    for (let i = 0; i < gone.length; i += 500) await this.req(relay.id, 'drive.remove', { ids: gone.slice(i, i + 500) }, 60000);
    let up = 0;
    let failed = 0;
    await pool(todo, PARALLEL, async ({ rel, e }) => {
      if (!this.relays().some((r) => r.id === relay.id)) return;            // relay went away: next run
      const file = path.join(this.pool.dir(), ...rel.split('/'));
      try { const r = await this.upload(relay.id, 1, rel, file, { hash: e.hash }); if (!r.skipped) up++; } catch (err) { failed++; if (failed <= 3) this.log(`pool copy of ${rel}: ${err.message}`); }
    });
    if (up || gone.length || failed) this.log(`pool copy on the relay: ${up} uploaded, ${gone.length} removed${failed ? `, ${failed} failed (next run retries)` : ''}`);
  }
}

module.exports = { RelayDrive, ROOT_NAMES, NS, conflictName, pool };
