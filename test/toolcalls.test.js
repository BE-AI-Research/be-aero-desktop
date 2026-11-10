const test = require('node:test');
const assert = require('node:assert');
const tc = require('../src/main/ai/toolcalls');
const { runTurn } = require('../src/main/ai/agent');
const { applyOpenAiDelta, finishOpenAiState, toOpenAiMessages } = require('../src/main/ai/providers');

const DEFS = [
  { name: 'web_search', description: 'search', input_schema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'integer' } }, required: ['query'] } },
  { name: 'notify', description: 'notify', input_schema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] } },
  { name: 'write_scratchpad', description: 'write', input_schema: { type: 'object', properties: { text: { type: 'string' }, append: { type: 'boolean' } }, required: ['text'] } }
];

test('profiles: longest match wins, vendors are anchored', () => {
  assert.strictEqual(tc.profileFor('hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL').family, 'qwen3');
  assert.strictEqual(tc.profileFor('hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL').stripThink, true);
  assert.strictEqual(tc.profileFor('deepseek-r1:14b-qwen-distill-q4_K_M').family, 'deepseek-r1');
  assert.strictEqual(tc.profileFor('gemma4:e4b').compat, 'always');
  assert.strictEqual(tc.profileFor('codellama:7b').family, 'codellama');
  assert.strictEqual(tc.profileFor('Qwen3-Claude-Distill').family, 'qwen3', 'claude is anchored');
  assert.strictEqual(tc.profileFor('anthropic/claude-opus').family, 'claude');
  assert.strictEqual(tc.profileFor('some-new-model').family, 'generic');
});

test('Qwen XML layout (Qwen3-Coder / Qwen3.5+) becomes a real call with typed values', () => {
  const content = 'Let me look that up.\n<tool_call>\n<function=web_search>\n<parameter=query>\nColwood weather alerts\n</parameter>\n<parameter=count>\n5\n</parameter>\n</function>\n</tool_call>';
  const r = tc.parseEmbeddedCalls(content, DEFS);
  assert.deepStrictEqual(r.calls.map((c) => [c.name, c.input]), [['web_search', { query: 'Colwood weather alerts', count: 5 }]]);
  assert.strictEqual(r.text, 'Let me look that up.');
  // Without the <tool_call> wrapper, and a multi-line value kept verbatim.
  const r2 = tc.parseEmbeddedCalls('<function=write_scratchpad>\n<parameter=text>\nline 1\n\nline 3\n</parameter>\n</function>', DEFS);
  assert.deepStrictEqual(r2.calls[0].input, { text: 'line 1\n\nline 3' });
});

test('JSON in <tool_call> tags, fenced JSON, field-name variants, double encoding', () => {
  const a = tc.parseEmbeddedCalls('<tool_call>{"name": "notify", "arguments": {"title": "Rain", "body": "Heavy"}}</tool_call>', DEFS);
  assert.deepStrictEqual(a.calls[0].input, { title: 'Rain', body: 'Heavy' });
  const b = tc.parseEmbeddedCalls('```json\n{"tool": "notify", "parameters": {"title": "x"}}\n```', DEFS);
  assert.deepStrictEqual([b.calls[0].name, b.calls[0].input], ['notify', { title: 'x' }]);
  const c = tc.parseEmbeddedCalls('<tool_call>{"name":"notify","arguments":"{\\"title\\":\\"double\\"}"}</tool_call>', DEFS);
  assert.deepStrictEqual(c.calls[0].input, { title: 'double' });
  const d = tc.parseEmbeddedCalls('<tool_call>{"name": "rm_rf", "arguments": {}}</tool_call>', DEFS);
  assert.strictEqual(d.calls.length, 0, 'unknown tools are not called');
});

