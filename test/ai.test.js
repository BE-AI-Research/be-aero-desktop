const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  toAnthropicMessages, toOpenAiMessages, toOpenAiTools, applyOpenAiDelta, finishOpenAiState, OpenAiCompatProvider, PRESETS
} = require('../src/main/ai/providers');
const tools = require('../src/main/ai/tools');
const { Conversations, titleFrom } = require('../src/main/ai/conversations');
const { runTurn, windowMessages, systemPrompt } = require('../src/main/ai/agent');

const sample = [
  { role: 'user', content: 'make it dark' },
  { role: 'assistant', content: 'Sure.', toolCalls: [{ id: 't1', name: 'set_settings', input: { patch: { theme: { preset: 'midnight' } } } }] },
  { role: 'tool', results: [{ id: 't1', name: 'set_settings', content: '{"ok":true}', isError: false }] },
  { role: 'assistant', content: 'Done.' }
];

test('Anthropic translation keeps tool_use / tool_result pairing', () => {
  const out = toAnthropicMessages(sample);
  assert.strictEqual(out[1].role, 'assistant');
  assert.deepStrictEqual(out[1].content[1], { type: 'tool_use', id: 't1', name: 'set_settings', input: { patch: { theme: { preset: 'midnight' } } } });
  assert.strictEqual(out[2].role, 'user');
  assert.strictEqual(out[2].content[0].type, 'tool_result');
  assert.strictEqual(out[2].content[0].tool_use_id, 't1');
  assert.ok(!('is_error' in out[2].content[0]), 'no is_error on success');
});

test('OpenAI translation emits system, tool_calls and tool messages', () => {
  const out = toOpenAiMessages('persona', sample);
  assert.deepStrictEqual(out[0], { role: 'system', content: 'persona' });
  assert.strictEqual(out[2].tool_calls[0].function.name, 'set_settings');
  assert.strictEqual(JSON.parse(out[2].tool_calls[0].function.arguments).patch.theme.preset, 'midnight');
  assert.deepStrictEqual(out[3], { role: 'tool', tool_call_id: 't1', content: '{"ok":true}' });
  assert.strictEqual(toOpenAiTools(tools.definitions())[0].type, 'function');
});

test('OpenAI stream deltas accumulate text and chunked tool calls', () => {
  const st = { text: '', calls: [], finish: null };
  applyOpenAiDelta(st, { choices: [{ delta: { content: 'Hel' } }] });
  applyOpenAiDelta(st, { choices: [{ delta: { content: 'lo' } }] });
  applyOpenAiDelta(st, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_', arguments: '{"a"' } }] } }] });
  applyOpenAiDelta(st, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'scratchpad', arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] });
  const fin = finishOpenAiState(st);
  assert.strictEqual(fin.text, 'Hello');
  assert.deepStrictEqual(fin.toolCalls, [{ id: 'c1', name: 'read_scratchpad', input: { a: 1 } }]);
  assert.strictEqual(fin.stopReason, 'tool_use');
});

test('OpenAI-compatible provider parses an SSE response end to end', async () => {
  const lines = [
    'data: {"choices":[{"delta":{"content":"Hi "}}]}',
    'data: {"choices":[{"delta":{"content":"there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
    'data: [DONE]', ''
  ].join('\n');
  const fakeFetch = async () => ({
    ok: true, headers: { get: () => 'text/event-stream' },
    body: { getReader: () => { let sent = false; return { read: async () => sent ? { done: true } : (sent = true, { value: new TextEncoder().encode(lines), done: false }) }; } }
  });
  const p = new OpenAiCompatProvider({ baseUrl: 'http://localhost:11434/v1/', fetchImpl: fakeFetch });
  const got = [];
  const res = await p.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }], onText: (d) => got.push(d) });
  assert.strictEqual(res.text, 'Hi there');
  assert.deepStrictEqual(got, ['Hi ', 'there']);
  assert.strictEqual(res.stopReason, 'end_turn');
  assert.deepStrictEqual(res.usage, { input: 5, output: 2 });
  assert.strictEqual(p.baseUrl, 'http://localhost:11434/v1', 'trailing slash trimmed');
  assert.ok(PRESETS.ollama.baseUrl.includes('11434'));
});

