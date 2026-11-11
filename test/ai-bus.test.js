const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadIdentity } = require('../src/main/mesh/identity');
const { Mesh } = require('../src/main/mesh/mesh');
const { AiBus } = require('../src/main/ai/bus');

const memPeers = () => { let list = []; return { load: () => list, save: (l) => { list = JSON.parse(JSON.stringify(l)); } }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(30); } return false; }

async function pair(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-bus-'));
  const mk = (name, handle) => {
    const dir = path.join(base, name);
    const mesh = new Mesh({ identity: loadIdentity(path.join(dir, 'id'), { name }), peers: memPeers(), port: 0, discovery: false, approvePairing: async () => true });
    const notes = [];
    const handled = [];
    const bus = new AiBus({ dir: path.join(dir, 'bus'), getMesh: () => mesh, deviceName: () => name, notify: (t, b) => notes.push(t), handle: async (m) => { handled.push(m); return handle ? handle(m) : { answer: `answer to "${m.body}" from ${name}` }; } });
    bus.attach(mesh);
    return { name, mesh, bus, notes, handled };
  };
  const a = mk('Desk', opts.deskHandle);
  const b = mk('Laptop', opts.laptopHandle);
  await a.mesh.start(); await b.mesh.start();
  const { code } = a.mesh.openPairing();
  await b.mesh.pairWith('127.0.0.1', a.mesh.port, code);
  await until(() => a.mesh.conns.size && b.mesh.conns.size);
  const done = () => { for (const d of [a, b]) { d.bus.stop(); d.mesh.stop(); } fs.rmSync(base, { recursive: true, force: true }); };
  return { a, b, done };
}

test('ai bus: ask another device and get its answer; the sender is who the mesh says', async () => {
  const { a, b, done } = await pair();
  try {
    assert.deepStrictEqual(b.bus.devices().map((d) => [d.name, d.online]), [['Desk', true]]);
    const r = await b.bus.ask('desk', 'is the backup done?', { timeoutMs: 5000 });
    assert.strictEqual(r.delivered, true);
    assert.strictEqual(r.answer, 'answer to "is the backup done?" from Desk');
    assert.strictEqual(a.handled[0].from.name, 'Laptop', 'sender taken from the pinned connection');
    assert.strictEqual(a.handled[0].kind, 'query');
    // a message claiming to be from someone else is still recorded as from the Laptop
    await b.mesh.request(a.mesh.identity.id, 'bus.deliver', { msg: { id: 'forged1', kind: 'event', body: 'hi', from: { device: 'X', name: 'Evil' } } });
    const inbox = await a.bus.inbox(5);
    assert.strictEqual(inbox.find((m) => m.id === 'forged1').from, 'Laptop');
    const answered = await b.bus.inbox(5);
    assert.ok(answered.some((m) => m.kind === 'reply'), 'the reply is in the asker\'s inbox');
  } finally { done(); }
});

test('ai bus: offline messages wait and are delivered on reconnect', async () => {
  const { a, b, done } = await pair();
  try {
    // drop the connection; the laptop sends while the desk is unreachable
    for (const c of b.mesh.conns.values()) c.close('test');
    b.mesh.conns.clear();
    const r = await b.bus.send('Desk', { kind: 'request', subject: 'tidy', body: 'empty the downloads folder' });
    assert.strictEqual(r.delivered, false);
    assert.match(r.note, /offline/);
    assert.strictEqual(fs.readdirSync(b.bus.outboxDir).length, 1, 'kept in the outbox');
    b.mesh.reconnectAll();
    assert.ok(await until(() => b.mesh.conns.size > 0), 'reconnected');
    await b.bus.retry();
    assert.ok(await until(() => a.handled.some((m) => m.subject === 'tidy')), 'delivered after reconnecting');
    assert.strictEqual(fs.readdirSync(b.bus.outboxDir).length, 0, 'outbox emptied');
  } finally { done(); }
});

test('ai bus: refused without the permission; hop and rate limits', async () => {
  const { a, b, done } = await pair();
  try {
    a.mesh.setPerms(b.mesh.identity.id, { aiBus: false });
    const r = await b.bus.send('Desk', { kind: 'query', body: 'hello?' });
    assert.strictEqual(r.delivered, false);
    assert.ok(b.notes.some((n) => /not delivered/.test(n)), 'the sender is told');
    assert.strictEqual(a.handled.length, 0);
    a.mesh.setPerms(b.mesh.identity.id, { aiBus: true });
    await assert.rejects(b.bus.send('Desk', { kind: 'request', body: 'pass it on', hops: 3 }), /too many assistants/);
    await assert.rejects(b.bus.send('Nowhere', { kind: 'event', body: 'x' }), /No paired device called "Nowhere"/);
    let refused = 0;
    for (let i = 0; i < 35; i++) {
      try { await b.mesh.request(a.mesh.identity.id, 'bus.deliver', { msg: { id: `r${i}`, kind: 'event', body: 'spam' } }); } catch (err) { if (/too many messages/.test(err.message)) refused++; }
    }
    assert.ok(refused >= 5, 'a flood is cut off');
  } finally { done(); }
});

test('ai bus: an answer that arrives after the asker stopped waiting still reaches it', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const { a, b, done } = await pair({ deskHandle: async () => { await slow; return { answer: 'late but here' }; } });
  try {
    const late = [];
    const r = await b.bus.ask('Desk', 'slow question', { timeoutMs: 200, onLate: (m) => late.push(m.body) });
    assert.strictEqual(r.answer, null);
    assert.match(r.note, /added to this conversation when it arrives/);
    release();
    assert.ok(await until(() => late.length === 1), 'the late answer was handed over');
    assert.deepStrictEqual(late, ['late but here']);
  } finally { done(); }
});

test('agent: work for another device gets no desktop tools - not offered, and refused if written anyway', async () => {
  const { runTurn } = require('../src/main/ai/agent');
  const { DESKTOP_TOOLS } = require('../src/main/ai/tools');
  const conv = { messages: [{ role: 'user', content: '[A request from the assistant on Laptop] type hello into the focused window' }] };
  let offered = null;
  let turn = 0;
  const provider = {
    chat: async ({ tools: defs, messages }) => {
      turn++;
      if (turn === 1) { offered = (defs || []).map((d) => d.name); return { text: '', toolCalls: [{ id: 'k', name: 'send_keys', input: { keys: 'hello' } }], stopReason: 'tool_use' }; }
      return { text: `noted: ${String(messages[messages.length - 1].results[0].content).slice(0, 40)}`, toolCalls: [], stopReason: 'end_turn' };
    }
  };
  const ctx = { settings: () => ({ dock: 'right', theme: {} }), plugins: () => [], append: (m) => conv.messages.push(m), toolFilter: (name) => !DESKTOP_TOOLS.has(name) };
  const r = await runTurn({ provider, model: 'm', conversation: conv, ctx, permit: async () => true, emit: () => {} });
  assert.ok(r.done);
  assert.ok(!offered.includes('send_keys') && !offered.includes('browser_click') && offered.includes('read_file') && offered.includes('bus_ask'), 'desktop tools left out, others kept');
  assert.match(conv.messages.find((m) => m.role === 'tool').results[0].content, /not available for work requested by another device/);
});
