const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadIdentity } = require('../src/main/mesh/identity');
const { Mesh } = require('../src/main/mesh/mesh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(40); } return false; }
const memPeers = () => { let l = []; return { load: () => l, save: (x) => { l = JSON.parse(JSON.stringify(x)); } }; };

test('mesh: a device that moved is found again at the address you give it', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-addr-'));
  const mk = (name) => new Mesh({ identity: loadIdentity(path.join(base, name), { name }), peers: memPeers(), port: 0, discovery: false, approvePairing: async () => true });
  const a = mk('Desk');
  const b = mk('Relay');
  try {
    await a.start(); await b.start();
    const { code } = b.openPairing();
    await a.pairWith('127.0.0.1', b.port, code);
    await until(() => a.conns.has(b.identity.id));
    // b "moves": a only knows a dead address now
    const B = b.identity.id;
    a.conns.get(B).close('test');
    const p = a.peers.get(B);
    p.addresses = ['127.0.0.1:1'];
    p.port = 1;
    await sleep(100);
    assert.ok(!a.conns.has(B));
    assert.ok(a.setAddress(B, '127.0.0.1', b.port));
    assert.ok(await until(() => a.conns.has(B)), 'reconnected at the new address');
    assert.strictEqual(a.peers.get(B).addresses[0], `127.0.0.1:${b.port}`);
  } finally { a.stop(); b.stop(); fs.rmSync(base, { recursive: true, force: true }); }
});
