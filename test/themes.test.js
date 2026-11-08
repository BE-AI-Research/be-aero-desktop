const test = require('node:test');
const assert = require('node:assert');
const { PRESETS, resolveTheme, themeVars, hexToRgb } = require('../src/main/themes');

test('hexToRgb parses colours and falls back', () => {
  assert.deepStrictEqual(hexToRgb('#38bdf8'), [56, 189, 248]);
  assert.deepStrictEqual(hexToRgb('nope'), [18, 24, 40]);
});

test('resolveTheme applies custom overrides on a preset', () => {
  const t = resolveTheme({ preset: 'emerald', custom: { accent: '#ff0000', radius: '' } });
  assert.strictEqual(t.accent, '#ff0000');
  assert.strictEqual(t.radius, PRESETS.emerald.radius);
  assert.strictEqual(resolveTheme({ preset: 'missing' }).name, PRESETS.aero.name);
});

test('themeVars emits css variables', () => {
  const v = themeVars({ preset: 'aero' });
  assert.strictEqual(v['--accent'], '#38bdf8');
  assert.strictEqual(v['--glass-rgb'], '18, 24, 40');
  assert.strictEqual(v['--radius'], '16px');
});
