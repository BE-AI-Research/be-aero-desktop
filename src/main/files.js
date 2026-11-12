// File browser service (main process): places, listing, file actions and
// the File Pool folder. The renderer's file widget asks for everything
// through IPC; nothing here reaches beyond what the user browses to.
//
// Copies and moves never overwrite: a name that exists gets " (2)", " (3)"...
// Deletes go to the Recycle Bin / Trash (shell.trashItem), never unlink.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const MAX_ENTRIES = 5000;
const TEXT_PREVIEW_BYTES = 64 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;
const TEXT_EXT = /\.(txt|md|markdown|log|json|js|mjs|cjs|ts|tsx|jsx|py|go|rs|c|h|cpp|hpp|cs|java|kt|sh|ps1|bat|cmd|ini|cfg|conf|toml|ya?ml|xml|html?|css|csv|sql|env)$/i;

// "report.pdf" in dir -> "report (2).pdf" if taken, and so on.
async function freeName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; i < 10000; i++) {
    try { await fsp.access(path.join(dir, candidate)); } catch { return candidate; }
    candidate = `${stem} (${i})${ext}`;
  }
  throw new Error('too many files with that name');
}

// A typed address -> an absolute path: "~", %VAR% (Windows), $VAR / ${VAR},
// file:/// URLs and surrounding quotes are understood.
function expandPath(input) {
  let p = String(input || '').trim().replace(/^"(.*)"$/, '$1');
  if (/^file:\/\//i.test(p)) { try { p = require('url').fileURLToPath(p); } catch { /* leave it */ } }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  p = p.replace(/%([A-Za-z0-9_()]+)%/g, (m, k) => (process.env[k] !== undefined ? process.env[k] : m));
  p = p.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, k) => (process.env[k] !== undefined ? process.env[k] : m));
  if (/^[a-z]:$/i.test(p)) p += '\\';                    // "D:" means the drive's root
  return path.resolve(p || os.homedir());
}

