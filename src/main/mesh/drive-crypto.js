// Encryption for the relay's storage (Shared storage and the File Pool copy):
// every file is encrypted on my devices with a key only my devices share, so
// the relay holds opaque blobs - it never sees names, sizes of folders, or
// content.
//
//   chunk:  AES-256-GCM, a fresh 12-byte nonce per chunk: nonce | ciphertext | tag
//   meta:   { k: keyId, d: base64(chunk(JSON)) } - path, size, mtime, hash
//   keys:   a keyring ({ id, key, created }); new files use the OLDEST key, so
//           two devices that each made one end up agreeing. Kept encrypted
//           with the OS keyring (protect), like the device key.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PLAIN_CHUNK = 1024 * 1024;
const OVERHEAD = 12 + 16;
const ENC_CHUNK = PLAIN_CHUNK + OVERHEAD;

function encryptChunk(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

function decryptChunk(key, buf) {
  if (buf.length < OVERHEAD) throw new Error('chunk too short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
}

function sealMeta(keyId, key, obj) {
  return Buffer.from(JSON.stringify({ k: keyId, d: encryptChunk(key, Buffer.from(JSON.stringify(obj))).toString('base64') })).toString('base64');
}

// -> the metadata, or null when it was made with a key we do not have.
function openMeta(keyring, b64) {
  let env;
  try { env = JSON.parse(Buffer.from(String(b64 || ''), 'base64').toString('utf8')); } catch { return null; }
  const key = env && keyring.get(env.k);
  if (!key) return null;
  try { return { ...JSON.parse(decryptChunk(key, Buffer.from(env.d, 'base64')).toString('utf8')), keyId: env.k }; } catch { return null; }
}

// Encrypted size of a file of `size` bytes.
function encryptedSize(size) { return size === 0 ? 0 : size + Math.ceil(size / PLAIN_CHUNK) * OVERHEAD; }

class DriveKeyring {
  // { file, protect: { available(), encrypt(Buffer|string) -> Buffer, decrypt(Buffer) -> string } }
  constructor({ file, protect = null }) {
    this.file = file;
    this.protect = protect;
    this.keys = new Map();      // id -> { key: Buffer, created }
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file);
      const text = this.protect && this.protect.available() && raw[0] !== 0x7b ? this.protect.decrypt(raw) : raw.toString('utf8');
      for (const k of JSON.parse(text)) if (k && k.id && k.key) this.keys.set(k.id, { key: Buffer.from(k.key, 'base64'), created: Number(k.created) || 0 });
    } catch { /* none yet */ }
  }

  save() {
    const text = JSON.stringify(this.export());
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const data = this.protect && this.protect.available() ? this.protect.encrypt(text) : Buffer.from(text);
    fs.writeFileSync(this.file, data, { mode: 0o600 });
  }

  export() { return [...this.keys].map(([id, k]) => ({ id, key: k.key.toString('base64'), created: k.created })); }
  get(id) { const k = this.keys.get(id); return k ? k.key : null; }
  has() { return this.keys.size > 0; }

  // The key new files use: the oldest one (so every device agrees).
  current() {
    const list = [...this.keys].sort((a, b) => (a[1].created - b[1].created) || (a[0] < b[0] ? -1 : 1));
    return list.length ? { id: list[0][0], key: list[0][1].key } : null;
  }

  create() {
    const id = crypto.randomBytes(8).toString('hex');
    this.keys.set(id, { key: crypto.randomBytes(32), created: Date.now() });
    this.save();
    return this.current();
  }

  // Keys from another of my devices. -> how many were new.
  merge(list) {
    let added = 0;
    for (const k of Array.isArray(list) ? list : []) {
      if (!k || typeof k.id !== 'string' || !/^[a-f0-9]{16}$/.test(k.id) || this.keys.has(k.id)) continue;
      const key = Buffer.from(String(k.key || ''), 'base64');
      if (key.length !== 32) continue;
      this.keys.set(k.id, { key, created: Number(k.created) || Date.now() });
      added++;
    }
    if (added) this.save();
    return added;
  }
}

module.exports = { encryptChunk, decryptChunk, sealMeta, openMeta, encryptedSize, DriveKeyring, PLAIN_CHUNK, ENC_CHUNK, OVERHEAD };
