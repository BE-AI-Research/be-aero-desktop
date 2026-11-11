const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chooseModel, inUseBy, serverKey, SharedServers, IN_USE_MS } = require('../src/main/ai/shared-server');

const S = '192.168.1.150:11434';
const Q4 = 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL';
const Q5 = 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q5_K_XL';

test('shared server: one server, however its URL is written', () => {
  assert.strictEqual(serverKey('http://192.168.1.150:11434/v1'), S);
  assert.strictEqual(serverKey('HTTP://192.168.1.150:11434/'), S);
  assert.notStrictEqual(serverKey('http://192.168.1.151:11434/v1'), S);
  assert.strictEqual(serverKey('nonsense'), '');
});

test('shared server: follow a loaded model only when one of my devices uses it there', () => {
  const peers = [{ name: 'BrownHome', models: [{ server: S, model: Q5 }], active: null }];
  assert.deepStrictEqual(chooseModel({ server: S, wanted: Q4, loaded: [Q5], peers }), { model: Q5, device: 'BrownHome' });
  assert.strictEqual(chooseModel({ server: S, wanted: Q4, loaded: [Q4, Q5], peers }), null, 'ours is loaded: keep it');
  assert.strictEqual(chooseModel({ server: S, wanted: Q4, loaded: ['llama3:8b'], peers }), null, 'never an unrelated loaded model');
  assert.strictEqual(chooseModel({ server: '10.0.0.5:11434', wanted: Q4, loaded: [Q5], peers }), null, 'never across servers');
  // a model a peer is actively using counts too, even if not its configured one
  assert.deepStrictEqual(chooseModel({ server: S, wanted: Q4, loaded: [Q5], peers: [{ name: 'Laptop', models: [], active: { server: S, model: Q5, at: Date.now() } }] }).device, 'Laptop');
});

test('shared server: a model a paired device is using is never evicted', () => {
  const now = Date.now();
  const peers = [
    { name: 'BrownHome', active: { server: S, model: Q5, running: true, at: now - 20 * 60 * 1000 } },
    { name: 'Laptop', active: { server: S, model: 'other', running: false, at: now - 60 * 1000 } },
    { name: 'Old', active: { server: S, model: 'stale', running: false, at: now - IN_USE_MS - 1000 } }
  ];
  const busy = inUseBy({ server: S, models: [Q5, 'other', 'stale', 'free'], peers, now });
  assert.deepStrictEqual(busy.map((b) => `${b.model}@${b.device}:${b.running}`).sort(), [`${Q5}@BrownHome:true`, 'other@Laptop:false']);
  assert.deepStrictEqual(inUseBy({ server: '10.0.0.5:11434', models: [Q5], peers, now }), []);
});

test('shared server: devices tell each other what they use and when they are busy', async () => {
  const { loadIdentity } = require('../src/main/mesh/identity');
  const { Mesh } = require('../src/main/mesh/mesh');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-shared-'));
  const memPeers = () => { let l = []; return { load: () => l, save: (x) => { l = JSON.parse(JSON.stringify(x)); } }; };
  const mk = (name, model) => {
    const mesh = new Mesh({ identity: loadIdentity(path.join(base, name), { name }), peers: memPeers(), port: 0, discovery: false, approvePairing: async () => true });
    const shared = new SharedServers({ local: () => ({ models: [{ server: S, model }] }) });
    return { mesh, shared };
  };
  const a = mk('Desk', Q4);
  const b = mk('BrownHome', Q5);
  try {
    await a.mesh.start(); await b.mesh.start();
    const { code } = a.mesh.openPairing();
    await b.mesh.pairWith('127.0.0.1', a.mesh.port, code);
    const until = async (f) => { for (let i = 0; i < 100; i++) { if (await f()) return true; await new Promise((r) => setTimeout(r, 40)); } return false; };
    await until(() => a.mesh.conns.size && b.mesh.conns.size);
    a.shared.attach(a.mesh); b.shared.attach(b.mesh);
    assert.ok(await until(() => a.shared.list().some((p) => p.models.some((m) => m.model === Q5))), 'the desk learned what BrownHome uses');
    assert.deepStrictEqual(a.shared.choose(S, Q4, [Q5]), { model: Q5, device: 'BrownHome' });
    b.shared.announce(S, Q5, true);
    assert.ok(await until(() => a.shared.inUse(S, [Q5]).length === 1), 'BrownHome\'s running turn is known');
    assert.strictEqual(a.shared.inUse(S, [Q5])[0].running, true);
  } finally { a.mesh.stop(); b.mesh.stop(); fs.rmSync(base, { recursive: true, force: true }); }
});
