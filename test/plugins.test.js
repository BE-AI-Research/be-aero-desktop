const test = require('node:test');
const assert = require('node:assert');
const { validateManifest, hasPermission, safeEntry, PERMISSIONS } = require('../src/main/plugins');

const base = { id: 'my-widget', name: 'My Widget', entry: 'index.html' };

test('validateManifest accepts a minimal manifest and fills defaults', () => {
  const { plugin, error } = validateManifest({ ...base });
  assert.strictEqual(error, undefined);
  assert.strictEqual(plugin.id, 'my-widget');
  assert.strictEqual(plugin.entry, 'index.html');
  assert.strictEqual(plugin.height, 220);
  assert.deepStrictEqual(plugin.permissions, []);
  assert.deepStrictEqual(plugin.settings, []);
});

test('validateManifest rejects bad ids', () => {
  for (const id of ['', 'a', 'Has Caps', 'has space', '-leading', 'x'.repeat(41), 'with/slash']) {
    const { error } = validateManifest({ ...base, id });
    assert.ok(error, `expected "${id}" to be rejected`);
  }
  assert.strictEqual(validateManifest({ ...base, id: 'AB-cd' }).plugin.id, 'ab-cd');
});

test('safeEntry refuses anything that escapes the plugin folder', () => {
  assert.strictEqual(safeEntry('index.html'), 'index.html');
  assert.strictEqual(safeEntry('ui/panel.htm'), 'ui/panel.htm');
  assert.strictEqual(safeEntry('ui\\panel.html'), 'ui/panel.html');
  for (const bad of ['../secret.html', 'a/../../b.html', '/etc/passwd.html',
    'C:\\Windows\\x.html', 'script.js', '', null, 'no-extension']) {
    assert.strictEqual(safeEntry(bad), null, `expected "${bad}" to be refused`);
  }
});

test('validateManifest drops permissions it does not recognise', () => {
  const { plugin } = validateManifest({
    ...base,
    permissions: ['telemetry', 'storage', 'read-all-files', 'telemetry', 'eval']
  });
  assert.deepStrictEqual(plugin.permissions, ['telemetry', 'storage']);
  for (const p of plugin.permissions) assert.ok(PERMISSIONS.includes(p));
});

test('validateManifest clamps sizes into a sane range', () => {
  assert.strictEqual(validateManifest({ ...base, height: 99999 }).plugin.height, 1200);
  assert.strictEqual(validateManifest({ ...base, height: -5 }).plugin.height, 80);
  assert.strictEqual(validateManifest({ ...base, height: 'tall' }).plugin.height, 220);
});

test('validateManifest filters the settings schema', () => {
  const { plugin } = validateManifest({
    ...base,
    settings: [
      { key: 'city', label: 'City', type: 'text', default: 'Seattle' },
      { key: 'bad key', label: 'nope' },
      { key: 'mode', type: 'wat' },
      null
    ]
  });
  assert.strictEqual(plugin.settings.length, 2);
  assert.strictEqual(plugin.settings[0].key, 'city');
  // Unknown control types degrade to a text box rather than being trusted.
  assert.strictEqual(plugin.settings[1].type, 'text');
});

test('validateManifest rejects non-objects', () => {
  for (const raw of [null, undefined, 'string', 42, []]) {
    assert.ok(validateManifest(raw).error, `expected ${JSON.stringify(raw)} to be rejected`);
  }
});

test('hasPermission is false unless declared', () => {
  const { plugin } = validateManifest({ ...base, permissions: ['storage'] });
  assert.ok(hasPermission(plugin, 'storage'));
  assert.ok(!hasPermission(plugin, 'telemetry'));
  assert.ok(!hasPermission(null, 'storage'));
});
