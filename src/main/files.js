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

class FileService {
  // { getPath(name), store, shell, nativeImage }
  constructor({ getPath, store, shell, nativeImage }) {
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
    const out = [{ id: 'pool', name: 'File Pool', path: this.poolDir(), kind: 'pool' }];
    const user = [['home', 'Home'], ['desktop', 'Desktop'], ['documents', 'Documents'], ['downloads', 'Downloads'], ['pictures', 'Pictures'], ['music', 'Music'], ['videos', 'Videos']];
    for (const [key, name] of user) {
      try { const p = this.getPath(key); if (p && fs.existsSync(p)) out.push({ id: key, name, path: p, kind: 'folder' }); } catch { /* not on this OS */ }
    }
    if (process.platform === 'win32') {
      for (let c = 67; c <= 90; c++) {            // C: .. Z:
        const root = `${String.fromCharCode(c)}:\\`;
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
    return out;
  }

  async list(dir) {
    const abs = expandPath(dir || os.homedir());
    let st;
    try { st = await fsp.stat(abs); } catch { throw new Error(`"${String(dir).trim()}" was not found.`); }
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

  open(p) { return this.shell.openPath(path.resolve(p)); }          // '' on success, else an error string
  reveal(p) { this.shell.showItemInFolder(path.resolve(p)); return true; }

  async mkdir(dir, name) {
    const n = String(name || 'New folder').replace(/[\\/:*?"<>|]/g, '').trim() || 'New folder';
    const target = path.join(path.resolve(dir), await freeName(path.resolve(dir), n));
    await fsp.mkdir(target);
    return target;
  }

  async rename(p, name) {
    const n = String(name || '').trim();
    if (!n || /[\\/]/.test(n) || (process.platform === 'win32' && /[:*?"<>|]/.test(n))) throw new Error('That name is not allowed.');
    const target = path.join(path.dirname(path.resolve(p)), n);
    if (target === path.resolve(p)) return target;
    try { await fsp.access(target); throw new Error(`"${n}" already exists here.`); } catch (err) { if (err.message.includes('already exists')) throw err; }
    await fsp.rename(path.resolve(p), target);
    return target;
  }

  async trash(paths) {
    const done = [];
    for (const p of [].concat(paths || [])) { await this.shell.trashItem(path.resolve(p)); done.push(p); }
    return done;
  }

  // Copy (or move) each source into destDir, never overwriting.
  async transfer(paths, destDir, { move = false } = {}) {
    const dest = path.resolve(destDir);
    const results = [];
    for (const src of [].concat(paths || [])) {
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

  async icon(p) {
    try { const img = await require('electron').app.getFileIcon(path.resolve(p), { size: 'small' }); return img.toDataURL(); } catch { return null; }
  }
}

module.exports = { FileService, freeName, within, expandPath };
