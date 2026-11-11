const test = require('node:test');
const assert = require('node:assert');
const { readClip, writeClip, MAX_TEXT } = require('../src/main/clip-send');

const fakeImage = (png, w = 2, h = 3) => ({ isEmpty: () => !png, toPNG: () => png, getSize: () => ({ width: w, height: h }) });
function fakeClipboard({ text = '', html = '', image = null } = {}) {
  const c = { text, html, image, written: null };
  return {
    readImage: () => c.image || fakeImage(null),
    readText: () => c.text,
    readHTML: () => c.html,
    writeText: (t) => { c.written = { text: t }; },
    write: (o) => { c.written = o; },
    writeImage: (img) => { c.written = { image: img }; },
    state: c
  };
}
const nativeImage = { createFromBuffer: (buf) => fakeImage(buf.length ? buf : null, 4, 5) };

test('clipboard to device: text (with html) and images travel; empty and oversize refused', () => {
  const t = readClip(fakeClipboard({ text: 'hello  there', html: '<b>hello</b>' }));
  assert.deepStrictEqual(t, { kind: 'text', text: 'hello  there', html: '<b>hello</b>' });
  const dst = fakeClipboard();
  assert.strictEqual(writeClip(dst, nativeImage, t), 'hello there');
  assert.deepStrictEqual(dst.state.written, { text: 'hello  there', html: '<b>hello</b>' });

  const i = readClip(fakeClipboard({ image: fakeImage(Buffer.from('PNGDATA')) }));
  assert.strictEqual(i.kind, 'image');
  const dst2 = fakeClipboard();
  assert.strictEqual(writeClip(dst2, nativeImage, i), 'An image (4 × 5)');
  assert.ok(dst2.state.written.image);

  assert.strictEqual(readClip(fakeClipboard()), null, 'nothing to send');
  assert.throws(() => readClip(fakeClipboard({ text: 'x'.repeat(MAX_TEXT + 1) })), /too long/);
  assert.throws(() => writeClip(fakeClipboard(), nativeImage, { kind: 'exe', data: 'x' }), /unknown/);
  assert.throws(() => writeClip(fakeClipboard(), nativeImage, { kind: 'text', text: '' }), /bad text/);
});
