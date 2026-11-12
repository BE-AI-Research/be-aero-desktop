const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Transfers } = require('../src/main/transfers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(20); } return false; }

test('transfers: copy a folder tree with progress; pause, resume; move is a rename on the same drive', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-xfer-'));
  try {
    const src = path.join(base, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
    fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'hello');
    const dest = path.join(base, 'dest');
    const updates = [];
    const t = new Transfers({ trash: async (p) => fs.rmSync(p, { recursive: true, force: true }), onChange: (l) => updates.push(l) });
    const id = t.start([src], dest);
    // pause straight away, check nothing finishes, then resume
    t.pause(id);
    await sleep(150);
    const paused = t.list().find((j) => j.id === id);
    assert.strictEqual(paused.state, 'paused');
    t.resume(id);
    assert.ok(await until(() => t.list().find((j) => j.id === id).state === 'done'));
    const j = t.list().find((x) => x.id === id);
    assert.strictEqual(j.total, 3 * 1024 * 1024 + 5);
    assert.strictEqual(j.done, j.total);
    assert.strictEqual(j.files, 2);
    assert.strictEqual(j.filesDone, 2);
    assert.strictEqual(fs.readFileSync(path.join(dest, 'src', 'sub', 'b.txt'), 'utf8'), 'hello');
    assert.strictEqual(fs.statSync(path.join(dest, 'src', 'a.bin')).size, 3 * 1024 * 1024);
    // copying again does not overwrite: a free name
    const id2 = t.start([path.join(src, 'sub', 'b.txt')], path.join(dest, 'src', 'sub'));
    assert.ok(await until(() => t.list().find((x) => x.id === id2).state === 'done'));
    assert.ok(fs.existsSync(path.join(dest, 'src', 'sub', 'b (2).txt')));
    // move on the same drive: a rename
    const id3 = t.start([path.join(dest, 'src', 'sub')], base, { move: true });
    assert.ok(await until(() => t.list().find((x) => x.id === id3).state === 'done'));
    assert.ok(fs.existsSync(path.join(base, 'sub', 'b.txt')) && !fs.existsSync(path.join(dest, 'src', 'sub')));
    // a folder cannot go inside itself
    const id4 = t.start([src], path.join(src, 'sub'));
    assert.ok(await until(() => t.list().find((x) => x.id === id4).state === 'failed'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('transfers: stop removes the half-written file', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-xfer-stop-'));
  try {
    const big = path.join(base, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(40 * 1024 * 1024, 7));
    const dest = path.join(base, 'out');
    const t = new Transfers({ trash: async () => {} });
    const id = t.start([big], dest);
    await until(() => t.list().find((j) => j.id === id).done > 0, 5000);
    t.cancel(id);
    assert.ok(await until(() => t.list().find((j) => j.id === id).state === 'stopped'));
    assert.deepStrictEqual(fs.readdirSync(dest), [], 'nothing left behind');
    assert.ok(fs.existsSync(big), 'the source is untouched');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
