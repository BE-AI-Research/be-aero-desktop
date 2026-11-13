// Removing a device removes it on both sides (now, or when it next
// connects), and a device with a stale pairing can pair again over it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadIdentity } = require('../src/main/mesh/identity');
const { Mesh } = require('../src/main/mesh/mesh');

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `aero-forget-${n}-`));
const memStore = () => { let list = []; return { load: () => list, save: (l) => { list = JSON.parse(JSON.stringify(l)); } }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } return false; }

async function pairPair(tag) {
  const dirs = [tmp(`${tag}a`), tmp(`${tag}b`)];
  const mk = (dir, name) => new Mesh({ identity: loadIdentity(dir, { name }), peers: memStore(), forgotten: memStore(), port: 0, discovery: false, approvePairing: async () => true });
  const a = mk(dirs[0], 'A'); const b = mk(dirs[1], 'B');
  await a.start(); await b.start();
  const { code } = a.openPairing();
  await b.pairWith('127.0.0.1', a.port, code);
  assert.ok(await until(() => a.conns.has(b.identity.id) && b.conns.has(a.identity.id)), 'connected');
  return { a, b, done: () => { a.stop(); b.stop(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); } };
}

test('removing a connected device removes it on the other side too', async () => {
  const { a, b, done } = await pairPair('on');
  try {
    a.removePeer(b.identity.id);
    assert.ok(!a.peers.has(b.identity.id));
    assert.ok(await until(() => !b.peers.has(a.identity.id)), 'B forgot A');
    assert.strictEqual(a.forgotten.size, 0, 'told at once: nothing left to tell');
  } finally { done(); }
});

test('removing an offline device: it is told when it next connects', async () => {
  const { a, b, done } = await pairPair('off');
  try {
    // B goes away; A removes it meanwhile.
    b.stop();
    assert.ok(await until(() => !a.conns.has(b.identity.id)));
    a.removePeer(b.identity.id);
    assert.ok(a.forgotten.has(b.identity.id), 'remembered to tell it');
    // B comes back and dials A, which tells it to forget.
    await b.start();
    b.peers.get(a.identity.id).addresses = [`127.0.0.1:${a.port}`];
    b.reconnectAll();
    assert.ok(await until(() => !b.peers.has(a.identity.id)), 'B forgot A on reconnecting');
    assert.ok(!a.forgotten.has(b.identity.id), 'told: nothing left to tell');
  } finally { done(); }
});

test('a stale pairing on the other side is replaced when pairing again', async () => {
  const { a, b, done } = await pairPair('stale');
  try {
    // B loses its side (an old build, a lost file); A still has B.
    b.peers.delete(a.identity.id);
    for (const c of b.conns.values()) c.close('test');
    assert.ok(a.peers.has(b.identity.id));
    a.peers.get(b.identity.id).perms.files = false;      // something set on the old pairing
    const { code } = a.openPairing();
    const res = await b.pairWith('127.0.0.1', a.port, code);
    assert.strictEqual(res.id, a.identity.id);
    assert.ok(b.peers.has(a.identity.id), 'B has A again');
    assert.strictEqual(a.peers.get(b.identity.id).perms.files, true, 'A made a fresh record (default permissions)');
    assert.ok(await until(() => a.conns.has(b.identity.id) && b.conns.has(a.identity.id)), 'connected again');
  } finally { done(); }
});

test('pairing again over a stale pairing still needs the right code', async () => {
  const { a, b, done } = await pairPair('code');
  try {
    b.peers.delete(a.identity.id);
    for (const c of b.conns.values()) c.close('test');
    a.openPairing();
    await assert.rejects(b.pairWith('127.0.0.1', a.port, '000000'), /wrong code|closed/);
    assert.ok(!b.peers.has(a.identity.id));
  } finally { done(); }
});
