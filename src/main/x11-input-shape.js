// X11 input shape (Linux): where a window takes mouse input.
//
// Electron's BrowserWindow.setShape sets the BOUNDING shape (what is drawn).
// On plain X11 that also limits input, but Xwayland - every X11 app under a
// Wayland session such as GNOME - builds the surface's input region from the
// INPUT shape alone, which stays the whole window. So the transparent
// free-form canvas swallowed every click on the screen. Electron has no API
// for the input shape and the app ships no native modules, so this speaks
// the one request needed - SHAPE Rectangles(Set, Input) - over the X11
// socket directly: connection setup with the MIT cookie from XAUTHORITY,
// QueryExtension("SHAPE"), then a Rectangles request per change.
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SHAPE_KIND_INPUT = 2;
const SHAPE_OP_SET = 0;
const SHAPE_RECTANGLES = 1;     // minor opcode
const QUERY_EXTENSION = 98;     // core opcode

// ":0", ":1.0", "unix:0" -> 0; anything remote -> null (only local sockets).
function displayNumber(display) {
  const m = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(String(display || '').trim());
  return m ? Number(m[1]) : null;
}

// Xauthority entries: family(2) addr(2+n) number(2+n) name(2+n) data(2+n), big-endian lengths.
function parseXauthority(buf) {
  const out = [];
  let o = 0;
  const str = () => { const n = buf.readUInt16BE(o); o += 2; const b = buf.subarray(o, o + n); o += n; return b; };
  try {
    while (o + 2 <= buf.length) {
      const family = buf.readUInt16BE(o); o += 2;
      const address = str().toString('latin1');
      const number = str().toString('latin1');
      const name = str().toString('latin1');
      const data = str();
      out.push({ family, address, number, name, data });
    }
  } catch { /* truncated: keep what was read */ }
  return out;
}

function cookieFor(dpyNum, xauthority) {
  const file = xauthority || path.join(os.homedir(), '.Xauthority');
  let entries = [];
  try { entries = parseXauthority(fs.readFileSync(file)); } catch { return null; }
  const host = os.hostname();
  const ok = (e) => e.name === 'MIT-MAGIC-COOKIE-1' && (e.number === '' || e.number === String(dpyNum));
  // Local (256) for this host first, then wildcard (65535) - mutter's
  // Xwayland auth file uses the wildcard family - then anything that fits.
  const pick = entries.find((e) => ok(e) && e.family === 256 && e.address === host)
    || entries.find((e) => ok(e) && e.family === 65535)
    || entries.find(ok);
  return pick ? { name: pick.name, data: pick.data } : null;
}

const pad4 = (n) => (4 - (n % 4)) % 4;

function setupRequest(auth) {
  const name = Buffer.from(auth ? auth.name : '', 'latin1');
  const data = auth ? auth.data : Buffer.alloc(0);
  const b = Buffer.alloc(12 + name.length + pad4(name.length) + data.length + pad4(data.length));
  b.write('l', 0, 'latin1');            // little-endian
  b.writeUInt16LE(11, 2);               // protocol 11.0
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(name.length, 6);
  b.writeUInt16LE(data.length, 8);
  name.copy(b, 12);
  data.copy(b, 12 + name.length + pad4(name.length));
  return b;
}

function queryExtensionRequest(ext) {
  const name = Buffer.from(ext, 'latin1');
  const len = 2 + Math.ceil(name.length / 4);
  const b = Buffer.alloc(len * 4);
  b.writeUInt8(QUERY_EXTENSION, 0);
  b.writeUInt16LE(len, 2);
  b.writeUInt16LE(name.length, 4);
  name.copy(b, 8);
  return b;
}

