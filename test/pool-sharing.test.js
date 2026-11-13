// "Share my File Pool" off: other devices can neither list, search nor
// read it, nor sync it; the other shared folders keep their numbers.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { RemoteFiles } = require('../src/main/remote-files');
const { PoolSync } = require('../src/main/pool-sync');

function fakeMesh(peers = {}) {
  const handlers = new Map();
  return {
    handlers, peers: new Map(Object.entries(peers)), conns: new Map(),
    handle(op, perm, fn) { handlers.set(op, fn); },
    on() {}, request: async () => ({})
  };
}

test('an unshared File Pool is not offered, listed or read; shared folders keep their index', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-poolshare-'));
  const pool = path.join(dir, 'pool'); const docs = path.join(dir, 'docs');
  fs.mkdirSync(pool); fs.mkdirSync(docs);
  fs.writeFileSync(path.join(pool, 'private.txt'), 'mine');
  fs.writeFileSync(path.join(docs, 'shared.txt'), 'ours');
  let shared = true;
  const rf = new RemoteFiles({ getMesh: () => null, poolDir: () => pool, cacheDir: path.join(dir, 'cache'), shareStore: { get: () => [{ path: docs, name: 'Docs' }] }, poolShared: () => shared });
  const mesh = fakeMesh();
  rf.attach(mesh);
  const from = { id: 'PEER' };
  assert.deepStrictEqual((await mesh.handlers.get('files.roots')({}, from)).roots.map((r) => [r.index, r.name]), [[0, 'File Pool'], [1, 'Docs']]);
  shared = false;
  assert.deepStrictEqual((await mesh.handlers.get('files.roots')({}, from)).roots.map((r) => [r.index, r.name]), [[1, 'Docs']]);
  await assert.rejects(mesh.handlers.get('files.list')({ root: 0, rel: '' }, from), /no such shared folder/);
  await assert.rejects(mesh.handlers.get('files.read')({ root: 0, rel: 'private.txt', offset: 0, length: 10 }, from), /no such shared folder/);
  assert.deepStrictEqual((await mesh.handlers.get('files.list')({ root: 1, rel: '' }, from)).entries.map((e) => e.name), ['shared.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unshared File Pool does not sync either way', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-poolshare-'));
  let shared = false;
  const ps = new PoolSync({ poolDir: () => dir, indexFile: path.join(dir, '..', `idx-${path.basename(dir)}.json`), trash: async () => {}, shared: () => shared });
  const mesh = fakeMesh({ PEER: { id: 'PEER', perms: { pool: true } } });
  ps.attach(mesh);
  assert.strictEqual(ps.allowed('PEER'), false);
  await assert.rejects(mesh.handlers.get('pool.manifest')({}, { id: 'PEER' }), /does not share its File Pool/);
  await assert.rejects(mesh.handlers.get('pool.read')({ rel: 'x', offset: 0, length: 1 }, { id: 'PEER' }), /does not share/);
  shared = true;
  assert.strictEqual(ps.allowed('PEER'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
