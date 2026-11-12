const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadIdentity } = require('../src/main/mesh/identity');
const { Mesh } = require('../src/main/mesh/mesh');
const { RelayClient } = require('../src/main/relay-client');
const { createRelay } = require('../relay/relay');
const { MailStore } = require('../relay/store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(40); } return false; }
const memPeers = () => { let l = []; return { load: () => l, save: (x) => { l = JSON.parse(JSON.stringify(x)); } }; };

function device(base, name, got) {
  const peers = memPeers();
  const mk = () => {
    const mesh = new Mesh({ identity: loadIdentity(path.join(base, name, 'id'), { name }), peers, port: 0, discovery: false, approvePairing: async () => true });
    const client = new RelayClient({ handlers: { state: async (data, from, key) => got.push({ to: name, from: from.name, key, data }) } });
    client.attach(mesh);
    return { mesh, client };
  };
  return { name, peers, mk };
}

async function pair(a, b) {
  const { code } = a.mesh.openPairing();
  await b.mesh.pairWith('127.0.0.1', a.mesh.port, code);
  await until(() => a.mesh.conns.has(b.mesh.identity.id) && b.mesh.conns.has(a.mesh.identity.id));
}

test('relay: a message for an offline device waits on the relay, sealed, and arrives when it is back', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-relay-'));
  const got = [];
  const relay = createRelay({ dataDir: path.join(base, 'relay'), port: 0, discovery: false, quiet: true });
  const A = device(base, 'Desk', got);
  const B = device(base, 'Laptop', got);
  let a = A.mk();
  let b = B.mk();
  try {
    await relay.start();
    await a.mesh.start(); await b.mesh.start();
    await pair(a, b);                                   // my two devices
    const r = { mesh: relay.mesh };
    await pair(r, a); await pair(r, b);                 // both paired with the relay
    const R = relay.identity.id;
    await until(() => a.mesh.peers.get(R) && a.mesh.peers.get(R).role === 'relay' && b.mesh.peers.get(R) && b.mesh.peers.get(R).role === 'relay');
    assert.strictEqual(a.mesh.peers.get(R).role, 'relay', 'the relay says what it is');
    // the laptop goes offline (it is not reachable directly any more)
    const Bid = b.mesh.identity.id;
    b.mesh.stop(); b.client.stop();
    await until(() => !a.mesh.conns.has(Bid));
    await a.client.refresh(R);
    assert.ok(a.client.reachable(Bid), 'reachable through the relay');
    await a.client.send(Bid, 'state', 'theme', { preset: 'midnight' });
    // the relay holds it, and cannot read it
    const held = relay.store.list(Bid);
    assert.strictEqual(held.length, 1);
    assert.ok(!fs.readFileSync(relay.store.file(held[0])).toString().includes('midnight'));
    // a newer version of the same item replaces the waiting one
    await a.client.send(Bid, 'state', 'theme', { preset: 'aero' });
    assert.strictEqual(relay.store.list(Bid).length, 1);
    // the desk goes offline too; then the laptop comes back
    a.mesh.stop(); a.client.stop();
    b = B.mk();
    await b.mesh.start();
    await until(() => got.length > 0, 10000);
    assert.deepStrictEqual(got, [{ to: 'Laptop', from: 'Desk', key: 'theme', data: { preset: 'aero' } }]);
    await until(() => relay.store.list(Bid).length === 0);
    assert.strictEqual(relay.store.list(Bid).length, 0, 'acknowledged and removed');
  } finally {
    relay.stop(); a.mesh.stop(); b.mesh.stop(); a.client.stop(); b.client.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('relay: refuses items for devices not paired with it; mail store expiry and quota', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-mail-'));
  try {
    const s = new MailStore({ dir: base, maxBytes: 100, ttlMs: 1000 });
    const A = 'AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA';
    const B = 'BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB';
    const m = s.put({ from: A, to: B, kind: 'bus', data: Buffer.alloc(60) });
    assert.throws(() => s.put({ from: A, to: B, kind: 'bus', data: Buffer.alloc(60) }), /full/);
    assert.strictEqual(s.get(A, m.id), null, 'only the recipient reads it');
    assert.ok(s.get(B, m.id));
    assert.strictEqual(s.sweep(Date.now() + 2000), 1, 'expired');
    assert.throws(() => s.put({ from: A, to: 'nope', kind: 'bus', data: Buffer.alloc(1) }), /bad device id/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('relay storage: encrypted Shared storage and the File Pool copy, opened by my other device', async () => {
  const { RelayDrive } = require('../src/main/relay-drive');
  const { DriveKeyring } = require('../src/main/mesh/drive-crypto');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-drive-'));
  const relay = createRelay({ dataDir: path.join(base, 'relay'), port: 0, discovery: false, quiet: true });
  const mkDev = (name, pool) => {
    const mesh = new Mesh({ identity: loadIdentity(path.join(base, name, 'id'), { name }), peers: memPeers(), port: 0, discovery: false, approvePairing: async () => true });
    const client = new RelayClient({});
    client.attach(mesh);
    const drive = new RelayDrive({ getMesh: () => mesh, relayClient: client, keyring: new DriveKeyring({ file: path.join(base, name, 'keys.json') }), pool });
    drive.attach(mesh);
    return { mesh, client, drive };
  };
  const poolDir = path.join(base, 'desk-pool');
  fs.mkdirSync(poolDir, { recursive: true });
  fs.writeFileSync(path.join(poolDir, 'notes.txt'), 'pool notes');
  const crypto = require('crypto');
  const poolIndex = new Map([['notes.txt', { size: 10, mtime: Date.now(), hash: crypto.createHash('sha256').update('pool notes').digest('hex'), deleted: false }]]);
  const a = mkDev('Desk', { dir: () => poolDir, index: () => poolIndex, onChange: () => {} });
  const b = mkDev('Laptop', null);
  try {
    await relay.start(); await a.mesh.start(); await b.mesh.start();
    await pair(a, b);
    await pair({ mesh: relay.mesh }, a); await pair({ mesh: relay.mesh }, b);
    const R = relay.identity.id;
    await until(() => a.mesh.peers.get(R).role === 'relay' && b.mesh.peers.get(R).role === 'relay' && a.mesh.conns.has(R) && b.mesh.conns.has(R));
    // Desk stores a file and a folder in Shared storage
    const src = path.join(base, 'report.txt');
    fs.writeFileSync(src, 'quarterly numbers '.repeat(100000));                       // ~1.8 MB: two chunks
    await a.drive.mkdir(R, 'Docs');
    await a.drive.upload(R, 0, 'Docs/report.txt', src);
    // the relay holds only ciphertext: no names, no content
    const raw = fs.readdirSync(path.join(base, 'relay', 'drive')).map((f) => fs.readFileSync(path.join(base, 'relay', 'drive', f)).toString('latin1')).join('');
    assert.ok(!raw.includes('report') && !raw.includes('quarterly') && !raw.includes('Docs'), 'the relay cannot read names or content');
    // the key reached the laptop over the mesh (it has Browse files permission)
    await until(() => b.drive.keyring.has());
    assert.ok(b.drive.keyring.has(), 'key shared');
    const top = await b.drive.list(R, 0, '');
    assert.deepStrictEqual(top.entries.map((e) => [e.name, e.dir]), [['Docs', true]]);
    const docs = await b.drive.list(R, 0, 'Docs');
    assert.deepStrictEqual(docs.entries.map((e) => e.name), ['report.txt']);
    const got = path.join(base, 'laptop', 'report.txt');
    await b.drive.download(R, 0, 'Docs/report.txt', got);
    assert.strictEqual(fs.readFileSync(got, 'utf8'), fs.readFileSync(src, 'utf8'));
    // rename and remove
    await b.drive.rename(R, 'Docs', 'Reports');
    assert.deepStrictEqual((await a.drive.list(R, 0, 'Reports')).entries.map((e) => e.name), ['report.txt']);
    assert.strictEqual(await a.drive.remove(R, 0, ['Reports']), 2);
    assert.deepStrictEqual((await b.drive.list(R, 0, '')).entries, []);
    // the File Pool copy: the desk mirrors its pool; the laptop opens it
    await a.drive.mirrorPool();
    b.drive.cache.clear();                       // the browser's 4 s listing cache
    const pool = await b.drive.list(R, 1, '');
    assert.deepStrictEqual(pool.entries.map((e) => e.name), ['notes.txt']);
    const pf = path.join(base, 'laptop', 'notes.txt');
    await b.drive.download(R, 1, 'notes.txt', pf);
    assert.strictEqual(fs.readFileSync(pf, 'utf8'), 'pool notes');
    // a delete on the desk removes the copy (same version)
    poolIndex.set('notes.txt', { ...poolIndex.get('notes.txt'), deleted: true });
    await a.drive.mirrorPool();
    b.drive.cache.clear();
    assert.deepStrictEqual((await b.drive.list(R, 1, '')).entries, []);
  } finally {
    relay.stop(); a.mesh.stop(); b.mesh.stop(); a.client.stop(); b.client.stop(); a.drive.stop(); b.drive.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