// SHAPE Rectangles: op Set, kind Input, unsorted, on window `xid`.
function shapeRectanglesRequest(major, xid, rects) {
  const len = 4 + 2 * rects.length;
  const b = Buffer.alloc(len * 4);
  b.writeUInt8(major, 0);
  b.writeUInt8(SHAPE_RECTANGLES, 1);
  b.writeUInt16LE(len, 2);
  b.writeUInt8(SHAPE_OP_SET, 4);
  b.writeUInt8(SHAPE_KIND_INPUT, 5);
  b.writeUInt8(0, 6);                   // ordering: unsorted
  b.writeUInt32LE(xid >>> 0, 8);
  b.writeInt16LE(0, 12);                // x offset
  b.writeInt16LE(0, 14);                // y offset
  rects.forEach((r, i) => {
    const o = 16 + i * 8;
    b.writeInt16LE(Math.max(-32768, Math.min(32767, r.x | 0)), o);
    b.writeInt16LE(Math.max(-32768, Math.min(32767, r.y | 0)), o + 2);
    b.writeUInt16LE(Math.max(0, Math.min(65535, r.width | 0)), o + 4);
    b.writeUInt16LE(Math.max(0, Math.min(65535, r.height | 0)), o + 6);
  });
  return b;
}

function internAtomRequest(name) {
  const b = Buffer.from(name, 'latin1');
  const len = 2 + Math.ceil(b.length / 4);
  const r = Buffer.alloc(len * 4);
  r.writeUInt8(16, 0);                  // InternAtom
  r.writeUInt8(0, 1);                   // only-if-exists: no
  r.writeUInt16LE(len, 2);
  r.writeUInt16LE(b.length, 4);
  b.copy(r, 8);
  return r;
}

// EWMH: ask the window manager to add (1) or remove (0) a state such as
// _NET_WM_STATE_BELOW - SendEvent of a ClientMessage to the root window.
function wmStateRequest(root, xid, netWmState, action, atom1, atom2 = 0) {
  const r = Buffer.alloc(44);
  r.writeUInt8(25, 0);                  // SendEvent
  r.writeUInt8(0, 1);                   // propagate: no
  r.writeUInt16LE(11, 2);
  r.writeUInt32LE(root >>> 0, 4);
  r.writeUInt32LE(((1 << 19) | (1 << 20)) >>> 0, 8);   // SubstructureNotify | SubstructureRedirect
  const e = 12;                         // the 32-byte event
  r.writeUInt8(33, e);                  // ClientMessage
  r.writeUInt8(32, e + 1);              // format 32
  r.writeUInt32LE(xid >>> 0, e + 4);
  r.writeUInt32LE(netWmState >>> 0, e + 8);
  r.writeUInt32LE(action, e + 12);
  r.writeUInt32LE(atom1 >>> 0, e + 16);
  r.writeUInt32LE(atom2 >>> 0, e + 20);
  r.writeUInt32LE(1, e + 24);           // source: a normal application
  return r;
}

// The first screen's root window, from the connection setup reply.
function rootFromSetup(reply) {
  const vendorLen = reply.readUInt16LE(24);
  const formats = reply.readUInt8(29);
  const screens = 40 + vendorLen + pad4(vendorLen) + 8 * formats;
  return reply.length >= screens + 4 ? reply.readUInt32LE(screens) : 0;
}

class X11InputShape {
  // { display, xauthority, log }
  constructor({ display = process.env.DISPLAY, xauthority = process.env.XAUTHORITY, log = () => {} } = {}) {
    this.display = display;
    this.xauthority = xauthority;
    this.log = log;
    this.sock = null;
    this.major = 0;             // SHAPE extension opcode (0 = none)
    this.root = 0;
    this.seq = 0;               // sequence number of the last request sent
    this.waiting = new Map();   // seq -> resolve(reply | null)
    this.atoms = new Map();
    this.ready = null;          // Promise<boolean>
    this.failed = false;
  }

