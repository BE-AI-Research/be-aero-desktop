const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ctxbuf = require('../src/main/ai/context');
const { chatWithRetry, isRetryable, isAuthError } = require('../src/main/ai/resilience');
const { parseUnixBase, socketFetch } = require('../src/main/ai/transport');
const { OpenAiCompatProvider, PRESETS } = require('../src/main/ai/providers');
const { Conversations } = require('../src/main/ai/conversations');
const { compactConversation } = require('../src/main/ai/agent');

function convo(n, big = 3000) {
  const messages = [];
  for (let i = 0; i < n; i++) {
    messages.push({ role: 'user', content: `question ${i}` });
    messages.push({ role: 'assistant', content: 'looking', toolCalls: [{ id: `c${i}`, name: 'read_file', input: { path: `/f${i}` } }] });
    messages.push({ role: 'tool', results: [{ id: `c${i}`, name: 'read_file', content: 'x'.repeat(big), isError: false, images: [{ mime: 'image/png', data: 'AAAA' }] }] });
    messages.push({ role: 'assistant', content: `answer ${i}` });
  }
  return { id: 'c', messages };
}

test('budgetFor: configured wins, local providers default small', () => {
  assert.strictEqual(ctxbuf.budgetFor('ollama', 'openai', 0, true), ctxbuf.DEFAULT_BUDGETS.local);
  assert.strictEqual(ctxbuf.budgetFor('anthropic', 'anthropic', 0, false), ctxbuf.DEFAULT_BUDGETS.anthropic);
  assert.strictEqual(ctxbuf.budgetFor('openai', 'openai', 0, false), ctxbuf.DEFAULT_BUDGETS.openai);
  assert.strictEqual(ctxbuf.budgetFor('ollama', 'openai', 8000, true), 8000);
  assert.strictEqual(ctxbuf.budgetFor('ollama', 'openai', 10, true), 2000, 'floor');
});

test('collapseOld stubs old tool results and drops their images, keeps the tail', () => {
  const c = convo(4);
  const out = ctxbuf.collapseOld(c.messages, 4);
  assert.strictEqual(out[2].results[0].content, ctxbuf.STUB);
  assert.ok(!out[2].results[0].images);
  const tail = out[out.length - 2];
  assert.strictEqual(tail.results[0].content.length, 3000, 'newest result intact');
  assert.strictEqual(c.messages[2].results[0].content.length, 3000, 'source untouched');
});

test('prepare: under budget passes through; over budget collapses then asks for compaction', () => {
  const small = convo(1, 200);
  const p1 = ctxbuf.prepare(small, { budget: 16000 });
  assert.strictEqual(p1.collapsed, false);
  assert.strictEqual(p1.needsCompaction, false);
  assert.strictEqual(p1.messages.length, 4);

  const mid = convo(6, 6000);
  const p2 = ctxbuf.prepare(mid, { budget: 16000 });
  assert.strictEqual(p2.collapsed, true);
  assert.strictEqual(p2.needsCompaction, false, 'collapsing was enough');

  const huge = convo(30, 6000);
  for (const m of huge.messages) if (m.role === 'assistant') m.content = 'y'.repeat(2500);
  const p3 = ctxbuf.prepare(huge, { budget: 8000 });
  assert.strictEqual(p3.needsCompaction, true);
});

test('prepare carries the compaction summary ahead of the remaining messages', () => {
  const c = convo(3, 100);
  c.summary = 'User wants dark mode; theme set to midnight.';
  c.compactedAt = 8;
  const p = ctxbuf.prepare(c, { budget: 16000 });
  assert.strictEqual(p.messages[0].role, 'user');
  assert.match(p.messages[0].content, /midnight/);
  assert.strictEqual(p.messages[1].role, 'assistant');
  assert.strictEqual(p.messages.length, 2 + 4);
  assert.strictEqual(p.messages[2].content, 'question 2');
});

test('splitForCompaction cuts at a user message so tool exchanges stay whole', () => {
  const c = convo(3, 100);
  const s = ctxbuf.splitForCompaction(c.messages, 3);
  assert.ok(s);
  assert.strictEqual(s.tail[0].role, 'user');
  assert.strictEqual(s.tail[0].content, 'question 2');
  assert.strictEqual(s.head.length + s.tail.length, c.messages.length);
  assert.strictEqual(ctxbuf.splitForCompaction(c.messages.slice(0, 3), 4), null);
});

test('summaryRequest folds in the prior summary and keeps the newest transcript lines', () => {
  const c = convo(40, 50);
  const req = ctxbuf.summaryRequest('earlier: set theme', c.messages);
  assert.match(req.messages[0].content, /earlier: set theme/);
  assert.match(req.messages[0].content, /question 39/);
  assert.ok(req.messages[0].content.length < 30000);
});

test('Calibration learns chars-per-token from reported usage, bounded', () => {
  const cal = new ctxbuf.Calibration();
  assert.strictEqual(cal.observe(100, 50), ctxbuf.DEFAULT_CHARS_PER_TOKEN, 'too little text to trust');
  assert.strictEqual(cal.observe(4000, 1000), 4);
  assert.ok(Math.abs(cal.observe(4000, 2000) - 3) < 1e-9, 'smoothed');
  assert.strictEqual(cal.observe(100000, 1), 8, 'upper bound');
});

