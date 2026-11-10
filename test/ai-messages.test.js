const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Conversations } = require('../src/main/ai/conversations');

function seeded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-msgs-'));
  const store = new Conversations(dir);
  const c = store.create('t');
  const msgs = [
    { role: 'user', content: 'q0' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', input: {} }] },
    { role: 'tool', results: [{ id: 'a', name: 'x', content: 'r' }] },
    { role: 'assistant', content: 'a0' },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }
  ];
  for (const m of msgs) store.append(c.id, m);
  return { dir, store, id: c.id };
}
const roles = (c) => c.messages.map((m) => m.content || m.role).join(',');

test('turnRange spans a question and everything up to the next one', () => {
  const { dir, store, id } = seeded();
  assert.deepStrictEqual(store.turnRange(id, 0), { start: 0, end: 4 });
  assert.deepStrictEqual(store.turnRange(id, 4), { start: 4, end: 6 });
  assert.deepStrictEqual(store.turnRange(id, 6), { start: 6, end: 7 });
  assert.throws(() => store.turnRange(id, 3), /not a user message/);
  assert.throws(() => store.turnRange(id, 99), /not a user message/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removeRange deletes a whole exchange or just its reply, and persists', () => {
  const { dir, store, id } = seeded();
  const r = store.turnRange(id, 0);
  store.removeRange(id, r.start + 1, r.end);           // reply only (tool steps included)
  assert.strictEqual(roles(store.get(id)), 'q0,q1,a1,q2');
  const r2 = store.turnRange(id, 1);
  store.removeRange(id, r2.start, r2.end);             // whole exchange
  assert.strictEqual(roles(store.get(id)), 'q0,q2');
  const reread = new Conversations(dir).get(id);
  assert.strictEqual(roles(reread), 'q0,q2', 'saved to disk');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deleting inside a compacted region drops the summary; after it shifts the offset', () => {
  const { dir, store, id } = seeded();
  store.setSummary(id, 'summary of q0', 4);
  store.removeRange(id, 4, 6);                         // after the compacted part
  assert.strictEqual(store.get(id).compactedAt, 4);
  assert.strictEqual(store.get(id).summary, 'summary of q0');
  store.removeRange(id, 0, 4);                         // inside it
  assert.strictEqual(store.get(id).summary, '');
  assert.strictEqual(store.get(id).compactedAt, 0);
  assert.strictEqual(roles(store.get(id)), 'q2');
  fs.rmSync(dir, { recursive: true, force: true });
});
