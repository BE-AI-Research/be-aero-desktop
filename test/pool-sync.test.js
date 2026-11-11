const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadIdentity } = require('../src/main/mesh/identity');
const { Mesh } = require('../src/main/mesh/mesh');
const { PoolSync } = require('../src/main/pool-sync');

const memPeers = () => { let list = []; return { load: () => list, save: (l) => { list = JSON.parse(JSON.stringify(l)); } }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(40); } return false; }

async function twoDevices() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-pool-'));
  const mk = (name) => {
    const dir = path.join(base, name);
    const mesh = new Mesh({ identity: loadIdentity(path.join(dir, 'id'), { name }), peers: memPeers(), port: 0, discovery: false, approvePairing: async () => true });
    const pool = path.join(dir, 'Pool');
    const trashed = [];
    const sync = new PoolSync({ poolDir: () => pool, indexFile: path.join(dir, 'pool-index.json'), deviceName: () => name, trash: async (p) => { trashed.push(path.basename(p)); fs.rmSync(p, { force: true }); } });
    sync.attach(mesh);
    return { name, mesh, pool, sync, trashed };
  };
  const a = mk('Desk');
  const b = mk('Laptop');
  await a.mesh.start(); await b.mesh.start();
  const { code } = a.mesh.openPairing();
  await b.mesh.pairWith('127.0.0.1', a.mesh.port, code);
  await until(() => a.mesh.conns.size && b.mesh.conns.size);
  a.sync.start(); b.sync.start();
  const done = () => { for (const d of [a, b]) { d.sync.stop(); d.mesh.stop(); } fs.rmSync(base, { recursive: true, force: true }); };
  return { a, b, done };
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

test('pool sync: a new file, an edit, a nested folder and a big file reach the other device', async () => {
  const { a, b, done } = await twoDevices();
  try {
    fs.writeFileSync(path.join(a.pool, 'notes.txt'), 'hello from the desk');
    await a.sync.scan(); a.sync.announce();
    assert.ok(await until(() => read(path.join(b.pool, 'notes.txt')) === 'hello from the desk'), 'arrived');
    fs.writeFileSync(path.join(a.pool, 'notes.txt'), 'edited on the desk');
    await a.sync.scan(); a.sync.announce();
    assert.ok(await until(() => read(path.join(b.pool, 'notes.txt')) === 'edited on the desk'), 'edit arrived');
    fs.mkdirSync(path.join(b.pool, 'photos', '2026'), { recursive: true });
    const big = crypto.randomBytes(2.5 * 1024 * 1024);                 // three chunks
    fs.writeFileSync(path.join(b.pool, 'photos', '2026', 'big.bin'), big);
    await b.sync.scan(); b.sync.announce();
    assert.ok(await until(() => { try { return fs.readFileSync(path.join(a.pool, 'photos', '2026', 'big.bin')).equals(big); } catch { return false; } }, 10000), 'big file, nested, intact');
    assert.ok(!fs.readdirSync(path.join(a.pool, '.be-aero-sync')).length, 'no temporary files left behind');
  } finally { done(); }
});

test('pool sync: deletes travel to the trash, and edits on both sides keep both', async () => {
  const { a, b, done } = await twoDevices();
  try {
    fs.writeFileSync(path.join(a.pool, 'gone.txt'), 'x');
    fs.writeFileSync(path.join(a.pool, 'both.txt'), 'v1');
    await a.sync.scan(); a.sync.announce();
    assert.ok(await until(() => read(path.join(b.pool, 'both.txt')) === 'v1' && read(path.join(b.pool, 'gone.txt')) === 'x'));
    fs.rmSync(path.join(a.pool, 'gone.txt'));
    await a.sync.scan(); a.sync.announce();
    assert.ok(await until(() => read(path.join(b.pool, 'gone.txt')) === null), 'delete arrived');
    assert.deepStrictEqual(b.trashed, ['gone.txt'], 'through the trash');
    // edited on both sides before they talk again
    a.sync.mesh = null; b.sync.mesh = null;                           // pause syncing
    fs.writeFileSync(path.join(b.pool, 'both.txt'), 'laptop edit');
    await b.sync.scan();
    await sleep(30);
    fs.writeFileSync(path.join(a.pool, 'both.txt'), 'desk edit (newer)');
    await a.sync.scan();
    a.sync.mesh = a.mesh; b.sync.mesh = b.mesh;
    await b.sync.syncWith(a.mesh.identity.id);
    assert.strictEqual(read(path.join(b.pool, 'both.txt')), 'desk edit (newer)', 'the newer edit wins');
    const conflict = fs.readdirSync(b.pool).find((n) => n.startsWith('both (conflict Laptop'));
    assert.ok(conflict, 'the other edit is kept as a conflict copy');
    assert.strictEqual(read(path.join(b.pool, conflict)), 'laptop edit');
  } finally { done(); }
});

test('pool sync: a device without the File Pool permission gets nothing', async () => {
  const { a, b, done } = await twoDevices();
  try {
    a.mesh.setPerms(b.mesh.identity.id, { pool: false });
    fs.writeFileSync(path.join(a.pool, 'private.txt'), 'secret');
    await a.sync.scan();
    await assert.rejects(b.mesh.request(a.mesh.identity.id, 'pool.manifest'), /has not allowed "pool"/);
    await b.sync.syncWith(a.mesh.identity.id);
    assert.strictEqual(read(path.join(b.pool, 'private.txt')), null);
    // and paths are confined to the pool even for an allowed device
    a.mesh.setPerms(b.mesh.identity.id, { pool: true });
    await assert.rejects(b.mesh.request(a.mesh.identity.id, 'pool.read', { rel: '../id/device-key.pem' }), /not in the pool/);
  } finally { done(); }
});