test('tool registry: schemas validate, secrets are never readable, settings are whitelisted', async () => {
  assert.strictEqual(tools.validateInput('search', { query: 'notepad' }), null);
  assert.match(tools.validateInput('search', {}), /missing required/);
  assert.match(tools.validateInput('web_scroll', { id: 'w1', dy: 'ten' }), /must be a number/);
  assert.match(tools.validateInput('write_scratchpad', { text: 'x', mode: 'prepend' }), /one of/);
  assert.strictEqual(tools.categoryOf('read_telemetry'), 'read');
  assert.strictEqual(tools.categoryOf('web_eval'), 'control');

  const settings = { theme: { preset: 'aero' }, api: { token: 'SECRET' }, certTrust: {}, ai: { apiKey: 'enc:x' }, plugins: { enabled: {}, grants: { x: 1 } }, widgets: { clock: true } };
  const clean = tools.sanitizeSettings(settings);
  assert.ok(!('api' in clean) && !('ai' in clean) && !('certTrust' in clean));
  assert.ok(!('grants' in clean.plugins));

  const applied = [];
  const ctx = { settings: () => settings, updateSettings: (p) => applied.push(p) };
  const r = await tools.execute('set_settings', { patch: { theme: { preset: 'mono' }, api: { token: 'evil' }, ai: { enabled: false } } }, ctx);
  assert.deepStrictEqual(applied, [{ theme: { preset: 'mono' } }]);
  assert.deepStrictEqual(r.refused, ['api', 'ai']);
});

test('conversations persist, title themselves, and survive reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-ai-'));
  const store = new Conversations(dir);
  const c = store.create();
  store.append(c.id, { role: 'user', content: 'What is the weather like in Berlin tomorrow morning, roughly?' });
  store.append(c.id, { role: 'assistant', content: 'Mild.' });
  assert.ok(c.title.startsWith('What is the weather'));
  const fresh = new Conversations(dir);
  const again = fresh.get(c.id);
  assert.strictEqual(again.messages.length, 2);
  assert.strictEqual(fresh.list()[0].id, c.id);
  fresh.remove(c.id);
  assert.deepStrictEqual(fresh.list(), []);
  assert.throws(() => store.file('../../etc/passwd'), /bad conversation id/);
  assert.strictEqual(titleFrom(''), 'New conversation');
});

test('agent loop: tool call -> permission -> result -> final answer, with denial handled', async () => {
  const settings = { dock: 'right', theme: { preset: 'aero' }, scratchpad: '', widgets: { clock: true }, ai: { systemPrompt: 'You are Jarvis.' } };
  const conv = { messages: [{ role: 'user', content: 'note: buy milk' }] };
  const applied = [];
  const ctx = {
    settings: () => settings, updateSettings: (p) => { applied.push(p); Object.assign(settings, p); },
    plugins: () => [], append: (m) => conv.messages.push(m)
  };
  let turn = 0;
  const provider = {
    chat: async ({ system, messages, onText }) => {
      assert.ok(system.startsWith('You are Jarvis.'), 'persona leads the system prompt');
      turn++;
      if (turn === 1) return { text: '', toolCalls: [{ id: 'a', name: 'write_scratchpad', input: { text: 'buy milk' } }, { id: 'b', name: 'set_settings', input: { patch: { theme: { preset: 'mono' } } } }], stopReason: 'tool_use' };
      const last = messages[messages.length - 1];
      assert.strictEqual(last.role, 'tool');
      assert.strictEqual(last.results.length, 2);
      assert.ok(!last.results[0].isError && last.results[1].isError, 'second call was denied');
      onText('Noted.');
      return { text: 'Noted.', toolCalls: [], stopReason: 'end_turn' };
    }
  };
  const events = [];
  const result = await runTurn({
    provider, model: 'm', conversation: conv, ctx, emit: (e) => events.push(e),
    permit: async (call) => call.name === 'write_scratchpad'
  });
  assert.ok(result.done);
  assert.strictEqual(settings.scratchpad, 'buy milk');
  assert.deepStrictEqual(applied, [{ scratchpad: 'buy milk' }], 'denied set_settings never ran');
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'set_settings' && e.ok === false));
  assert.strictEqual(events.filter((e) => e.type === 'delta').length, 1);
  assert.strictEqual(conv.messages.length, 4);
});

