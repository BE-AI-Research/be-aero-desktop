const test = require('node:test');
const assert = require('node:assert');
const { parseXauthority, displayNumber, shapeRectanglesRequest, setupRequest, queryExtensionRequest } = require('../src/main/x11-input-shape');

test('X11: display numbers - local displays only', () => {
  assert.strictEqual(displayNumber(':0'), 0);
  assert.strictEqual(displayNumber(':1.0'), 1);
  assert.strictEqual(displayNumber('unix:2'), 2);
  assert.strictEqual(displayNumber('remote-host:0'), null);
  assert.strictEqual(displayNumber(''), null);
});

test('X11: Xauthority entries are read (wildcard family, MIT cookie)', () => {
  const s = (t) => { const b = Buffer.from(t, 'latin1'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
  const cookie = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const fam = Buffer.alloc(2); fam.writeUInt16BE(65535);
  const dl = Buffer.alloc(2); dl.writeUInt16BE(cookie.length);
  const file = Buffer.concat([fam, s(''), s('0'), s('MIT-MAGIC-COOKIE-1'), dl, cookie]);
  const [e] = parseXauthority(file);
  assert.deepStrictEqual({ family: e.family, number: e.number, name: e.name, data: e.data.toString('hex') },
    { family: 65535, number: '0', name: 'MIT-MAGIC-COOKIE-1', data: '00112233445566778899aabbccddeeff' });
});

test('X11: request encodings (setup, QueryExtension, SHAPE Rectangles Set/Input)', () => {
  const setup = setupRequest({ name: 'MIT-MAGIC-COOKIE-1', data: Buffer.alloc(16, 1) });
  assert.strictEqual(setup.length, 12 + 20 + 16);   // name padded 18 -> 20
  assert.strictEqual(setup.toString('latin1', 0, 1), 'l');
  assert.strictEqual(setup.readUInt16LE(2), 11);
  const q = queryExtensionRequest('SHAPE');
  assert.deepStrictEqual([q[0], q.readUInt16LE(2), q.readUInt16LE(4), q.toString('latin1', 8, 13)], [98, 4, 5, 'SHAPE']);
  const r = shapeRectanglesRequest(129, 0x800003, [{ x: 10, y: 20, width: 300, height: 200 }, { x: -5, y: 0, width: 40, height: 40 }]);
  assert.strictEqual(r.length, (4 + 2 * 2) * 4);
  assert.deepStrictEqual([r[0], r[1], r.readUInt16LE(2), r[4], r[5], r.readUInt32LE(8)], [129, 1, 8, 0, 2, 0x800003]);
  assert.deepStrictEqual([r.readInt16LE(16), r.readInt16LE(18), r.readUInt16LE(20), r.readUInt16LE(22)], [10, 20, 300, 200]);
  assert.strictEqual(r.readInt16LE(24), -5);
});
