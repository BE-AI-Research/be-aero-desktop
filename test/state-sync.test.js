const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadIdentity } = require('../src/main/mesh/identity');
const { Mesh } = require('../src/main/mesh/mesh');
const { StateSync } = require('../src/main/state-sync');

const memPeers = () => { let l = []; return { load: () => l, save: (x) => { l = JSON.parse(JSON.stringify(x)); } }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(30); } return false; }

async function twoDevices() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-state-'));
  const mk = (name) => {
    const mesh = new Mesh({ identity: loadIdentity(path.join(base, name, 'id'), { name }), peers: memPeers(), port: 0, discovery: false, approvePairing: async () => true });
    const data = new Map();             // the device's "app state"
    const applied = [];
    const sync = new StateSync({
      indexFile: path.join(base, name, 'state-index.json'),
      collect: () => new Map(data),
      apply: (k, v, from) => { data.set(k, v); applied.push(`${k}<-${from}`); },
      remove: (k) => { data.delete(k); }
    });
    sync.attach(mesh);
    return { name, mesh, data, sync, applied };
  };
  const a = mk('Desk');
  const b = mk('Laptop');
  await a.mesh.start(); await b.mesh.start();
  const { code } = a.mesh.openPairing();
  await b.mesh.pairWith('127.0.0.1', a.mesh.port, code);
  await until(() => a.mesh.conns.size && b.mesh.conns.size);
  return { a, b, done: () => { a.mesh.stop(); b.mesh.stop(); fs.rmSync(base, { recursive: true, force: true }); } };
}

test('state sync: new items, edits and deletes travel; the newest change wins; no echo', async () => {
  const { a, b, done } = await twoDevices();
  try {
    const B = b.mesh.identity.id;
    const A = a.mesh.identity.id;
    a.data.set('scratchpad', { text: 'buy milk' });
    a.data.set('conv:1', { title: 'Trip', messages: [{ role: 'user', content: 'plan a trip' }] });
    a.sync.scan();
    await b.sync.sync(A);
    assert.deepStrictEqual(b.data.get('scratchpad'), { text: 'buy milk' });
    assert.strictEqual(b.data.get('conv:1').title, 'Trip');
    assert.deepStrictEqual(b.applied.sort(), ['conv:1<-Desk', 'scratchpad<-Desk']);
    // nothing comes back: the desk already has it
    const back = await a.sync.sync(B);
    assert.deepStrictEqual(back, { applied: [], removed: [] }, 'no echo');
    // an edit on the laptop wins over the older desk copy
    await sleep(5);
    b.data.set('scratchpad', { text: 'buy milk and eggs' });
    b.sync.scan();
    await a.sync.sync(B);
    assert.deepStrictEqual(a.data.get('scratchpad'), { text: 'buy milk and eggs' });
    // a delete travels
    await sleep(5);
    a.data.delete('conv:1');
    a.sync.scan();
    await b.sync.sync(A);
    assert.ok(!b.data.has('conv:1'), 'deleted on the laptop too');
  } finally { done(); }
});

test('state sync: the older side does not overwrite a newer change', async () => {
  const { a, b, done } = await twoDevices();
  try {
    a.data.set('theme', { preset: 'aero' });
    a.sync.scan();
    await sleep(10);
    b.data.set('theme', { preset: 'midnight' });          // newer
    b.sync.scan();
    await b.sync.sync(a.mesh.identity.id);                 // laptop pulls from desk: desk's is older
    assert.deepStrictEqual(b.data.get('theme'), { preset: 'midnight' }, 'kept the newer');
    await a.sync.sync(b.mesh.identity.id);
    assert.deepStrictEqual(a.data.get('theme'), { preset: 'midnight' }, 'the desk took the newer');
  } finally { done(); }
});

test('state sync: nothing without the "Synced state" permission', async () => {
  const { a, b, done } = await twoDevices();
  try {
    a.mesh.setPerms(b.mesh.identity.id, { state: false });
    a.data.set('scratchpad', { text: 'private' });
    a.sync.scan();
    await assert.rejects(b.mesh.request(a.mesh.identity.id, 'state.manifest', {}), /has not allowed "state"/);
    await b.sync.sync(a.mesh.identity.id);
    assert.ok(!b.data.has('scratchpad'));
  } finally { done(); }
});

test('state sync: an item that stops syncing is forgotten here, not deleted on the other device', async () => {
  const { a, b, done } = await twoDevices();
  try {
    let localOnly = new Set();
    a.sync.tracked = (k) => !localOnly.has(k);
    a.data.set('conv:7', { title: 'Shared' });
    a.sync.scan();
    await b.sync.sync(a.mesh.identity.id);
    assert.ok(b.data.has('conv:7'));
    // the desk moves it to Local: it leaves the desk's synced set...
    localOnly.add('conv:7');
    a.data.delete('conv:7');
    a.sync.scan();
    await b.sync.sync(a.mesh.identity.id);
    assert.ok(b.data.has('conv:7'), '...but the laptop keeps its copy');
    // and the laptop's copy does not come back into the desk's local item
    a.data.set('conv:7', { title: 'Mine only' });
    await a.sync.sync(b.mesh.identity.id);
    assert.strictEqual(a.data.get('conv:7').title, 'Mine only');
  } finally { done(); }
});

test('state sync: an item that came through a relay follows the same newest-wins rule', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-state-in-'));
  try {
    const { hashOf } = require('../src/main/state-sync');
    const data = new Map([['theme', { preset: 'aero' }]]);
    const s = new StateSync({ indexFile: path.join(base, 'idx.json'), collect: () => new Map(data), apply: (k, v) => data.set(k, v), remove: (k) => data.delete(k) });
    s.scan();
    const mine = s.index.get('theme');
    // older than ours: ignored
    assert.strictEqual(s.applyIncoming('theme', { hash: hashOf({ preset: 'old' }), t: mine.t - 1000, deleted: false }, { preset: 'old' }, 'Laptop'), false);
    assert.deepStrictEqual(data.get('theme'), { preset: 'aero' });
    // newer: applied, and not reported back as a local change
    const v = { preset: 'midnight' };
    assert.strictEqual(s.applyIncoming('theme', { hash: hashOf(v), t: mine.t + 1000, deleted: false }, v, 'Laptop'), true);
    assert.deepStrictEqual(data.get('theme'), v);
    assert.deepStrictEqual(s.scan(), [], 'no echo');
    // a value that does not match its hash is refused
    assert.throws(() => s.applyIncoming('scratchpad', { hash: 'x', t: Date.now() + 5000, deleted: false }, { text: 'hi' }, 'Laptop'), /hash/);
    // a newer delete travels
    assert.strictEqual(s.applyIncoming('theme', { hash: hashOf(v), t: mine.t + 2000, deleted: true }, null, 'Laptop'), true);
    assert.ok(!data.has('theme'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