test('compactConversation records summary and offset on the conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-ctx-'));
  const store = new Conversations(dir);
  const c = store.create('t');
  for (const m of convo(4, 100).messages) store.append(c.id, m);
  const provider = { chat: async (req) => { assert.strictEqual(req.tools.length, 0); return { text: 'SUMMARY: four questions answered.', toolCalls: [] }; } };
  const ctx = { compact: (summary, at) => store.setSummary(c.id, summary, at) };
  const ok = await compactConversation({ provider, model: 'm', conversation: store.get(c.id), ctx, emit: () => {}, keepTail: 4 });
  assert.strictEqual(ok, true);
  const after = store.get(c.id);
  assert.strictEqual(after.summary, 'SUMMARY: four questions answered.');
  assert.strictEqual(after.compactedAt, 12);
  assert.strictEqual(after.messages.length, 16, 'history kept');
  const p = ctxbuf.prepare(after, { budget: 16000 });
  assert.strictEqual(p.messages.length, 2 + 4);
  // An empty summary is a failure, not a compaction.
  const bad = { chat: async () => ({ text: '  ', toolCalls: [] }) };
  assert.strictEqual(await compactConversation({ provider: bad, model: 'm', conversation: store.get(c.id), ctx, emit: () => {}, keepTail: 1 }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isRetryable: connection and 5xx/429 retry; 4xx, auth and aborts do not', () => {
  assert.strictEqual(isRetryable(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434')), true);
  assert.strictEqual(isRetryable(Object.assign(new Error('503 from x'), { status: 503 })), true);
  assert.strictEqual(isRetryable(Object.assign(new Error('429 from x'), { status: 429 })), true);
  assert.strictEqual(isRetryable(new Error('model is loading, try again')), true);
  assert.strictEqual(isRetryable(Object.assign(new Error('400 from x: bad request'), { status: 400 })), false);
  assert.strictEqual(isRetryable(Object.assign(new Error('401 from x'), { status: 401 })), false);
  assert.strictEqual(isAuthError(new Error('invalid api key')), true);
  assert.strictEqual(isRetryable(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
  assert.strictEqual(isRetryable(new Error('No server URL configured for this provider.')), false);
});

test('chatWithRetry retries transient failures with backoff and honours Retry-After', async () => {
  let calls = 0;
  const waits = [];
  const events = [];
  const provider = { chat: async () => {
    calls++;
    if (calls === 1) throw new Error('fetch failed: ECONNRESET');
    if (calls === 2) throw Object.assign(new Error('429 from s'), { status: 429, retryAfter: 2 });
    return { text: 'ok', toolCalls: [] };
  } };
  const res = await chatWithRetry(provider, {}, { emit: (e) => events.push(e), wait: async (ms) => { waits.push(ms); }, baseDelay: 1000 });
  assert.strictEqual(res.text, 'ok');
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(waits, [1000, 2000]);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].type, 'retry');
  assert.strictEqual(events[1].attempt, 2);

  const dead = { chat: async () => { throw new Error('fetch failed'); } };
  await assert.rejects(chatWithRetry(dead, {}, { wait: async () => {}, maxRetries: 2 }), /fetch failed/);
  const auth = { chat: async () => { throw Object.assign(new Error('401 from s'), { status: 401 }); } };
  let n = 0;
  await assert.rejects(chatWithRetry({ chat: async () => { n++; return auth.chat(); } }, {}, { wait: async () => {} }), /401/);
  assert.strictEqual(n, 1, 'a rejected key is never retried');
});

test('parseUnixBase reads unix:// URLs and expands ~', () => {
  assert.strictEqual(parseUnixBase('http://localhost:1234/v1'), null);
  assert.strictEqual(parseUnixBase('unix:///tmp/api.sock'), '/tmp/api.sock');
  assert.strictEqual(parseUnixBase('unix://~/.be-code/api/api.sock'), path.join(os.homedir(), '.be-code', 'api', 'api.sock'));
  assert.ok(PRESETS.becode.baseUrl.startsWith('unix://'));
  assert.strictEqual(PRESETS.becode.noTools, true);
});

test('OpenAI adapter speaks over a Unix socket (BE-Code transport)', async (t) => {
  const sock = process.platform === 'win32'
    ? path.join(os.tmpdir(), `aero-${process.pid}-${Date.now()}.sock`)
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aero-sock-')), 'api.sock');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/v1/models') { res.writeHead(404); res.end('{"error":"no"}'); return; }
      if (req.url === '/v1/chat/completions' && req.headers.authorization === 'Bearer k1') {
        const parsed = JSON.parse(body);
        assert.strictEqual(parsed.model, 'default');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(401); res.end('{"error":{"code":"bad_key"}}');
    });
  });
  const listening = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(sock, () => resolve(true));
  });
  if (!listening) { t.skip('AF_UNIX not available here'); return; }
  try {
    const p = new OpenAiCompatProvider({ apiKey: 'k1', baseUrl: `unix://${sock}` });
    assert.deepStrictEqual(await p.listModels(), ['default'], '404 on /models means the session model');
    let streamed = '';
    const r = await p.chat({ model: 'default', system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], onText: (d) => { streamed += d; } });
    assert.strictEqual(r.text, 'hello');
    assert.strictEqual(streamed, 'hello');
    const bad = new OpenAiCompatProvider({ apiKey: 'nope', baseUrl: `unix://${sock}` });
    await assert.rejects(bad.chat({ model: 'default', system: '', messages: [{ role: 'user', content: 'x' }] }), (err) => err.status === 401);
    // A socket nobody serves is a connection failure the retry loop recognises.
    const gone = new OpenAiCompatProvider({ apiKey: 'k1', baseUrl: `unix://${sock}.missing` });
    await assert.rejects(gone.listModels(), (err) => isRetryable(err));
    const raw = await socketFetch(sock, '/v1/models', { headers: {} });
    assert.strictEqual(raw.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    try { fs.unlinkSync(sock); } catch { /* gone */ }
  }
});
