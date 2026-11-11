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
const MAX_ENTRIES = 5000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;
const TEXT_EXT = /\.(txt|md|markdown|log|json|js|ts|py|go|rs|c|h|cpp|cs|java|sh|ps1|ini|cfg|conf|toml|ya?ml|xml|html?|css|csv|sql)$/i;

// aero://DEVICE/ROOT/rel/path -> { device, root, rel }
function parseRemote(url) {
  const m = /^aero:\/\/([A-Z2-7-]+)(?:\/(\d+))?(?:\/(.*))?$/i.exec(String(url || '').replace(/\\/g, '/'));
  if (!m) return null;
  return { device: m[1].toUpperCase(), root: m[2] === undefined ? null : Number(m[2]), rel: (m[3] || '').replace(/\/+$/, '') };
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
  constructor({ getMesh, poolDir, cacheDir, shareStore }) {
    this.getMesh = getMesh;
    this.poolDir = poolDir;
    this.cacheDir = cacheDir;
    this.shareStore = shareStore;
  }

  // ---- serving
  roots(peerId) {
    const extra = (this.shareStore.get(peerId) || []).filter((s) => s && s.path);
    return [{ name: 'File Pool', path: this.poolDir(), kind: 'pool' }, ...extra.map((s) => ({ name: s.name || path.basename(s.path), path: s.path, kind: 'folder' }))];
  }

  attach(mesh) {
    mesh.handle('files.roots', 'files', async (_a, from) => ({ roots: this.roots(from.id).map((r, i) => ({ index: i, name: r.name, kind: r.kind })) }));
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
    return [...m.peers.values()].filter((p) => m.conns.has(p.id)).map((p) => ({ id: p.id, name: p.label || p.name }));
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
  async download(url, target) {
    const r = parseRemote(url);
    if (!r || r.root === null || !r.rel) throw new Error('not a remote file');
    const m = this.mesh();
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.part`;
    const fh = await fsp.open(tmp, 'w');
    let mtime = null;
    try {
      let offset = 0;
      for (;;) {
        const c = await m.request(r.device, 'files.read', { root: r.root, rel: r.rel, offset, length: CHUNK }, 60000);
        const buf = Buffer.from(c.data || '', 'base64');
        if (buf.length) { await fh.write(buf, 0, buf.length, offset); offset += buf.length; }
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
    const target = path.join(this.cacheDir, r.device.slice(0, 15), String(r.root), ...r.rel.split('/'));
    return this.download(url, target);
  }

  // A small preview: start of a text file, or an image (up to 6 MB).
  async preview(url, nativeImage) {
    const r = parseRemote(url);
    if (!r || r.root === null || !r.rel) return { kind: 'folder' };
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

module.exports = { RemoteFiles, parseRemote, isRemote, remoteUrl, confine };
