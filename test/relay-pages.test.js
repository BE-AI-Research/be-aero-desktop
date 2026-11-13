// A large relay store answers drive.index in pages (one message may be 16 MB;
// 27,000 files did not fit); following the pages gives the same index.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DriveStore } = require('../relay/drive');

function put(s, meta) {
  const id = s.begin(meta, 2, { by: 'DEV' });
  s.chunk(id, 0, Buffer.from('hi').toString('base64'), 'DEV');
  s.commit(id, { by: 'DEV' });
  return id;
}

test('drive.index in pages: all objects, in order, no duplicates; removals carried', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-pages-'));
  try {
    const s = new DriveStore({ dir });
    const ids = [];
    for (let i = 0; i < 23; i++) ids.push(put(s, `M${i}`));
    // Older clients (no limit): everything at once, as before.
    assert.strictEqual(s.index(0).objects.length, 23);
    // Pages of 5, following seq.
    const seen = new Map();
    let since = 0; let cont = false; let pages = 0; let r;
    do {
      r = s.index(since, { limit: 5, cont });
      if (pages === 0) assert.strictEqual(r.full, true);
      for (const o of r.objects) { assert.ok(!seen.has(o.id), 'no duplicates'); seen.set(o.id, o); }
      since = r.seq; cont = true; pages++;
    } while (r.more);
    assert.strictEqual(seen.size, 23);
    assert.strictEqual(pages, 5);
    assert.strictEqual(since, s.seq, 'the last page reaches the current seq');
    // Later: one removed, two added - a delta in pages carries both.
    s.remove([ids[3]]);
    put(s, 'N1'); put(s, 'N2');
    const removed = []; const added = [];
    cont = false;
    do {
      r = s.index(since, { limit: 2, cont });
      assert.strictEqual(r.full, false);
      removed.push(...r.removed); added.push(...r.objects.map((o) => o.meta));
      since = r.seq; cont = true;
    } while (r.more);
    assert.deepStrictEqual(removed, [ids[3]]);
    assert.deepStrictEqual(added.sort(), ['N1', 'N2']);
    s.flush();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
