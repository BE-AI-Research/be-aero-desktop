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
