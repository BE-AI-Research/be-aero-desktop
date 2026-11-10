const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Backend, watchStall, budgetForWindow, nativeRoot } = require('../src/main/ai/backend');
const { runTurn } = require('../src/main/ai/agent');

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body ? JSON.parse(body) : null));
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}/v1` }));
  });
}
const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

test('budgetForWindow leaves room for the reply and never exceeds the configured budget', () => {
  assert.strictEqual(budgetForWindow(8192, 0), 8192 - 2048);
  assert.strictEqual(budgetForWindow(32768, 0), 32768 - 4096);
  assert.strictEqual(budgetForWindow(32768, 16000), 16000);
  assert.strictEqual(budgetForWindow(4096, 16000), 4096 - 1024, 'a smaller live window wins');
  assert.strictEqual(budgetForWindow(0, 16000), 16000);
  assert.strictEqual(nativeRoot('http://h:11434/v1/'), 'http://h:11434');
});

test('Ollama: residency and window from /api/ps; eviction seen; keep_alive sent', async () => {
  let resident = true;
  const posted = [];
  const { s, url } = await server((req, res, body) => {
    if (req.url === '/api/ps') return json(res, { models: resident ? [{ name: 'qwen3:8b', model: 'qwen3:8b', context_length: 8192 }] : [] });
    if (req.url === '/api/generate') { posted.push(body); return json(res, { done: true }); }
    json(res, {}, 404);
  });
  try {
    const b = new Backend({ baseUrl: url });
    assert.deepStrictEqual(await b.status('qwen3:8b'), { loaded: true, window: 8192, others: [] });
    assert.strictEqual(b.kind, 'ollama');
    resident = false;
    b.cache = null;
    assert.deepStrictEqual(await b.status('qwen3:8b'), { loaded: false, window: 0, others: [] });
    assert.strictEqual(await b.keepAlive('qwen3:8b', '30m'), true);
    assert.deepStrictEqual(posted, [{ model: 'qwen3:8b', keep_alive: '30m' }]);
  } finally { s.close(); }
});

test('LM Studio: state and loaded window from /api/v0/models', async () => {
  const { s, url } = await server((req, res) => {
    if (req.url === '/api/ps') return json(res, { error: 'no' }, 404);
    if (req.url === '/api/v0/models') return json(res, { data: [{ id: 'llama-3.1-8b', state: 'loaded', max_context_length: 131072, loaded_context_length: 16384 }, { id: 'other', state: 'not-loaded', max_context_length: 4096 }] });
    json(res, {}, 404);
  });
  try {
    const b = new Backend({ baseUrl: url });
    assert.deepStrictEqual(await b.status('llama-3.1-8b'), { loaded: true, window: 16384 });
    assert.strictEqual(b.kind, 'lmstudio');
    b.cache = null;
    assert.deepStrictEqual(await b.status('other'), { loaded: false, window: 0 });
    assert.strictEqual(await b.keepAlive('other'), false, 'keep_alive is Ollama only');
  } finally { s.close(); }
});

test('a server that reports nothing is asked once, then left alone', async () => {
  let hits = 0;
  const { s, url } = await server((req, res) => { hits++; json(res, {}, 404); });
  try {
    const b = new Backend({ baseUrl: url });
    assert.strictEqual(await b.status('m'), null);
    assert.strictEqual(b.kind, null);
    const before = hits;
    assert.strictEqual(await b.status('m'), null);
    assert.strictEqual(hits, before, 'no further requests');
  } finally { s.close(); }
  assert.strictEqual(await new Backend({ baseUrl: 'http://127.0.0.1:9/v1' }).status('m'), null, 'unreachable: null, no throw');
});

test('watchStall reports silence at the first threshold and at 4x, and clears on output', async () => {
  let t = 0;
  const reports = [];
  const seen = [];
  const w = watchStall((d) => seen.push(d), (stage, idle) => reports.push([stage, idle]), { first: 100, now: () => t, every: 5 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  t = 50; await wait(20);
  assert.deepStrictEqual(reports, []);
  t = 120; await wait(20);
  assert.deepStrictEqual(reports, [[1, 120]]);
  t = 410; await wait(20);
  assert.deepStrictEqual(reports, [[1, 120], [2, 410]]);
  w.onText('hi');
  assert.deepStrictEqual(reports[2], [0, 0], 'cleared when tokens arrive');
  assert.deepStrictEqual(seen, ['hi']);
  w.stop();
});

test('agent loop: the live window shrinks the context budget before the call', async () => {
  const seenBudgets = [];
  const conv = { id: 'c', messages: [{ role: 'user', content: 'hello' }] };
  const provider = { chat: async () => ({ text: 'hi', toolCalls: [] }) };
  const events = [];
  await runTurn({
    provider, model: 'm', conversation: conv, permit: async () => true, signal: null,
    ctx: { settings: () => ({ ai: {} }), append: (m) => conv.messages.push(m) },
    emit: (e) => { events.push(e); if (e.type === 'context') seenBudgets.push(e.budget); },
    context: { budget: 16000, checkBackend: async () => ({ loaded: true, window: 4096 }) }
  });
  assert.deepStrictEqual(seenBudgets, [3072]);
  assert.ok(events.some((e) => e.type === 'stall' && e.stage === 0), 'stall state cleared after the call');
});

test('Ollama: another resident model is named, unload() frees it, and fresh status skips the cache', async () => {
  let resident = ['big:q5'];
  const posted = [];
  const { s, url } = await server((req, res, body) => {
    if (req.url === '/api/ps') return json(res, { models: resident.map((n) => ({ name: n, model: n, context_length: 32768 })) });
    if (req.url === '/api/generate') { posted.push(body); if (body.keep_alive === 0) resident = resident.filter((n) => n !== body.model); return json(res, { done: true }); }
    json(res, {}, 404);
  });
  try {
    const b = new Backend({ baseUrl: url });
    assert.deepStrictEqual(await b.status('small:q4'), { loaded: false, window: 0, others: ['big:q5'] });
    assert.strictEqual(await b.unload('big:q5'), true);
    assert.deepStrictEqual(posted, [{ model: 'big:q5', keep_alive: 0 }]);
    resident.push('small:q4');
    assert.deepStrictEqual(await b.status('small:q4', { fresh: true }), { loaded: true, window: 32768, others: [] });
  } finally { s.close(); }
});

test('agent: a stalled step restarted from outside is sent again, not stopped', async () => {
  const conv = { messages: [{ role: 'user', content: 'hi' }] };
  const ctx = { settings: () => ({ dock: 'right', theme: {} }), plugins: () => [], append: (m) => conv.messages.push(m) };
  let calls = 0;
  let restart = null;
  const provider = {
    chat: ({ signal }) => {
      calls++;
      if (calls === 1) {
        // The first request hangs until it is aborted.
        return new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      return Promise.resolve({ text: 'Loaded and answered.', toolCalls: [], stopReason: 'end_turn' });
    }
  };
  const events = [];
  const p = runTurn({ provider, model: 'small:q4', conversation: conv, ctx, permit: async () => true, emit: (e) => events.push(e),
    context: { registerStep: (fn) => { if (fn) restart = fn; } } });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(restart, 'the step registered a restart');
  restart();
  const r = await p;
  assert.ok(r.done && !r.stopped);
  assert.strictEqual(calls, 2);
  assert.strictEqual(conv.messages[conv.messages.length - 1].content, 'Loaded and answered.');
  assert.ok(events.some((e) => e.type === 'notice' && /again now that the server is free/.test(e.text)));
});
