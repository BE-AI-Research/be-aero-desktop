// Generates build/icon.png (256px) and build/icon.ico (16-256px, PNG-compressed)
// with no external dependencies. The design is a glassy rounded tile with a
// sky-blue clock ring and hands, matching the widget palette.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'build');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const clamp = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;

// Signed distance helpers (in unit space 0..1).
function roundedRectSD(x, y, r) {
  const qx = Math.abs(x - 0.5) - (0.5 - r);
  const qy = Math.abs(y - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function segmentSD(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function over(dst, src, a) {
  const outA = a + dst[3] * (1 - a);
  if (outA <= 0) return [0, 0, 0, 0];
  return [
    (src[0] * a + dst[0] * dst[3] * (1 - a)) / outA,
    (src[1] * a + dst[1] * dst[3] * (1 - a)) / outA,
    (src[2] * a + dst[2] * dst[3] * (1 - a)) / outA,
    outA
  ];
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const aa = 1.2 / size;
  const cov = (d) => clamp(0.5 - d / aa);
  const cx = 0.5, cy = 0.5;
  const hourAng = (-60 * Math.PI) / 180;   // ~10 o'clock
  const minAng = (60 * Math.PI) / 180;     // ~2 o'clock
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      let c = [0, 0, 0, 0];

      // Tile background: deep blue -> purple gradient
      const tile = roundedRectSD(x, y, 0.22);
      const tA = cov(tile + 0.02);
      if (tA > 0) {
        const t = clamp((x + y) / 2);
        c = over(c, [mix(28, 70, t), mix(60, 30, t), mix(140, 120, t)], tA);
        // Glass sheen on the upper-left
        const sheen = clamp(1 - (x + y) * 1.1) * 0.35;
        c = over(c, [255, 255, 255], sheen * tA);
        // Edge highlight
        const edge = cov(Math.abs(tile + 0.025) - 0.008) * 0.45;
        c = over(c, [255, 255, 255], edge);
      }

      // Clock face
      const dr = Math.hypot(x - cx, y - cy);
      c = over(c, [255, 255, 255], cov(dr - 0.30) * 0.12);
      c = over(c, [56, 189, 248], cov(Math.abs(dr - 0.30) - 0.028));

      // Hands
      const hx = cx + Math.sin(hourAng) * 0.15, hy = cy - Math.cos(hourAng) * 0.15;
      const mx = cx + Math.sin(minAng) * 0.22, my = cy - Math.cos(minAng) * 0.22;
      c = over(c, [255, 255, 255], cov(segmentSD(x, y, cx, cy, hx, hy) - 0.03));
      c = over(c, [226, 232, 240], cov(segmentSD(x, y, cx, cy, mx, my) - 0.022));
      c = over(c, [192, 132, 252], cov(dr - 0.045));

      const i = (py * size + px) * 4;
      buf[i] = Math.round(c[0]); buf[i + 1] = Math.round(c[1]);
      buf[i + 2] = Math.round(c[2]); buf[i + 3] = Math.round(c[3] * 255);
    }
  }
  return encodePng(size, buf);
}

function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

fs.mkdirSync(OUT, { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => ({ size, data: render(size) }));
fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[pngs.length - 1].data);
fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeIco(pngs));
console.log('Wrote build/icon.png and build/icon.ico');
