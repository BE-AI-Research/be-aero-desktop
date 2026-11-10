const test = require('node:test');
const assert = require('node:assert');
const { parseRegQuery, levelOf, labelOf, levelCommand, LEVELS, KEY } = require('../src/main/uac');

const REG = `
HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System
    ConsentPromptBehaviorAdmin    REG_DWORD    0x5
    ConsentPromptBehaviorUser    REG_DWORD    0x3
    EnableLUA    REG_DWORD    0x1
    PromptOnSecureDesktop    REG_DWORD    0x1
`;

test('UAC: reg query output is read, and the slider position recognised', () => {
  const v = parseRegQuery(REG);
  assert.deepStrictEqual(v, { ConsentPromptBehaviorAdmin: 5, EnableLUA: 1, PromptOnSecureDesktop: 1 });
  assert.strictEqual(levelOf(v), 'default');
  assert.strictEqual(levelOf({ ...v, ConsentPromptBehaviorAdmin: 2 }), 'always');
  assert.strictEqual(levelOf({ ...v, PromptOnSecureDesktop: 0 }), 'nodim');
  assert.strictEqual(levelOf({ ...v, ConsentPromptBehaviorAdmin: 0, PromptOnSecureDesktop: 0 }), 'never');
  assert.strictEqual(levelOf({ ...v, EnableLUA: 0 }), 'off');
  assert.strictEqual(levelOf({ ...v, ConsentPromptBehaviorAdmin: 1 }), 'custom');
  assert.strictEqual(levelOf({}), 'unknown');
  assert.match(labelOf('never'), /not recommended/);
});

test('UAC: a level change writes exactly the two slider values, and nothing for unknown levels', () => {
  const cmd = levelCommand('nodim');
  assert.ok(cmd.includes(`reg add ${KEY} /v ConsentPromptBehaviorAdmin /t REG_DWORD /d 5 /f`));
  assert.ok(cmd.includes(`reg add ${KEY} /v PromptOnSecureDesktop /t REG_DWORD /d 0 /f`));
  assert.ok(!/EnableLUA/.test(cmd), 'never touches EnableLUA');
  assert.strictEqual(levelCommand('off'), null);
  assert.strictEqual(levelCommand('rm -rf'), null);
  assert.deepStrictEqual(Object.keys(LEVELS), ['always', 'default', 'nodim', 'never']);
});