  // Send a request; with `reply`, resolve with its reply packet (null on error).
  request(buf, reply = false) {
    if (!this.sock) return Promise.resolve(null);
    this.seq = (this.seq + 1) & 0xffff;
    const seq = this.seq;
    this.sock.write(buf);
    if (!reply) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.waiting.set(seq, resolve);
      setTimeout(() => { if (this.waiting.delete(seq)) resolve(null); }, 3000);
    });
  }

  onPacket(pkt) {
    const type = pkt[0];
    if (type === 1 || type === 0) {
      const seq = pkt.readUInt16LE(2);
      const w = this.waiting.get(seq);
      if (w) { this.waiting.delete(seq); w(type === 1 ? pkt : null); }
      if (type === 0 && !w) this.log(`X11 error ${pkt[1]} on request ${pkt.readUInt8(10)}.${pkt.readUInt16LE(8)}`);
    }
    // events (type > 1) were not asked for; ignore
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve) => {
      const n = displayNumber(this.display);
      if (n === null) { this.fail(`DISPLAY "${this.display}" is not a local display`); resolve(false); return; }
      const auth = cookieFor(n, this.xauthority);
      let buf = Buffer.alloc(0);
      let setupDone = false;
      const done = (ok, why) => { if (!ok) this.fail(why); resolve(ok); };
      const drain = () => {
        while (buf.length >= 32) {
          const extra = buf[0] === 1 ? buf.readUInt32LE(4) * 4 : 0;
          if (buf.length < 32 + extra) return;
          const pkt = buf.subarray(0, 32 + extra);
          buf = buf.subarray(32 + extra);
          this.onPacket(pkt);
        }
      };
      const tryConnect = (addr, next) => {
        const s = net.createConnection(addr);
        s.once('error', () => { s.destroy(); next(); });
        s.once('connect', () => {
          s.removeAllListeners('error');
          this.sock = s;
          s.on('error', (e) => this.fail(`socket: ${e.message}`));
          s.on('close', () => {
            this.sock = null;
            this.ready = null;          // reconnect on next use
            for (const w of this.waiting.values()) w(null);
            this.waiting.clear();
          });
          s.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (!setupDone) {
              if (buf.length < 8) return;
              const extra = buf.readUInt16LE(6) * 4;
              if (buf.length < 8 + extra) return;
              const status = buf[0];
              const reply = buf.subarray(0, 8 + extra);
              buf = buf.subarray(8 + extra);
              if (status !== 1) { done(false, `X server refused the connection (status ${status}${auth ? '' : ', no cookie found'})`); s.destroy(); return; }
              setupDone = true;
              this.root = rootFromSetup(reply);
              this.request(queryExtensionRequest('SHAPE'), true).then((q) => {
                if (!q || !q[8]) this.log('the X server has no SHAPE extension');
                else this.major = q[9];
                done(true);
              });
            }
            drain();
          });
          s.write(setupRequest(auth));
        });
      };
      // Filesystem socket first, then Linux's abstract one.
      tryConnect(`/tmp/.X11-unix/X${n}`, () => tryConnect(`\0/tmp/.X11-unix/X${n}`, () => done(false, `no X11 socket for display :${n}`)));
    });
    return this.ready;
  }

  fail(why) {
    if (!this.failed) this.log(`X11 control unavailable: ${why}`);
    this.failed = true;
  }

  async atom(name) {
    if (this.atoms.has(name)) return this.atoms.get(name);
    const r = await this.request(internAtomRequest(name), true);
    const a = r ? r.readUInt32LE(8) : 0;
    if (a) this.atoms.set(name, a);
    return a;
  }

  // Window input region := rects (window coordinates). An empty list means
  // "no input anywhere", so callers pass the full window to take everything.
  async set(xid, rects) {
    if (!xid) return false;
    if (!(await this.connect()) || !this.sock || !this.major) return false;
    const list = (rects || []).filter((r) => r && r.width > 0 && r.height > 0);
    await this.request(shapeRectanglesRequest(this.major, xid, list));
    return true;
  }

  // Keep the window below all others (_NET_WM_STATE_BELOW) - the desktop
  // layer, where widgets live behind app windows - or lift it out again.
  async keepBelow(xid, on) {
    if (!xid) return false;
    if (!(await this.connect()) || !this.sock || !this.root) return false;
    const state = await this.atom('_NET_WM_STATE');
    const below = await this.atom('_NET_WM_STATE_BELOW');
    if (!state || !below) return false;
    await this.request(wmStateRequest(this.root, xid, state, on ? 1 : 0, below));
    return true;
  }

  close() { if (this.sock) { this.sock.destroy(); this.sock = null; } }
}

// Electron's native handle on X11 is the XID (unsigned long, little-endian).
function xidOf(win) {
  try {
    const h = win.getNativeWindowHandle();
    return h.length >= 8 ? Number(h.readBigUInt64LE(0) & 0xffffffffn) : h.readUInt32LE(0);
  } catch { return 0; }
}

module.exports = { X11InputShape, xidOf, parseXauthority, displayNumber, shapeRectanglesRequest, setupRequest, queryExtensionRequest, internAtomRequest, wmStateRequest, rootFromSetup };