test('Llama, Mistral and Gemma layouts', () => {
  const llama = tc.parseEmbeddedCalls('<|python_tag|>{"name": "web_search", "parameters": {"query": "pizza"}}', DEFS);
  assert.deepStrictEqual(llama.calls[0].input, { query: 'pizza' });
  const bare = tc.parseEmbeddedCalls('{"name": "web_search", "parameters": {"query": "tacos"}}', DEFS);
  assert.deepStrictEqual(bare.calls[0].input, { query: 'tacos' });
  const mistral = tc.parseEmbeddedCalls('[TOOL_CALLS] [{"name": "notify", "arguments": {"title": "a"}}, {"name": "web_search", "arguments": {"query": "b"}}]', DEFS);
  assert.deepStrictEqual(mistral.calls.map((c) => c.name), ['notify', 'web_search']);
  const gemma = tc.parseEmbeddedCalls('```tool_code\nweb_search(query="rain warning", count=3)\n```', DEFS);
  assert.deepStrictEqual(gemma.calls[0].input, { query: 'rain warning', count: 3 });
  const plain = tc.parseEmbeddedCalls('The forecast says {"name": "web_search"} is a function. Rain later.', DEFS);
  assert.strictEqual(plain.calls.length, 0, 'JSON inside prose is not a call');
});

test('forgiving argument parsing', () => {
  assert.deepStrictEqual(tc.parseArgs(''), {});
  assert.deepStrictEqual(tc.parseArgs('null'), {});
  assert.deepStrictEqual(tc.parseArgs({ a: 1 }), { a: 1 });
  assert.deepStrictEqual(tc.parseArgs('"{\\"a\\":1}"'), { a: 1 });
  assert.deepStrictEqual(tc.parseArgs('{"a": 1,}'), { a: 1 });
  assert.deepStrictEqual(tc.parseArgs("{'a': 'b'}"), { a: 'b' });
  assert.strictEqual(tc.parseArgs('[1,2]'), null);
});

test('thinking: stripped from final text and filtered from the stream across chunk boundaries', () => {
  assert.strictEqual(tc.stripThink('<think>plan plan</think>\nThe answer.'), 'The answer.');
  assert.strictEqual(tc.stripThink('Answer.<think>cut off mid-thou'), 'Answer.');
  assert.strictEqual(tc.stripThink('reasoning the template opened</think>\nVisible.'), 'Visible.');
  const f = new tc.ThinkFilter();
  const out = ['Hi <th', 'ink>secret ', 'stuff</thi', 'nk> there', '!'].map((d) => f.feed(d)).join('') + f.flush();
  assert.strictEqual(out, 'Hi  there!');
  assert.ok(f.thought > 0);
});

test('openEmbeddedCall and tools-unsupported detection', () => {
  assert.strictEqual(tc.openEmbeddedCall('ok <tool_call>{"name":"write'), true);
  assert.strictEqual(tc.openEmbeddedCall('<function=write_scratchpad>\n<parameter=text>\nhalf'), true);
  assert.strictEqual(tc.openEmbeddedCall('<tool_call>{}</tool_call>'), false);
  assert.strictEqual(tc.looksLikeToolsUnsupported(new Error('400 from x: model does not support tools')), true);
  assert.strictEqual(tc.looksLikeToolsUnsupported(new Error('connection refused')), false);
});

test('OpenAI stream: reasoning deltas, object arguments; compat transcript is plain text', () => {
  const st = { text: '', calls: [], finish: null, reasoning: '' };
  applyOpenAiDelta(st, { choices: [{ delta: { reasoning: 'thinking...' } }] });
  applyOpenAiDelta(st, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'notify', arguments: { title: 'obj' } } }] }, finish_reason: 'tool_calls' }] });
  const done = finishOpenAiState(st);
  assert.strictEqual(done.reasoning, 'thinking...');
  assert.deepStrictEqual(done.toolCalls[0].input, { title: 'obj' });
  const msgs = toOpenAiMessages('sys', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Checking.', toolCalls: [{ id: 'e0', name: 'notify', input: { title: 't' } }] },
    { role: 'tool', results: [{ id: 'e0', name: 'notify', content: '{"ok":true}' }] }
  ], { compat: true });
  assert.strictEqual(msgs[2].content, 'Checking.\n<tool_call>{"name":"notify","arguments":{"title":"t"}}</tool_call>');
  assert.deepStrictEqual(msgs[3], { role: 'user', content: '<tool_result name="notify" status="ok">{"ok":true}</tool_result>' });
  assert.ok(!msgs.some((m) => m.role === 'tool' || m.tool_calls), 'no native tool fields in compat mode');
});