// True when `child` is `parent` or inside it.
function within(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The assistant's own folder (its work, and copies of files attached to
// chats in Uploads/). Settings ai.folder, default ~/BE-Aero AI.
function aiFolder(store) {
  const a = (store && store.get('ai')) || {};
  return a.folder || path.join(os.homedir(), 'BE-Aero AI');
}
async function ensureAiFolder(store) {
  const dir = aiFolder(store);
  await fsp.mkdir(path.join(dir, 'Uploads'), { recursive: true });
  const readme = path.join(dir, 'About this folder.txt');
  try { await fsp.access(readme); } catch {
    await fsp.writeFile(readme, 'This is the BE-Aero assistant\'s folder.\n\nFiles you attach to a chat are copied into Uploads, so the conversation keeps working if you move the original.\nThe assistant saves what it makes here (it can only write inside this folder).\nYou can change this folder in Settings > AI assistant.\n').catch(() => {});
  }
  return dir;
}

class FileService {
  // { getPath(name), store, shell, nativeImage, smb, remote }
  constructor({ getPath, store, shell, nativeImage, smb, remote }) {
    this.smb = smb || null;
    this.remote = remote || null;          // other devices (remote-files.js)
    this.getPath = getPath;
    this.store = store;
    this.shell = shell;
    this.nativeImage = nativeImage;
  }

  poolDir() {
    const s = this.store.get('files') || {};
    return s.poolDir || path.join(os.homedir(), 'BE-Aero Pool');
  }

  async ensurePool() {
    const dir = this.poolDir();
    await fsp.mkdir(dir, { recursive: true });
    const readme = path.join(dir, 'About the File Pool.txt');
    try { await fsp.access(readme); } catch {
      await fsp.writeFile(readme, 'This is your BE-Aero File Pool.\n\nAnything you put here is shared with your paired devices that have the "File Pool" permission (Settings > Devices).\nYou can change this folder in Settings > Files.\n').catch(() => {});
    }
    return dir;
  }

  // Sidebar places: user folders that exist, drives/mounts, the File Pool.
  async places() {
    const out = [
      { id: 'pool', name: 'File Pool', path: this.poolDir(), kind: 'pool' },
      { id: 'ai', name: 'AI Folder', path: aiFolder(this.store), kind: 'ai' }
    ];
    const user = [['home', 'Home'], ['desktop', 'Desktop'], ['documents', 'Documents'], ['downloads', 'Downloads'], ['pictures', 'Pictures'], ['music', 'Music'], ['videos', 'Videos']];
    for (const [key, name] of user) {
      try { const p = this.getPath(key); if (p && fs.existsSync(p)) out.push({ id: key, name, path: p, kind: 'folder' }); } catch { /* not on this OS */ }
    }
    // Network shares first known, so their drive letters are not listed twice.
    let net = [];
    try { net = this.smb ? await this.smb.connections() : []; } catch { net = []; }
    const netLetters = new Set(net.map((n) => (n.letter || '').charAt(0).toUpperCase()).filter(Boolean));
    if (process.platform === 'win32') {
      for (let c = 67; c <= 90; c++) {            // C: .. Z:
        const root = `${String.fromCharCode(c)}:\\`;
        if (netLetters.has(root[0])) continue;
        try { await fsp.access(root); out.push({ id: `drive-${root[0]}`, name: `${root[0]}:`, path: root, kind: 'drive' }); } catch { /* none */ }
      }
    } else {
      out.push({ id: 'root', name: 'Computer', path: '/', kind: 'drive' });
      for (const base of [`/media/${os.userInfo().username}`, '/mnt', `/run/media/${os.userInfo().username}`]) {
        let names = [];
        try { names = await fsp.readdir(base); } catch { continue; }
        for (const n of names) out.push({ id: `mount-${base}/${n}`, name: n, path: path.join(base, n), kind: 'drive' });
      }
    }
    for (const n of net) out.push({ id: `net-${n.remote}`, name: n.letter ? `${n.name} (${n.letter})` : n.name, path: n.path, remote: n.remote, status: n.status, kind: 'network' });
    for (const d of (this.remote ? this.remote.devices() : [])) out.push({ id: `dev-${d.id}`, name: d.name, path: `aero://${d.id}`, kind: 'device', ...(d.relay ? { relay: true } : {}) });
    return out;
  }

  async list(dir) {
    if (this.remote && require('./remote-files').isRemote(dir)) return this.remote.list(dir);
    // A server on its own (\\server, smb://server): its shares, as folders.
    const net = this.smb ? require('./smb').parseAddress(dir) : null;
    if (net && !net.share) {
      const shares = await this.smb.shares(net.server);
      const win = process.platform === 'win32';
      return {
        path: win ? `\\\\${net.server}` : `smb://${net.server}`, parent: null, server: net.server, inPool: false, truncated: false,
        entries: shares.map((s) => ({ name: s, path: win ? `\\\\${net.server}\\${s}` : `smb://${net.server}/${s}`, dir: true, size: null, mtime: null, hidden: false, link: false, kind: 'share' }))
      };
    }
    // smb:// on Linux: the gvfs folder when mounted; otherwise ask to connect.
    if (net && process.platform !== 'win32') {
      const conns = await this.smb.connections();
      const hit = conns.find((c) => { const a = require('./smb').parseAddress(c.remote); return a && a.server.toLowerCase() === net.server.toLowerCase() && a.share.toLowerCase() === net.share.toLowerCase(); });
      if (!hit) { const e = new Error('needs sign-in'); e.code = 'NEEDS_CONNECT'; throw e; }
      dir = path.join(hit.path, net.rest || '');
    }
    const abs = expandPath(dir || os.homedir());
    if (within(aiFolder(this.store), abs)) await ensureAiFolder(this.store);
    let st;
    try { st = await fsp.stat(abs); } catch (err) {
      // A share that wants a sign-in first (Windows UNC).
      if (net && /EPERM|EACCES|ENOENT|UNKNOWN|EBUSY/.test(String(err && err.code))) { const e = new Error('needs sign-in'); e.code = 'NEEDS_CONNECT'; throw e; }
      throw new Error(`"${String(dir).trim()}" was not found.`);
    }
    if (!st.isDirectory()) throw new Error(`"${path.basename(abs)}" is a file, not a folder.`);
    if (within(this.poolDir(), abs)) await this.ensurePool();
    const dirents = await fsp.readdir(abs, { withFileTypes: true });
    const entries = [];
    for (const d of dirents.slice(0, MAX_ENTRIES)) {
      const p = path.join(abs, d.name);
      let st = null;
      try { st = await fsp.stat(p); } catch { /* broken link, no access */ }
      const isDir = st ? st.isDirectory() : d.isDirectory();
      entries.push({
        name: d.name, path: p, dir: isDir,
        size: st && !isDir ? st.size : null,
        mtime: st ? st.mtimeMs : null,
        hidden: d.name.startsWith('.') || /^(desktop\.ini|thumbs\.db|\$recycle\.bin|system volume information)$/i.test(d.name),
        link: d.isSymbolicLink(),
        kind: isDir ? 'folder' : IMAGE_EXT.test(d.name) ? 'image' : TEXT_EXT.test(d.name) ? 'text' : 'file'
      });
    }
    const parent = path.dirname(abs);
    return { path: abs, parent: parent !== abs ? parent : null, entries, truncated: dirents.length > MAX_ENTRIES, inPool: within(this.poolDir(), abs) };
  }

  // '' on success, else an error string. A file on another device is
  // fetched to a local cache first.
  async open(p) {
    if (this.remote && require('./remote-files').isRemote(p)) {
      try { return this.shell.openPath(await this.remote.cached(p)); } catch (err) { return String(err.message || err); }
    }
    return this.shell.openPath(path.resolve(p));
  }
  readOnly(p) {
    if (this.remote && require('./remote-files').isRemote(p) && !this.remote.writable(p)) {
      throw new Error('Folders on other devices are read-only from here. Copy files to this computer, the File Pool, or Shared storage on your relay.');
    }
  }
  onRelay(p) { return !!(this.remote && require('./remote-files').isRemote(p) && this.remote.writable(p)); }
  reveal(p) { this.shell.showItemInFolder(path.resolve(p)); return true; }

  async mkdir(dir, name) {
    this.readOnly(dir);
    if (this.onRelay(dir)) return this.remote.mkdir(dir, name);
    const n = String(name || 'New folder').replace(/[\\/:*?"<>|]/g, '').trim() || 'New folder';
    const target = path.join(path.resolve(dir), await freeName(path.resolve(dir), n));
    await fsp.mkdir(target);
    return target;
  }

  async rename(p, name) {
    this.readOnly(p);
    if (this.onRelay(p)) return this.remote.rename(p, name);
    const n = String(name || '').trim();
    if (!n || /[\\/]/.test(n) || (process.platform === 'win32' && /[:*?"<>|]/.test(n))) throw new Error('That name is not allowed.');
    const target = path.join(path.dirname(path.resolve(p)), n);
    if (target === path.resolve(p)) return target;
    try { await fsp.access(target); throw new Error(`"${n}" already exists here.`); } catch (err) { if (err.message.includes('already exists')) throw err; }
    await fsp.rename(path.resolve(p), target);
    return target;
  }

  async trash(paths) {
    for (const p of [].concat(paths || [])) this.readOnly(p);
    // Shared storage on the relay has no Recycle Bin: removed for good.
    const relayed = [].concat(paths || []).filter((p) => this.onRelay(p));
    if (relayed.length) await this.remote.remove(relayed);
    paths = [].concat(paths || []).filter((p) => !this.onRelay(p));
    const done = [];
    for (const p of [].concat(paths || [])) { await this.shell.trashItem(path.resolve(p)); done.push(p); }
    return done;
  }

  // Copy (or move) each source into destDir, never overwriting.
  async transfer(paths, destDir, { move = false } = {}) {
    this.readOnly(destDir);
    // Into Shared storage on the relay: encrypted and uploaded (always a copy).
    if (this.onRelay(destDir)) return this.remote.put(paths, destDir);
    const dest = path.resolve(destDir);
    const results = [];
    for (const src of [].concat(paths || [])) {
      // From another device: download (always a copy, never a move).
      if (this.remote && require('./remote-files').isRemote(src)) {
        const name = require('./remote-files').remoteName(src);
        results.push(await this.remote.download(src, path.join(dest, await freeName(dest, name))));
        continue;
      }
      const from = path.resolve(src);
      if (within(from, dest)) throw new Error(`Cannot put "${path.basename(from)}" inside itself.`);
      if (path.dirname(from) === dest && move) { results.push(from); continue; }       // already there
      const target = path.join(dest, await freeName(dest, path.basename(from)));
      if (move) {
        try { await fsp.rename(from, target); } catch (err) {
          if (err.code !== 'EXDEV') throw err;                                      // another drive: copy, then remove
          await fsp.cp(from, target, { recursive: true, errorOnExist: true, force: false });
          await this.shell.trashItem(from);
        }
      } else {
        await fsp.cp(from, target, { recursive: true, errorOnExist: true, force: false });
      }
      results.push(target);
    }
    return results;
  }

  // Small preview: an image thumbnail (data URL) or the start of a text file.
  async preview(p) {
    if (this.remote && require('./remote-files').isRemote(p)) return this.remote.preview(p, this.nativeImage);
    const abs = path.resolve(p);
    const st = await fsp.stat(abs);
    if (st.isDirectory()) return { kind: 'folder' };
    if (IMAGE_EXT.test(abs) && st.size < 40 * 1024 * 1024) {
      let img = null;
      try { img = await this.nativeImage.createThumbnailFromPath(abs, { width: 320, height: 240 }); } catch { img = null; }
      if (!img || img.isEmpty()) { img = this.nativeImage.createFromPath(abs); if (!img.isEmpty()) img = img.resize({ width: Math.min(320, img.getSize().width) }); }
      return img && !img.isEmpty() ? { kind: 'image', dataUrl: img.toDataURL(), size: st.size } : { kind: 'file', size: st.size };
    }
    if (TEXT_EXT.test(abs) || st.size < 4096) {
      const fh = await fsp.open(abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(TEXT_PREVIEW_BYTES, st.size));
        await fh.read(buf, 0, buf.length, 0);
        if (buf.includes(0)) return { kind: 'file', size: st.size };            // binary
        return { kind: 'text', text: buf.toString('utf8'), truncated: st.size > buf.length, size: st.size };
      } finally { await fh.close(); }
    }
    return { kind: 'file', size: st.size };
  }

  async icon(p, size = 'small') {
    if (require('./remote-files').isRemote(p)) return null;
    try {
      const img = await require('electron').app.getFileIcon(path.resolve(p), { size: ['small', 'normal', 'large'].includes(size) ? size : 'small' });
      return img.isEmpty() ? null : img.toDataURL();
    } catch { return null; }
  }
}

module.exports = { FileService, freeName, within, expandPath, aiFolder, ensureAiFolder };
