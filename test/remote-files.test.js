const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadIdentity } = require('../src/main/mesh/identity');
const { Mesh } = require('../src/main/mesh/mesh');
const { RemoteFiles, parseRemote } = require('../src/main/remote-files');

const memPeers = () => { let list = []; return { load: () => list, save: (l) => { list = JSON.parse(JSON.stringify(l)); } }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(30); } return false; }

test('remote files: addresses', () => {
  assert.deepStrictEqual(parseRemote('aero://ABCDEFG-HIJ/1/docs/a.txt'), { device: 'ABCDEFG-HIJ', root: 1, rel: 'docs/a.txt' });
  assert.deepStrictEqual(parseRemote('aero://ABCDEFG-HIJ'), { device: 'ABCDEFG-HIJ', root: null, rel: '' });
  assert.strictEqual(parseRemote('C:/x'), null);
});

test('remote files: the Pool and shared folders only, confined, permission-checked, downloadable', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-remote-'));
  const mk = (name) => {
    const dir = path.join(base, name);
    const mesh = new Mesh({ identity: loadIdentity(path.join(dir, 'id'), { name }), peers: memPeers(), port: 0, discovery: false, approvePairing: async () => true });
    const pool = path.join(dir, 'Pool');
    fs.mkdirSync(pool, { recursive: true });
    const rf = new RemoteFiles({ getMesh: () => mesh, poolDir: () => pool, cacheDir: path.join(dir, 'cache'), shareStore: { get: (id) => (mesh.peers.get(id) || {}).shares || [] } });
    rf.attach(mesh);
    return { dir, mesh, pool, rf };
  };
  const a = mk('Desk');
  const b = mk('Laptop');
  try {
    await a.mesh.start(); await b.mesh.start();
    const { code } = a.mesh.openPairing();
    await b.mesh.pairWith('127.0.0.1', a.mesh.port, code);
    await until(() => a.mesh.conns.size && b.mesh.conns.size);
    const A = a.mesh.identity.id;
    fs.writeFileSync(path.join(a.pool, 'shared.txt'), 'pool file');
    const docs = path.join(a.dir, 'Documents');
    fs.mkdirSync(path.join(docs, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'sub', 'report.txt'), 'quarterly report');
    fs.writeFileSync(path.join(a.dir, 'secret.txt'), 'not shared');

    // only the Pool to begin with
    let roots = await b.rf.list(`aero://${A}`);
    assert.deepStrictEqual(roots.entries.map((e) => e.name), ['File Pool']);
    assert.deepStrictEqual((await b.rf.list(`aero://${A}/0`)).entries.map((e) => e.name), ['shared.txt']);
    // the Desk shares Documents with the Laptop
    a.mesh.setShares(b.mesh.identity.id, [{ path: docs, name: 'Documents' }]);
    roots = await b.rf.list(`aero://${A}`);
    assert.deepStrictEqual(roots.entries.map((e) => e.name), ['File Pool', 'Documents']);
    const sub = await b.rf.list(`aero://${A}/1/sub`);
    assert.deepStrictEqual(sub.entries.map((e) => e.name), ['report.txt']);
    assert.strictEqual(sub.parent, `aero://${A}/1`);
    // download, and a cached copy for opening
    const target = path.join(b.dir, 'Downloads', 'report.txt');
    await b.rf.download(`aero://${A}/1/sub/report.txt`, target);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'quarterly report');
    assert.strictEqual(fs.readFileSync(await b.rf.cached(`aero://${A}/0/shared.txt`), 'utf8'), 'pool file');
    // escaping the shared folder is refused
    await assert.rejects(b.mesh.request(A, 'files.list', { root: 1, rel: '..' }), /outside the shared folder/);
    await assert.rejects(b.mesh.request(A, 'files.read', { root: 1, rel: '../secret.txt' }), /outside the shared folder/);
    await assert.rejects(b.mesh.request(A, 'files.read', { root: 7, rel: 'x' }), /no such shared folder/);
    // and without the permission, nothing
    a.mesh.setPerms(b.mesh.identity.id, { files: false });
    await assert.rejects(b.rf.list(`aero://${A}`), /has not allowed "files"/);
  } finally { a.mesh.stop(); b.mesh.stop(); fs.rmSync(base, { recursive: true, force: true }); }
});