// ---- the loop end to end, with a scripted provider
function loopRig(replies, { toolMode = 'auto', session = {}, model = 'qwen3:8b' } = {}) {
  const conv = { id: 'c', messages: [{ role: 'user', content: 'check the weather' }] };
  const requests = [];
  const events = [];
  const executed = [];
  let i = 0;
  const provider = {
    chat: async (req) => {
      requests.push(req);
      const r = replies[Math.min(i++, replies.length - 1)];
      if (r instanceof Error) throw r;
      if (r.stream) for (const d of r.stream) req.onText(d);
      if (r.reasoning && req.onReasoning) req.onReasoning(r.reasoning);
      return { text: r.text || (r.stream ? r.stream.join('') : ''), toolCalls: r.toolCalls || [], reasoning: r.reasoning || '' };
    }
  };
  const ctx = {
    settings: () => ({ ai: {} }), append: (m) => conv.messages.push(m),
    notify: (title, body) => { executed.push(['notify', title, body]); return true; }
  };
  const run = runTurn({ provider, model, conversation: conv, ctx, permit: async () => true, emit: (e) => events.push(e), signal: null, maxSteps: 6, context: { toolMode, session, budget: 16000 } });
  return { run, conv, requests, events, executed, session };
}

test('loop: a Qwen XML call in plain content is executed, not shown as the answer', async () => {
  const r = loopRig([
    { stream: ['<think>should notify</think>', 'Sending it.\n<tool_call>\n<function=notify>\n<parameter=title>\nRain warning\n</parameter>\n</function>\n</tool_call>'] },
    { text: 'Done - notification sent.' }
  ]);
  const out = await r.run;
  assert.strictEqual(out.done, true);
  assert.deepStrictEqual(r.executed, [['notify', 'Rain warning', '']]);
  const asst = r.conv.messages.filter((m) => m.role === 'assistant');
  assert.strictEqual(asst[0].content, 'Sending it.');
  assert.strictEqual(asst[0].toolCalls[0].name, 'notify');
  assert.ok(!r.events.some((e) => e.type === 'delta' && /think|should notify/.test(e.text)), 'thinking never streamed to the UI');
  assert.strictEqual(asst[1].content, 'Done - notification sent.');
});

test('loop: a server that rejects tools switches the session to text tool calls', async () => {
  const r = loopRig([
    Object.assign(new Error('400 from server: this model does not support tools'), { status: 400 }),
    { text: '<tool_call>{"name": "notify", "arguments": {"title": "x"}}</tool_call>' },
    { text: 'ok' }
  ]);
  await r.run;
  assert.strictEqual(r.session.compat, true);
  assert.ok(r.requests[0].tools.length > 0 && !r.requests[0].compat, 'first try native');
  assert.strictEqual(r.requests[1].compat, true);
  assert.deepStrictEqual(r.requests[1].tools, []);
  assert.match(r.requests[1].system, /Tool calling format/);
  assert.strictEqual(r.executed.length, 1);
});

test('loop: Gemma gets text tool calls from the start; empty replies and cut-off calls get one retry', async () => {
  const g = loopRig([{ text: 'Hello.' }], { model: 'gemma4:e4b' });
  await g.run;
  assert.strictEqual(g.requests[0].compat, true);
  const e = loopRig([{ text: '', reasoning: 'lots of thought' }, { text: 'Here you go.' }]);
  const out = await e.run;
  assert.strictEqual(out.done, true);
  assert.ok(e.events.some((x) => x.type === 'thinking'));
  assert.ok(e.conv.messages.some((m) => m.role === 'user' && /last reply was empty/.test(m.content)));
  const c = loopRig([{ text: '<tool_call>{"name": "notify", "argu' }, { text: '<tool_call>{"name": "notify", "arguments": {"title": "full"}}</tool_call>' }, { text: 'sent' }]);
  await c.run;
  assert.ok(c.conv.messages.some((m) => m.role === 'user' && /cut off/.test(m.content)));
  assert.deepStrictEqual(c.executed, [['notify', 'full', '']]);
});
