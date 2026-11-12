// Relay storage on my devices: Shared storage (a folder all my devices can
// open, even when the others are off) and a copy of the File Pool, both on
// the BE-Aero Relay Server and both encrypted here first (drive-crypto.js).
//
// Paths in the file browser: aero://<relay id>/0/<path> (Shared storage),
// aero://<relay id>/1/<path> (the File Pool copy, kept by whichever of my
// devices is online - read-only in the browser).
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
const INDEX_MS = 4000;
const MIRROR_MS = 5 * 60 * 1000;

const clean = (rel) => String(rel || '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.' && x !== '..').join('/');

class RelayDrive {
  // { getMesh, relayClient, keyring (DriveKeyring), pool: { dir(), index() -> Map, onChange(cb) }, log }
  constructor({ getMesh, relayClient, keyring, pool = null, log = () => {} }) {
    this.getMesh = getMesh;
    this.relay = relayClient;
    this.keyring = keyring;
    this.pool = pool;
    this.log = log;
    this.cache = new Map();        // relayId -> { at, entries, unreadable, used, maxBytes }
    this.mirroring = null;
    this.timer = null;
  }

  mesh() { const m = this.getMesh(); if (!m) throw new Error('Device connections are off (Settings > Devices).'); return m; }
  relays() { const m = this.getMesh(); return m ? [...m.peers.values()].filter((p) => p.role === 'relay' && m.conns.has(p.id)) : []; }
  isRelay(id) { const m = this.getMesh(); const p = m && m.peers.get(id); return !!(p && p.role === 'relay'); }

  // ---- the key
  myDevices() { const m = this.getMesh(); return m ? [...m.peers.values()].filter((p) => p.role !== 'relay' && p.perms && p.perms.files) : []; }

  key({ create = false } = {}) {
    let k = this.keyring.current();
    if (!k && create) { k = this.keyring.create(); this.shareKeys(); }
    return k;
  }

  // Give my keys to my other devices: directly when online, else through a relay.
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

  // ---- what the relay holds
  async index(relayId, { fresh = false } = {}) {
    const c = this.cache.get(relayId);
    if (c && !fresh && Date.now() - c.at < INDEX_MS) return c;
    const r = await this.mesh().request(relayId, 'drive.index', {}, 30000);
    const entries = [];
    let unreadable = 0;
    for (const o of r.objects || []) {
      const meta = openMeta(this.keyring, o.meta);
      if (!meta || !NS.includes(meta.ns)) { unreadable++; continue; }
      entries.push({ id: o.id, ns: meta.ns, path: clean(meta.path), dir: !!meta.dir, size: Number(meta.size) || 0, mtime: Number(meta.mtime) || o.at, hash: meta.hash || '', stored: o.size, at: o.at, keyId: meta.keyId });
    }
    const out = { at: Date.now(), entries, unreadable, used: r.used, maxBytes: r.maxBytes };
    this.cache.set(relayId, out);
    return out;
  }

  find(idx, ns, rel) { const p = clean(rel); return idx.entries.filter((e) => e.ns === ns && e.path === p).sort((a, b) => b.at - a.at)[0] || null; }
  under(idx, ns, rel) { const p = clean(rel); return idx.entries.filter((e) => e.ns === ns && (e.path === p || e.path.startsWith(`${p}/`))); }

  roots() { return ROOT_NAMES.map((name, index) => ({ index, name, kind: index === 1 ? 'pool' : 'folder' })); }