test('agent loop: provider errors are reported, not thrown; invalid inputs bounce back', async () => {
  const conv = { messages: [{ role: 'user', content: 'x' }] };
  const ctx = { settings: () => ({ dock: 'right', theme: {} }), append: (m) => conv.messages.push(m), plugins: () => [] };
  const events = [];
  const bad = { chat: async () => { throw new Error('boom'); }, describeError: (e) => `described: ${e.message}` };
  const r = await runTurn({ provider: bad, model: 'm', conversation: conv, ctx, emit: (e) => events.push(e), permit: async () => true });
  assert.strictEqual(r.error, 'described: boom');

  let n = 0;
  const sloppy = { chat: async ({ messages }) => {
    n++;
    if (n === 1) return { text: '', toolCalls: [{ id: 'q', name: 'web_scroll', input: { id: 'w' } }], stopReason: 'tool_use' };
    assert.match(messages[messages.length - 1].results[0].content, /missing required field "dy"/);
    return { text: 'ok', toolCalls: [], stopReason: 'end_turn' };
  } };
  const conv2 = { messages: [{ role: 'user', content: 'y' }] };
  const ctx2 = { ...ctx, append: (m) => conv2.messages.push(m) };
  const r2 = await runTurn({ provider: sloppy, model: 'm', conversation: conv2, ctx: ctx2, emit: () => {}, permit: async () => true });
  assert.ok(r2.done);
});

test('windowMessages never starts on a dangling tool result', () => {
  const msgs = [];
  for (let i = 0; i < 70; i++) msgs.push(i % 3 === 2 ? { role: 'tool', results: [] } : { role: i % 3 ? 'assistant' : 'user', content: String(i) });
  const w = windowMessages(msgs);
  assert.ok(w.length <= 60);
  assert.notStrictEqual(w[0].role, 'tool');
  assert.ok(systemPrompt({ settings: () => ({ dock: 'free', theme: {} }) }).includes('layout mode "free"'));
});

const ws = require('../src/main/ai/websearch');

test('web search parsing: DuckDuckGo redirect targets are unwrapped, html reduced to text', () => {
  const html = '<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">First <b>hit</b></a>'
    + '<a class="result__snippet" href="x">Snippet &amp; more</a></div>'
    + '<div class="result"><a class="result__a" href="https://example.org/b">Second</a><div class="result__snippet">Two</div></div>';
  const r = ws.parseDuckDuckGo(html);
  assert.deepStrictEqual(r.map((x) => x.url), ['https://example.com/a', 'https://example.org/b']);
  assert.strictEqual(r[0].title, 'First hit');
  assert.strictEqual(r[0].snippet, 'Snippet & more');
  assert.strictEqual(ws.htmlToText('<nav>menu</nav><h1>Title</h1><p>Body &lt;x&gt;</p><style>p{}</style>'), 'Title\nBody <x>');
  assert.strictEqual(ws.titleOf('<html><title> My &amp; Page </title>'), 'My & Page');
});

test('web search / fetch_url use injected fetch and never throw', async () => {
  const fake = async (url) => ({
    ok: true, status: 200, url,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => url.includes('duckduckgo')
      ? '<a class="result__a" href="https://x.test/p">X</a><div class="result__snippet">s</div>'
      : '<title>Page</title><body><p>hello</p><script>bad()</script></body>'
  });
  const s = await ws.webSearch('q', { fetchImpl: fake, count: 5 });
  assert.strictEqual(s.results[0].url, 'https://x.test/p');
  const p = await ws.fetchPage('https://x.test/p', { fetchImpl: fake });
  assert.strictEqual(p.title, 'Page');
  assert.strictEqual(p.text, 'hello');
  const bad = await ws.fetchPage('ftp://nope', { fetchImpl: fake });
  assert.match(bad.error, /http\(s\)/);
  const down = await ws.webSearch('q', { fetchImpl: async () => { throw new Error('offline'); } });
  assert.match(down.error, /offline/);
});

