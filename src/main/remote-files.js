// Browsing other devices' files over the mesh (v1.2.5 step 3).
//
// Serving side: a paired device with the "files" permission sees this
// device's File Pool plus any folders shared with that device in
// Settings > Devices (peer.shares) - nothing else. Every request is checked
// by the mesh against the permission, and every path is confined to one of
// those roots (no "..", no symlink escape).
//
// Browsing side: remote places use aero://<deviceId>/<root>/<rel> paths.
// Folders list over the mesh; opening or copying a file downloads it in
// 1 MB chunks (to a cache for opening, or to the chosen folder for copies).
// Remote folders are read-only from here.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const CHUNK = 1024 * 1024;
const INDEX_MAX = 50000;          // names per shared folder kept for search
const INDEX_TTL = 60 * 1000;      // rebuilt when older than this
const SEARCH_LIMIT = 40;

// Every name under a folder (skipping hidden and sync metadata), breadth-first,
// capped - what a search over a shared folder looks through.
async function walkNames(rootDir) {
  const out = [];
  const queue = [''];
  while (queue.length && out.length < INDEX_MAX) {
    const rel = queue.shift();
    let dirents;
    try { dirents = await fsp.readdir(path.join(rootDir, rel), { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      if (d.name.startsWith('.') || d.name === '.be-aero-sync') continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      const dir = d.isDirectory();
      out.push({ rel: r, name: d.name, dir });
      if (dir) queue.push(r);
      if (out.length >= INDEX_MAX) break;
    }
  }
  return out;
}

// All words of the query in the name (any order, any case).
function nameMatches(name, words) {
  const n = name.toLowerCase();
  return words.every((w) => n.includes(w));
}
const MAX_ENTRIES = 5000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;
const TEXT_EXT = /\.(txt|md|markdown|log|json|js|ts|py|go|rs|c|h|cpp|cs|java|sh|ps1|ini|cfg|conf|toml|ya?ml|xml|html?|css|csv|sql)$/i;

// aero://DEVICE/ROOT/rel/path -> { device, root, rel }
function parseRemote(url) {
  const m = /^aero:\/\/([A-Z2-7-]+)(?:\/(\d+))?(?:\/(.*))?$/i.exec(String(url || '').replace(/\\/g, '/'));
  if (!m) return null;
  const rel = (m[3] || '').replace(/\/+$/, '');
  // Names come from the other device: no "..", "." or empty segments and no
  // NULs - nothing that could climb out of a folder.
  if (rel && rel.split('/').some((x) => !x || x === '.' || x === '..' || x.includes('\0'))) return null;
  return { device: m[1].toUpperCase(), root: m[2] === undefined ? null : Number(m[2]), rel };
}
// The file name a remote url ends in, safe to use as a local file name.
function remoteName(url) {
  const r = parseRemote(url);
  const name = r && r.rel ? r.rel.split('/').pop() : '';
  if (!name) throw new Error('that file name cannot be used here');
  return localName(name);
}
// A name from another device made safe for this one: on Windows the
// characters it does not allow (":" would write an alternate data stream).
function localName(name) {
  const n = process.platform === 'win32' ? String(name).replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '_') : String(name);
  return n === '.' || n === '..' || !n ? '_' : n;
}
const isRemote = (p) => /^aero:\/\//i.test(String(p || ''));
const remoteUrl = (device, root, rel = '') => `aero://${device}/${root}${rel ? `/${rel}` : ''}`;

// A shared root + relative path -> absolute path, or throw when it escapes.
async function confine(rootDir, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (clean.includes('..')) throw new Error('outside the shared folder');
  const abs = path.join(rootDir, ...clean);
  const real = await fsp.realpath(abs).catch(() => abs);
  const realRoot = await fsp.realpath(rootDir).catch(() => rootDir);
  const r = path.relative(realRoot, real);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('outside the shared folder');
  return abs;
}

class RemoteFiles {
  // { getMesh(), poolDir(), cacheDir, shareStore: { get(peerId) -> [{ path, name }] } }
  constructor({ getMesh, poolDir, cacheDir, shareStore, poolShared = () => true }) {
    this.poolShared = poolShared;
    this.getMesh = getMesh;
    this.poolDir = poolDir;
    this.cacheDir = cacheDir;
    this.shareStore = shareStore;
    this.nameIndex = new Map();     // root path -> { at, names, building }
  }

  async namesOf(rootDir) {
    const have = this.nameIndex.get(rootDir);
    if (have && Date.now() - have.at < INDEX_TTL) return have.names;
    if (have && have.building) return have.building;
    const building = walkNames(rootDir).then((names) => { this.nameIndex.set(rootDir, { at: Date.now(), names }); return names; })
      .catch(() => { this.nameIndex.delete(rootDir); return []; });
    this.nameIndex.set(rootDir, { at: 0, names: have ? have.names : [], building });
    return building;
  }

  // ---- serving
  roots(peerId) {
    const extra = (this.shareStore.get(peerId) || []).filter((s) => s && s.path);
    // Index 0 is always the File Pool's slot (null while it is not shared), so
    // the other shared folders keep their numbers.
    return [this.poolShared() ? { name: 'File Pool', path: this.poolDir(), kind: 'pool' } : null, ...extra.map((s) => ({ name: s.name || path.basename(s.path), path: s.path, kind: 'folder' }))];
  }

  attach(mesh) {
    mesh.handle('files.roots', 'files', async (_a, from) => ({ roots: this.roots(from.id).map((r, i) => (r ? { index: i, name: r.name, kind: r.kind } : null)).filter(Boolean) }));
    mesh.handle('files.list', 'files', async (a, from) => {
      const root = this.roots(from.id)[Number(a.root)];
      if (!root) throw new Error('no such shared folder');
      const dir = await confine(root.path, a.rel);
      const dirents = await fsp.readdir(dir, { withFileTypes: true });
      const entries = [];
      for (const d of dirents.slice(0, MAX_ENTRIES)) {
        if (d.name === '.be-aero-sync') continue;
        let st = null;
        try { st = await fsp.stat(path.join(dir, d.name)); } catch { /* unreadable */ }
        const isDir = st ? st.isDirectory() : d.isDirectory();
        entries.push({ name: d.name, dir: isDir, size: st && !isDir ? st.size : null, mtime: st ? st.mtimeMs : null, hidden: d.name.startsWith('.') });
      }
      return { entries, truncated: dirents.length > MAX_ENTRIES };
    });
    // Search by name in what this device shares with the asker.
    mesh.handle('files.search', 'files', async (a, from) => {
      const words = String(a.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
      if (!words.length || words.join('').length < 2) return { results: [] };
      const results = [];
      const roots = this.roots(from.id);
      for (let i = 0; i < roots.length && results.length < SEARCH_LIMIT; i++) {
        if (!roots[i]) continue;
        for (const e of await this.namesOf(roots[i].path)) {
          if (!nameMatches(e.name, words)) continue;
          results.push({ root: i, rootName: roots[i].name, rel: e.rel, name: e.name, dir: e.dir });
          if (results.length >= SEARCH_LIMIT) break;
        }
      }
      return { results };
    });
    mesh.handle('files.read', 'files', async (a, from) => {
      const root = this.roots(from.id)[Number(a.root)];
      if (!root) throw new Error('no such shared folder');
      const file = await confine(root.path, a.rel);
      const st = await fsp.stat(file);
      if (!st.isFile()) throw new Error('not a file');
      const fh = await fsp.open(file, 'r');
      try {
        const len = Math.max(0, Math.min(CHUNK, Number(a.length) || CHUNK));
        const buf = Buffer.alloc(len);
        const offset = Math.max(0, Number(a.offset) || 0);
        const { bytesRead } = await fh.read(buf, 0, len, offset);
        return { data: buf.subarray(0, bytesRead).toString('base64'), size: st.size, mtime: st.mtimeMs, eof: offset + bytesRead >= st.size };
      } finally { await fh.close(); }
    });
  }

  // ---- browsing
  mesh() {
    const m = this.getMesh();
    if (!m) throw new Error('Device connections are off (Settings > Devices).');
    return m;
  }

  // Online paired devices, for the places list.
  devices() {
    const m = this.getMesh();
    if (!m) return [];
    // A relay shows its storage (relay-drive.js) when that is wired in.
    return [...m.peers.values()].filter((p) => m.conns.has(p.id) && (p.role !== 'relay' || this.drive))
      .map((p) => ({ id: p.id, name: p.label || p.name, relay: p.role === 'relay' }));
  }

  relayOf(url) { const r = parseRemote(url); return r && this.drive && this.drive.isRelay(r.device) ? r : null; }

  // Shared storage on a relay can be written to; everything else remote is read-only.
  writable(url) { const r = this.relayOf(url); return !!(r && r.root === 0); }

  async mkdir(url, name) {
    const r = this.relayOf(url);
    if (!r || r.root !== 0) throw new Error('read-only');
    const n = String(name || 'New folder').replace(/[\\/:*?"<>|]/g, '').trim() || 'New folder';
    const rel = await this.drive.mkdir(r.device, r.rel ? `${r.rel}/${n}` : n);
    return remoteUrl(r.device, 0, rel);
  }

  async rename(url, name) {
    const r = this.relayOf(url);
    if (!r || r.root !== 0 || !r.rel) throw new Error('read-only');
    return remoteUrl(r.device, 0, await this.drive.rename(r.device, r.rel, name));
  }

  async remove(urls) {
    const by = new Map();
    for (const u of [].concat(urls || [])) {
      const r = this.relayOf(u);
      if (!r || r.root !== 0 || !r.rel) throw new Error('read-only');
      by.set(r.device, [...(by.get(r.device) || []), r.rel]);
    }
    for (const [dev, rels] of by) await this.drive.remove(dev, 0, rels);
    return [].concat(urls || []);
  }

  // Local files and folders into Shared storage.
  async put(localPaths, destUrl, ctl = null) {
    const r = this.relayOf(destUrl);
    if (!r || r.root !== 0) throw new Error('read-only');
    const out = [];
    for (const p of [].concat(localPaths || [])) {
      if (isRemote(p)) throw new Error('Copy it to this computer first, then into Shared storage.');
      for (const x of await this.drive.put(r.device, r.rel, p, ctl)) out.push(remoteUrl(r.device, 0, x.path));
    }
    return out;
  }

  // Search every online paired device's shared folders by name.
  async search(q) {
    const m = this.getMesh();
    if (!m) return [];
    const ids = [...m.conns.keys()].filter((id) => { const p = m.peers.get(id); return p && p.perms && p.perms.files !== false; });
    const all = await Promise.all(ids.map(async (id) => {
      try {
        const { results } = await m.request(id, 'files.search', { q: String(q || '').slice(0, 100) }, 6000);
        const name = this.peerName(id);
        return (results || []).slice(0, SEARCH_LIMIT).map((r) => {
          const parts = String(r.rel || '').split('/');
          return {
            name: String(r.name || parts[parts.length - 1]), dir: !!r.dir, device: name,
            path: remoteUrl(id, Number(r.root), r.rel),
            where: `On ${name} · ${[r.rootName, ...parts.slice(0, -1)].filter(Boolean).join(' / ')}`
          };
        });
      } catch { return []; }          // that device does not share files with us, or is slow
    }));
    return all.flat();
  }

  peerName(id) {
    const p = this.getMesh() && this.getMesh().peers.get(id);
    return p ? p.label || p.name : 'Device';
  }

  // A remote listing in the same shape as FileService.list.
  async list(url) {
    const r = parseRemote(url);
    if (!r) throw new Error('not a device path');
    const m = this.mesh();
    const name = this.peerName(r.device);
    if (this.drive && this.drive.isRelay(r.device)) return this.listRelay(r, name);
    if (r.root === null) {
      const { roots } = await m.request(r.device, 'files.roots', {}, 15000);
      return {
        path: `aero://${r.device}`, parent: null, remote: true, deviceName: name, inPool: false, truncated: false,
        entries: roots.map((x) => ({ name: x.name, path: remoteUrl(r.device, x.index), dir: true, size: null, mtime: null, hidden: false, kind: x.kind === 'pool' ? 'pool' : 'folder' }))
      };
    }
    const res = await m.request(r.device, 'files.list', { root: r.root, rel: r.rel }, 20000);
    const parent = r.rel ? remoteUrl(r.device, r.root, r.rel.split('/').slice(0, -1).join('/')) : `aero://${r.device}`;
    return {
      path: remoteUrl(r.device, r.root, r.rel), parent, remote: true, deviceName: name, inPool: false, truncated: !!res.truncated,
      entries: res.entries.map((e) => ({
        ...e, path: remoteUrl(r.device, r.root, r.rel ? `${r.rel}/${e.name}` : e.name), link: false,
        kind: e.dir ? 'folder' : IMAGE_EXT.test(e.name) ? 'image' : TEXT_EXT.test(e.name) ? 'text' : 'file'
      }))
    };
  }

  // Download a remote file to `target` (written via a temp file).
  // A relay: its two storage folders, then their contents.
  async listRelay(r, name) {
    if (r.root === null) {
      return {
        path: `aero://${r.device}`, parent: null, remote: true, relay: true, deviceName: name, inPool: false, truncated: false, writable: false,
        entries: this.drive.roots().map((x) => ({ name: x.name, path: remoteUrl(r.device, x.index), dir: true, size: null, mtime: null, hidden: false, kind: x.kind }))
      };
    }
    if (r.root > 1) throw new Error('no such folder on the relay');
    const res = await this.drive.list(r.device, r.root, r.rel);
    const parent = r.rel ? remoteUrl(r.device, r.root, r.rel.split('/').slice(0, -1).join('/')) : `aero://${r.device}`;
    return {
      path: remoteUrl(r.device, r.root, r.rel), parent, remote: true, relay: true, deviceName: name, inPool: false, truncated: false,
      writable: r.root === 0, unreadable: res.unreadable, used: res.used, maxBytes: res.maxBytes,
      entries: res.entries.map((e) => ({
        name: e.name, dir: e.dir, size: e.size, mtime: e.mtime, hidden: false, link: false,
        path: remoteUrl(r.device, r.root, r.rel ? `${r.rel}/${e.name}` : e.name),
        kind: e.dir ? 'folder' : IMAGE_EXT.test(e.name) ? 'image' : TEXT_EXT.test(e.name) ? 'text' : 'file'
      }))
    };
  }

  // ctl (optional, from transfers.js): check() between chunks (pause / stop),
  // onBytes(n), addTotal(bytes, files).
  async download(url, target, ctl = null) {
    const r = parseRemote(url);
    if (!r || r.root === null || !r.rel) throw new Error('not a remote file');
    if (this.drive && this.drive.isRelay(r.device)) return this.drive.download(r.device, r.root, r.rel, target, ctl);
    const m = this.mesh();
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.part`;
    const fh = await fsp.open(tmp, 'w');
    let mtime = null;
    try {
      let offset = 0;
      let sized = false;
      for (;;) {
        if (ctl) await ctl.check();
        const c = await m.request(r.device, 'files.read', { root: r.root, rel: r.rel, offset, length: CHUNK }, 60000);
        if (ctl && !sized && ctl.addTotal) { ctl.addTotal(c.size || 0, 1); sized = true; }
        const buf = Buffer.from(c.data || '', 'base64');
        if (buf.length) { await fh.write(buf, 0, buf.length, offset); offset += buf.length; if (ctl) ctl.onBytes(buf.length); }
        mtime = c.mtime;
        if (c.eof || !buf.length) break;
      }
    } catch (err) {
      await fh.close().catch(() => {});
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    await fh.close();
    if (mtime) { const t = new Date(mtime); await fsp.utimes(tmp, t, t).catch(() => {}); }
    await fsp.rename(tmp, target);
    return target;
  }

  // For opening: a cached local copy, refreshed when the remote file changed.
  async cached(url) {
    const r = parseRemote(url);
    if (!r || r.root === null || !r.rel) throw new Error('not a remote file');
    const base = path.join(this.cacheDir, r.device.slice(0, 15), String(r.root));
    const target = path.join(base, ...r.rel.split('/').map(localName));
    const rp = path.relative(base, target);
    if (!rp || rp.startsWith('..') || path.isAbsolute(rp)) throw new Error('not a remote file');
    return this.download(url, target);
  }

  // A small preview: start of a text file, or an image (up to 6 MB).
  async preview(url, nativeImage) {
    const r = parseRemote(url);
    if (!r || r.root === null || !r.rel) return { kind: 'folder' };
    if (this.drive && this.drive.isRelay(r.device)) {
      // Relay storage is encrypted: preview from the decrypted local copy.
      const file = await this.cached(url);
      const st = await fsp.stat(file);
      if (IMAGE_EXT.test(r.rel) && st.size <= 6 * 1024 * 1024) {
        const img = nativeImage.createFromPath(file);
        if (!img.isEmpty()) return { kind: 'image', dataUrl: img.resize({ width: Math.min(320, img.getSize().width) }).toDataURL(), size: st.size };
      }
      const head = Buffer.alloc(Math.min(st.size, 64 * 1024));
      const fh = await fsp.open(file, 'r');
      try { await fh.read(head, 0, head.length, 0); } finally { await fh.close(); }
      if ((TEXT_EXT.test(r.rel) || st.size < 4096) && !head.includes(0)) return { kind: 'text', text: head.toString('utf8'), truncated: st.size > head.length, size: st.size };
      return { kind: 'file', size: st.size };
    }
    const m = this.mesh();
    const first = await m.request(r.device, 'files.read', { root: r.root, rel: r.rel, offset: 0, length: 64 * 1024 }, 20000);
    const buf = Buffer.from(first.data || '', 'base64');
    if (IMAGE_EXT.test(r.rel) && first.size <= 6 * 1024 * 1024) {
      const file = await this.cached(url);
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return { kind: 'image', dataUrl: img.resize({ width: Math.min(320, img.getSize().width) }).toDataURL(), size: first.size };
      return { kind: 'file', size: first.size };
    }
    if ((TEXT_EXT.test(r.rel) || first.size < 4096) && !buf.includes(0)) return { kind: 'text', text: buf.toString('utf8'), truncated: !first.eof, size: first.size };
    return { kind: 'file', size: first.size };
  }
}

module.exports = { RemoteFiles, parseRemote, isRemote, remoteUrl, remoteName, localName, confine, nameMatches, walkNames };
