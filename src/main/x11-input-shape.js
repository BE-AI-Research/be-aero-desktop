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

class X11InputShape {
  // { display, xauthority, log }
  constructor({ display = process.env.DISPLAY, xauthority = process.env.XAUTHORITY, log = () => {} } = {}) {
    this.display = display;
    this.xauthority = xauthority;
    this.log = log;
    this.sock = null;
    this.major = 0;
    this.ready = null;      // Promise<boolean>
    this.failed = false;
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve) => {
      const n = displayNumber(this.display);
      if (n === null) { this.fail(`DISPLAY "${this.display}" is not a local display`); resolve(false); return; }
      const auth = cookieFor(n, this.xauthority);
      let buf = Buffer.alloc(0);
      let stage = 'setup';
      const done = (ok, why) => { if (!ok) this.fail(why); resolve(ok); };
      const tryConnect = (addr, next) => {
        const s = net.createConnection(addr);
        s.once('error', () => { s.destroy(); next(); });
        s.once('connect', () => {
          s.removeAllListeners('error');
          this.sock = s;
          s.on('error', (e) => this.fail(`socket: ${e.message}`));
          s.on('close', () => { this.sock = null; });
          s.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (stage === 'setup') {
              if (buf.length < 8) return;
              const extra = buf.readUInt16LE(6) * 4;
              if (buf.length < 8 + extra) return;
              const status = buf[0];
              buf = buf.subarray(8 + extra);
              if (status !== 1) { done(false, `X server refused the connection (status ${status}${auth ? '' : ', no cookie found'})`); s.destroy(); return; }
              stage = 'ext';
              s.write(queryExtensionRequest('SHAPE'));
            }
            if (stage === 'ext') {
              // Skip events / errors until the 32-byte QueryExtension reply.
              while (buf.length >= 32) {
                const type = buf[0];
                const extra = type === 1 ? buf.readUInt32LE(4) * 4 : 0;
                if (buf.length < 32 + extra) return;
                const pkt = buf.subarray(0, 32 + extra);
                buf = buf.subarray(32 + extra);
                if (type === 1) {
                  stage = 'run';
                  if (!pkt[8]) { done(false, 'the X server has no SHAPE extension'); return; }
                  this.major = pkt[9];
                  done(true);
                  return;
                }
              }
            }
            if (stage === 'run') {
              // Errors from our requests: log once each kind, never throw.
              while (buf.length >= 32) {
                const pkt = buf.subarray(0, 32);
                buf = buf.subarray(32);
                if (pkt[0] === 0) this.log(`X11 error ${pkt[1]} on request ${pkt.readUInt8(10)}.${pkt.readUInt16LE(8)}`);
              }
            }
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
    if (!this.failed) this.log(`input shape unavailable: ${why}`);
    this.failed = true;
  }

  // Window input region := rects (window coordinates). An empty list means
  // "no input anywhere", so callers pass the full window to take everything.
  async set(xid, rects) {
    if (!xid) return false;
    if (!(await this.connect()) || !this.sock) return false;
    const list = (rects || []).filter((r) => r && r.width > 0 && r.height > 0);
    this.sock.write(shapeRectanglesRequest(this.major, xid, list));
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

module.exports = { X11InputShape, xidOf, parseXauthority, displayNumber, shapeRectanglesRequest, setupRequest, queryExtensionRequest };