test('round-2 tools validate and route through the context', async () => {
  assert.strictEqual(tools.validateInput('send_keys', { keys: '^s' }), null);
  assert.strictEqual(tools.validateInput('exec_capture', { command: 'dir', timeoutSec: 5 }), null);
  assert.match(tools.validateInput('web_select', { id: 'w', selector: 'select' }), /missing required field "value"/);
  assert.strictEqual(tools.categoryOf('web_search'), 'read');
  assert.strictEqual(tools.categoryOf('exec_capture'), 'control');
  const calls = [];
  const ctx = {
    tasks: { action: async (n, id) => { calls.push([n, id]); return true; } },
    sendKeys: async (a) => { calls.push(['keys', a]); return { ok: true }; },
    clipboard: { read: () => 'clip', write: (t) => calls.push(['clip', t]) },
    webOp: async (id, op, args) => ({ ok: true, id, op, args })
  };
  assert.deepStrictEqual(await tools.execute('maximize_app', { id: 7 }, ctx), { ok: true });
  assert.deepStrictEqual(await tools.execute('clipboard_read', {}, ctx), { text: 'clip' });
  await tools.execute('send_keys', { text: 'hi', keys: '{ENTER}' }, ctx);
  const r = await tools.execute('web_wait', { id: 'w1', selector: '#done', ms: 500 }, ctx);
  assert.strictEqual(r.op, 'wait');
  assert.deepStrictEqual(calls[0], ['maximize', 7]);
  assert.deepStrictEqual(calls[1], ['keys', { text: 'hi', keys: '{ENTER}' }]);
  const none = await tools.execute('send_keys', {}, ctx);
  assert.strictEqual(none.ok, false);
});

const attachments = require('../src/main/ai/attachments');

test('attachments: kinds, rendering per provider, size limits and missing files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-att-'));
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Title\nbody text');
  fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.from([137, 80, 78, 71, 13, 10]));
  fs.writeFileSync(path.join(dir, 'doc.pdf'), Buffer.from('%PDF-1.4 fake'));
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.alloc(16));
  const [md, png, pdf, bin] = ['notes.md', 'pic.png', 'doc.pdf', 'blob.bin'].map((n) => attachments.describe(path.join(dir, n)));
  assert.deepStrictEqual([md.kind, png.kind, pdf.kind, bin.kind], ['text', 'image', 'pdf', 'other']);
  assert.strictEqual(png.mime, 'image/png');

  const a = attachments.toAnthropicContent('summarize', [md, png, pdf, bin]);
  assert.deepStrictEqual(a.map((b) => b.type), ['text', 'image', 'document', 'text', 'text']);
  assert.strictEqual(a[1].source.media_type, 'image/png');
  assert.strictEqual(a[2].source.media_type, 'application/pdf');
  assert.match(a[0].text, /# Title/);
  assert.strictEqual(a[4].text, 'summarize');

  const o = attachments.toOpenAiContent('', [png, pdf]);
  assert.strictEqual(o[0].type, 'image_url');
  assert.ok(o[0].image_url.url.startsWith('data:image/png;base64,'));
  assert.match(o[1].text, /cannot read PDFs/);
  assert.strictEqual(o[2].text, '(see attachments)', 'empty text still yields a user turn');

  const gone = attachments.render({ name: 'x.txt', path: path.join(dir, 'missing.txt'), kind: 'text', size: 1, mime: 'text/plain' });
  assert.match(gone[0].text, /no longer available/);
  const big = attachments.render({ name: 'huge.png', path: path.join(dir, 'pic.png'), kind: 'image', size: attachments.MAX_IMAGE_BYTES + 1, mime: 'image/png' });
  assert.match(big[0].text, /over the .* limit/);
});

test('provider translation carries attachments on user turns only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-att2-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha');
  const att = attachments.describe(path.join(dir, 'a.txt'));
  const msgs = [{ role: 'user', content: 'read this', attachments: [att] }, { role: 'assistant', content: 'ok' }];
  const an = toAnthropicMessages(msgs);
  assert.strictEqual(an[0].content.length, 2);
  assert.match(an[0].content[0].text, /alpha/);
  const oa = toOpenAiMessages('', msgs);
  assert.ok(Array.isArray(oa[0].content) && oa[0].content[1].text === 'read this');
  assert.strictEqual(typeof oa[1].content, 'string');
});
