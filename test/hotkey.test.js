const test = require('node:test');
const assert = require('node:assert');
const { fromEvent, normalize, isValid, pretty, keyFromCode, isModifierCode } = require('../src/shared/hotkey');

const ev = (code, mods = {}) => ({
  code,
  ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta
});

test('keyFromCode maps layout-independent codes', () => {
  assert.strictEqual(keyFromCode('KeyK'), 'K');
  assert.strictEqual(keyFromCode('Digit7'), '7');
  assert.strictEqual(keyFromCode('Numpad3'), 'num3');
  assert.strictEqual(keyFromCode('F9'), 'F9');
  assert.strictEqual(keyFromCode('Space'), 'Space');
  assert.strictEqual(keyFromCode('ArrowUp'), 'Up');
  assert.strictEqual(keyFromCode('NumpadEnter'), 'Return');
  assert.strictEqual(keyFromCode('Period'), '.');
  assert.strictEqual(keyFromCode('F25'), null);
  assert.strictEqual(keyFromCode('Unknown'), null);
});

test('isModifierCode recognises both sides', () => {
  for (const c of ['ControlLeft', 'AltRight', 'ShiftLeft', 'MetaLeft', 'OSLeft']) {
    assert.ok(isModifierCode(c), c);
  }
  assert.ok(!isModifierCode('KeyA'));
});

test('fromEvent builds an accelerator in canonical order', () => {
  assert.strictEqual(fromEvent(ev('Space', { ctrl: true, alt: true })), 'Control+Alt+Space');
  assert.strictEqual(fromEvent(ev('KeyK', { meta: true, shift: true })), 'Shift+Super+K');
  assert.strictEqual(fromEvent(ev('F5', { alt: true })), 'Alt+F5');
});

test('fromEvent refuses presses that must not become a global shortcut', () => {
  // A bare key would swallow typing everywhere.
  assert.strictEqual(fromEvent(ev('KeyK')), null);
  // Modifiers alone are not a shortcut.
  assert.strictEqual(fromEvent(ev('ControlLeft', { ctrl: true })), null);
  // Keys we do not map.
  assert.strictEqual(fromEvent(ev('Unidentified', { ctrl: true })), null);
  assert.strictEqual(fromEvent(null), null);
});

test('normalize canonicalises spelling, casing and modifier order', () => {
  assert.strictEqual(normalize('alt+space'), 'Alt+Space');
  assert.strictEqual(normalize('Space+Alt'), 'Alt+Space');
  assert.strictEqual(normalize('Ctrl+Shift+k'), 'Control+Shift+K');
  assert.strictEqual(normalize('CmdOrCtrl+K'), 'Control+K');
  assert.strictEqual(normalize('Win+Shift+Space'), 'Shift+Super+Space');
  // Two real keys is not an accelerator.
  assert.strictEqual(normalize('A+B'), null);
  assert.strictEqual(normalize(''), null);
  assert.strictEqual(normalize(null), null);
});

test('isValid requires a modifier plus a key', () => {
  assert.ok(isValid('Alt+Space'));
  assert.ok(isValid('Control+Alt+Shift+F1'));
  assert.ok(!isValid('Space'));
  assert.ok(!isValid('Alt'));
  assert.ok(!isValid('nonsense+'));
});

test('pretty renders a label users recognise', () => {
  assert.strictEqual(pretty('Control+Alt+Space'), 'Ctrl + Alt + Space');
  assert.strictEqual(pretty('Super+Shift+Space'), 'Shift + Win + Space');
  assert.strictEqual(pretty('garbage'), '');
});
