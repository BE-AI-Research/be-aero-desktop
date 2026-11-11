const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadIdentity, normalizeId } = require('../src/main/mesh/identity');
const { Mesh, FrameReader, encodeFrame } = require('../src/main/mesh/mesh');

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `aero-mesh-${n}-`));
// A stand-in for Electron safeStorage: AES-256-GCM with a fixed key.
function fakeProtect() {
  const key = crypto.randomBytes(32);
  return {
    available: () => true,
    encrypt: (text) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
    decrypt: (buf) => { const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'); }
  };
}
const memPeers = () => { let list = []; return { load: () => list, save: (l) => { list = JSON.parse(JSON.stringify(l)); } }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } return false; }

test('identity: the private key is stored encrypted, a plain key is converted, the ID is stable', () => {
  const dir = tmp('id');
  try {
    // an older plain key on disk
    const plain = loadIdentity(dir, { name: 'PC' });
    assert.ok(fs.existsSync(path.join(dir, 'device-key.pem')) && !plain.protected);
    const protect = fakeProtect();
    const a = loadIdentity(dir, { name: 'PC', protect });
    assert.strictEqual(a.id, plain.id, 'same identity after converting');
    assert.ok(a.protected);
    assert.ok(!fs.existsSync(path.join(dir, 'device-key.pem')), 'plain key removed');
    const enc = fs.readFileSync(path.join(dir, 'device-key.enc'));
    assert.ok(!enc.toString('latin1').includes('PRIVATE KEY'), 'no PEM on disk');
    assert.strictEqual(loadIdentity(dir, { protect }).id, a.id, 'reloads from the encrypted key');
    assert.strictEqual(normalizeId(a.id), a.id);
    // encrypted key but no keyring now: refuse rather than replace the identity
    assert.throws(() => loadIdentity(dir, { protect: { available: () => false } }), /keyring is not available/);
    assert.ok(fs.existsSync(path.join(dir, 'device-key.enc')), 'identity left intact');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('frames: JSON and binary frames survive arbitrary chunking', () => {
  const got = [];
  const r = new FrameReader((obj, bin) => got.push(obj || bin.toString('hex')), (e) => got.push('ERR ' + e.message));
  const all = Buffer.concat([encodeFrame({ t: 'req', op: 'ping' }), encodeFrame(Buffer.from([1, 2, 3]), 1), encodeFrame({ t: 'res', ok: true })]);
  for (let i = 0; i < all.length; i += 3) r.push(all.subarray(i, i + 3));
  assert.deepStrictEqual(got, [{ t: 'req', op: 'ping' }, '010203', { t: 'res', ok: true }]);
});

async function pairOfMeshes() {
  const dirs = [tmp('a'), tmp('b')];
  const approvals = [];
  const mk = (dir, name) => new Mesh({
    identity: loadIdentity(dir, { name, protect: fakeProtect() }), peers: memPeers(), port: 0, discovery: false,
    approvePairing: async (req) => { approvals.push({ to: name, ...req }); return true; }
  });
  const a = mk(dirs[0], 'Desk');
  const b = mk(dirs[1], 'Laptop');
  await a.start(); await b.start();
  const cleanup = () => { a.stop(); b.stop(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
  return { a, b, approvals, cleanup };
}

test('mesh: pairing with the code, then a pinned connection serving permitted requests', async () => {
  const { a, b, approvals, cleanup } = await pairOfMeshes();
  try {
    a.handle('echo', 'aiBus', async (args, from) => ({ echo: args.x, from: from.name }));
    const { code } = a.openPairing();
    let shown = null;
    const res = await b.pairWith('127.0.0.1', a.port, code, async (who) => { shown = who; return true; });
    assert.strictEqual(res.id, a.identity.id);
    assert.deepStrictEqual(shown, { id: a.identity.id, name: 'Desk' }, 'B saw A\'s name and ID before sending the code');
    assert.strictEqual(approvals.length, 1);
    assert.strictEqual(approvals[0].id, b.identity.id, 'A was asked to approve B by its pinned ID');
    assert.ok(a.peers.has(b.identity.id) && b.peers.has(a.identity.id), 'both sides paired');
    assert.strictEqual(a.state().pairing, null, 'pairing window closed after use');
    assert.ok(await until(() => a.conns.has(b.identity.id) && b.conns.has(a.identity.id)), 'connected');
    assert.deepStrictEqual(await b.request(a.identity.id, 'echo', { x: 42 }), { echo: 42, from: 'Laptop' });
    assert.strictEqual((await b.request(a.identity.id, 'ping')).name, 'Desk');
    // permissions are enforced on the receiving side
    a.setPerms(b.identity.id, { aiBus: false });
    await assert.rejects(b.request(a.identity.id, 'echo', { x: 1 }), /has not allowed "aiBus"/);
    await assert.rejects(b.request(a.identity.id, 'nope'), /unknown request/);
    // removing a device drops its connection and its pairing
    a.removePeer(b.identity.id);
    assert.ok(await until(() => !b.conns.has(a.identity.id)), 'B was disconnected');
    assert.ok(!a.peers.has(b.identity.id));
  } finally { cleanup(); }
});

test('mesh: no pairing window, a wrong code, or guessing closes the door', async () => {
  const { a, b, cleanup } = await pairOfMeshes();
  try {
    await assert.rejects(b.pairWith('127.0.0.1', a.port, '123456'), /not a BE-Aero device ready to pair|connection closed/, 'no window open');
    const { code } = a.openPairing();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await assert.rejects(b.pairWith('127.0.0.1', a.port, wrong), /wrong code|closed/);
    assert.strictEqual(a.state().pairing, null, 'five wrong codes close the pairing window');
    await assert.rejects(b.pairWith('127.0.0.1', a.port, code), /not a BE-Aero device ready to pair|connection closed/, 'even the right code is refused now');
    assert.ok(!a.peers.has(b.identity.id) && !b.peers.has(a.identity.id));
  } finally { cleanup(); }
});

test('mesh: declining on the showing side refuses the pairing', async () => {
  const dirs = [tmp('c'), tmp('d')];
  const a = new Mesh({ identity: loadIdentity(dirs[0], { name: 'A' }), peers: memPeers(), port: 0, discovery: false, approvePairing: async () => false });
  const b = new Mesh({ identity: loadIdentity(dirs[1], { name: 'B' }), peers: memPeers(), port: 0, discovery: false });
  await a.start(); await b.start();
  try {
    const { code } = a.openPairing();
    await assert.rejects(b.pairWith('127.0.0.1', a.port, code), /not approved/);
    assert.ok(!a.peers.has(b.identity.id) && !b.peers.has(a.identity.id));
  } finally { a.stop(); b.stop(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
});
