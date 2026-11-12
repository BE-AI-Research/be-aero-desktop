const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CustomTools } = require('../src/main/ai/custom-tools');
const tools = require('../src/main/ai/tools');

function mk(base, { answer = () => false, sandbox } = {}) {
  const asked = [];
  const ct = new CustomTools({
    folder: async () => path.join(base, 'BE-Aero AI'),
    approvalsFile: path.join(base, 'userdata', 'tool-approvals.json'),
    approve: async (t) => { asked.push(t.name); return answer(t); },
    sandbox: sandbox || (async (code, input) => ({ ok: true, output: { echo: input, len: code.length } }))
  });
  return { ct, asked };
}

test('tool workspace: sandbox tools save, load and run; names and code are checked', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-tools-'));
  try {
    const { ct, asked } = mk(base);
    await ct.load();
    const r = await ct.save({ name: 'c_to_f', description: 'Celsius to Fahrenheit', input_schema: { type: 'object', properties: { c: { type: 'number' } }, required: ['c'] }, code: 'async function run(input) { return { f: input.c * 9 / 5 + 32 }; }' }, { create: true });
    assert.strictEqual(r.approved, true, 'sandbox tools need no approval');
    assert.deepStrictEqual(asked, []);
    assert.ok(fs.existsSync(path.join(base, 'BE-Aero AI', 'AI Tools', 'c_to_f', 'index.js')));
    await assert.rejects(ct.save({ name: 'c_to_f', description: 'x', code: 'async function run(){}' }, { create: true }), /exists/);
    await assert.rejects(ct.save({ name: 'Bad Name', description: 'x', code: 'async function run(){}' }, { create: true }), /lowercase/);
    await assert.rejects(ct.save({ name: 'nofn', description: 'x', code: 'return 1' }, { create: true }), /must define/);
    // offered to the assistant as tool_<name>, with its schema
    const defs = ct.definitions(() => async () => null);
    assert.deepStrictEqual(defs.map((d) => [d.name, d.category]), [['tool_c_to_f', 'read']]);
    assert.deepStrictEqual(defs[0].input_schema.required, ['c']);
    // the registry finds it once wired in
    tools.setDynamic(() => ct.definitions(() => async () => null));
    try {
      assert.ok(tools.definitions().some((d) => d.name === 'tool_c_to_f'));
      assert.strictEqual(tools.categoryOf('tool_c_to_f'), 'read');
      assert.match(tools.validateInput('tool_c_to_f', {}), /missing required field "c"/);
      assert.deepStrictEqual(await tools.execute('tool_c_to_f', { c: 100 }, {}), { echo: { c: 100 }, len: 'async function run(input) { return { f: input.c * 9 / 5 + 32 }; }'.length });
      assert.strictEqual(tools.categoryOf('tool_nope'), null);
    } finally { tools.setDynamic(null); }
    // a fresh instance reads it back
    const { ct: ct2 } = mk(base);
    assert.deepStrictEqual((await ct2.load()).map((t) => t.name), ['c_to_f']);
    assert.ok(await ct2.remove('c_to_f'));
    assert.deepStrictEqual(await ct2.load(), []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('tool workspace: a script tool runs only with the user\'s approval of that exact code', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-tools-'));
  let yes = false;
  try {
    const { ct, asked } = mk(base, { answer: () => yes });
    await ct.load();
    const ps = '$in = [Console]::In.ReadToEnd() | ConvertFrom-Json; @{ sum = $in.a + $in.b } | ConvertTo-Json -Compress';
    const r = await ct.save({ name: 'adder', description: 'adds', mode: 'script', runtime: 'powershell', code: ps }, { create: true });
    assert.strictEqual(r.approved, false);
    assert.deepStrictEqual(asked, ['adder'], 'asked on save');
    assert.strictEqual(ct.definitions(() => null)[0].category, 'control');
    await assert.rejects(ct.run('adder', { a: 1, b: 2 }), /waiting for the user's approval/);
    // approve now
    yes = true;
    assert.strictEqual(await ct.requestApproval('adder'), true);
    // the approval is not in the AI folder (the assistant can write there)
    assert.ok(!fs.readdirSync(path.join(base, 'BE-Aero AI', 'AI Tools', 'adder')).some((f) => /approv/i.test(f)));
    if (process.platform === 'win32') {
      const out = await ct.run('adder', { a: 2, b: 3 });
      assert.deepStrictEqual(out.output, { sum: 5 });
      assert.strictEqual(out.ok, true);
    }
    // changing the code needs approval again
    yes = false;
    await ct.save({ name: 'adder', code: `${ps} # changed` }, { create: false });
    assert.strictEqual(ct.list()[0].approved, false);
    await assert.rejects(ct.run('adder', { a: 1, b: 1 }), /approval/);
    // and editing the file by hand does too
    yes = true; await ct.requestApproval('adder');
    fs.appendFileSync(path.join(base, 'BE-Aero AI', 'AI Tools', 'adder', 'run.ps1'), '\n# edited by hand');
    await ct.load();
    assert.strictEqual(ct.list()[0].approved, false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