  // Children of a folder: files directly in it, and folders (explicit, or implied by deeper paths).
  async list(relayId, root, rel) {
    const idx = await this.index(relayId);
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

  // ---- reading
  async download(relayId, root, rel, target) {
    const idx = await this.index(relayId);
    const e = this.find(idx, NS[root], rel);
    if (!e || e.dir) throw new Error('not a file on the relay');
    const key = this.keyring.get(e.keyId);
    if (!key) throw new Error('this file was stored with a key this device does not have yet');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.part`;
    const fh = await fsp.open(tmp, 'w');
    const hash = crypto.createHash('sha256');
    try {
      let off = 0;
      let wrote = 0;
      while (off < e.stored) {
        const c = await this.mesh().request(relayId, 'drive.read', { id: e.id, offset: off, length: ENC_CHUNK }, 60000);
        const buf = Buffer.from(c.data || '', 'base64');
        if (!buf.length) break;
        const plain = decryptChunk(key, buf);
        await fh.write(plain, 0, plain.length, wrote);
        hash.update(plain);
        wrote += plain.length;
        off += buf.length;
      }
      if (wrote !== e.size) throw new Error('the copy on the relay is incomplete');
      if (e.hash && hash.digest('hex') !== e.hash) throw new Error('the copy on the relay does not match its checksum');
    } catch (err) {
      await fh.close().catch(() => {});
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    await fh.close();
    if (e.mtime) { const t = new Date(e.mtime); await fsp.utimes(tmp, t, t).catch(() => {}); }
    await fsp.rename(tmp, target);
    return target;
  }

  // ---- writing (Shared storage; the Pool copy is kept by mirrorPool)
  async upload(relayId, root, rel, file, { hash: knownHash = null } = {}) {
    const k = this.key({ create: true });
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error('only files can be stored');
    const p = clean(rel);
    if (!p) throw new Error('no name');
    const hash = knownHash || await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
    const meta = sealMeta(k.id, k.key, { ns: NS[root], path: p, size: st.size, mtime: st.mtimeMs, hash });
    const m = this.mesh();
    const { id } = await m.request(relayId, 'drive.begin', { meta, size: encryptedSize(st.size) }, 30000);
    const fh = await fsp.open(file, 'r');
    try {
      let off = 0;
      let encOff = 0;
      const buf = Buffer.alloc(PLAIN_CHUNK);
      while (off < st.size) {
        const { bytesRead } = await fh.read(buf, 0, PLAIN_CHUNK, off);
        if (!bytesRead) break;
        const enc = encryptChunk(k.key, buf.subarray(0, bytesRead));
        await m.request(relayId, 'drive.chunk', { id, offset: encOff, data: enc.toString('base64') }, 120000);
        off += bytesRead;
        encOff += enc.length;
      }
    } finally { await fh.close(); }
    await m.request(relayId, 'drive.commit', { id }, 30000);
    // The newer copy replaces older ones at that path.
    const idx = await this.index(relayId, { fresh: true });
    const old = idx.entries.filter((e) => e.ns === NS[root] && e.path === p && e.id !== id).map((e) => e.id);
    if (old.length) await m.request(relayId, 'drive.remove', { ids: old }, 30000);
    this.cache.delete(relayId);
    return { id, path: p };
  }

  // A local file or folder into Shared storage, under destRel.
  async put(relayId, destRel, local) {
    const st = await fsp.stat(local);
    const name = path.basename(local);
    const into = clean(destRel ? `${destRel}/${name}` : name);
    if (!st.isDirectory()) return [await this.upload(relayId, 0, into, local)];
    const out = [];
    await this.mkdir(relayId, into);
    for (const d of await fsp.readdir(local, { withFileTypes: true })) out.push(...await this.put(relayId, into, path.join(local, d.name)));
    return out;
  }

  async mkdir(relayId, rel) {
    const k = this.key({ create: true });
    const p = clean(rel);
    const meta = sealMeta(k.id, k.key, { ns: 'drive', path: p, dir: true, size: 0, mtime: Date.now() });
    const m = this.mesh();
    const { id } = await m.request(relayId, 'drive.begin', { meta, size: 0 }, 30000);
    await m.request(relayId, 'drive.commit', { id }, 30000);
    this.cache.delete(relayId);
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
      const meta = sealMeta(k.id, k.key, { ns: 'drive', path: to + e.path.slice(from.length), dir: e.dir, size: e.size, mtime: e.mtime, hash: e.hash });
      await this.mesh().request(relayId, 'drive.meta', { id: e.id, meta }, 30000);
    }
    this.cache.delete(relayId);
    return to;
  }

  async remove(relayId, root, rels) {
    const idx = await this.index(relayId, { fresh: true });
    const ids = [];
    for (const r of [].concat(rels || [])) ids.push(...this.under(idx, NS[root], r).map((e) => e.id));
    if (ids.length) await this.mesh().request(relayId, 'drive.remove', { ids }, 30000);
    this.cache.delete(relayId);
    return ids.length;
  }

  // ---- the File Pool copy: new and changed files go up; a file deleted
  // here goes when the relay's copy is that same version.
  mirrorPool() {
    if (this.mirroring) return this.mirroring;
    this.mirroring = this.mirrorNow().catch((err) => this.log(`pool copy: ${err.message}`)).finally(() => { this.mirroring = null; });
    return this.mirroring;
  }

  async mirrorNow() {
    if (!this.pool || !this.myDevices().length) return;          // nobody else to keep it for
    const relay = this.relays()[0];
    if (!relay) return;
    const local = this.pool.index();
    if (!local || !local.size) return;
    this.key({ create: true });
    const idx = await this.index(relay.id, { fresh: true });
    let up = 0;
    let gone = 0;
    for (const [rel, e] of local) {
      const remote = this.find(idx, 'pool', rel);
      if (e.deleted) {
        if (remote && remote.hash && remote.hash === e.hash) { await this.mesh().request(relay.id, 'drive.remove', { ids: [remote.id] }, 30000); gone++; }
        continue;
      }
      if (remote && remote.hash === e.hash) continue;
      if (remote && remote.mtime > e.mtime) continue;                // a newer version is already there
      const file = path.join(this.pool.dir(), ...rel.split('/'));
      try { await this.upload(relay.id, 1, rel, file, { hash: e.hash }); up++; } catch (err) { this.log(`pool copy of ${rel}: ${err.message}`); }
    }
    if (up || gone) this.log(`pool copy on the relay: ${up} uploaded, ${gone} removed`);
  }
}

module.exports = { RelayDrive, ROOT_NAMES, NS };
