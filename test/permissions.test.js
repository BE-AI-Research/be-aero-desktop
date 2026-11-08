const test = require('node:test');
const assert = require('node:assert');
const {
  PERMISSIONS, PERMISSION_INFO, isPermission, describe: describePerm,
  stateOf, isGranted, setGrant, resetPlugin, pruneGrants, summarize, hasUndecided
} = require('../src/main/permissions');

const plugin = (overrides = {}) => ({
  id: 'demo', name: 'Demo', permissions: ['telemetry', 'storage'], ...overrides
});

test('every permission carries prompt wording and a risk level', () => {
  assert.ok(PERMISSIONS.length > 0);
  for (const name of PERMISSIONS) {
    const info = PERMISSION_INFO[name];
    assert.ok(info.title, `${name} needs a title`);
    assert.ok(info.detail, `${name} needs a detail line`);
    assert.ok(['low', 'medium', 'high'].includes(info.risk), `${name} risk`);
  }
});

test('isPermission rejects anything not on the list', () => {
  assert.ok(isPermission('telemetry'));
  assert.ok(!isPermission('read-all-files'));
  assert.ok(!isPermission('__proto__'));
  assert.ok(!isPermission('constructor'));
  assert.strictEqual(describePerm('nope').risk, 'unknown');
});

test('nothing is granted before the user decides', () => {
  assert.strictEqual(stateOf({}, 'demo', 'telemetry'), 'undecided');
  assert.ok(!isGranted({}, plugin(), 'telemetry'));
});

test('declaring a permission is not the same as being granted it', () => {
  const p = plugin();
  // Declared but undecided.
  assert.ok(!isGranted({}, p, 'telemetry'));
  // Granted.
  const grants = setGrant({}, 'demo', 'telemetry', 'granted');
  assert.ok(isGranted(grants, p, 'telemetry'));
  // Granted in storage but NOT declared in the manifest: still refused, so a
  // plugin cannot gain a capability by dropping it from its manifest later.
  const sneaky = plugin({ permissions: ['storage'] });
  assert.ok(!isGranted(grants, sneaky, 'telemetry'));
});

test('denied stays denied without re-prompting', () => {
  const grants = setGrant({}, 'demo', 'telemetry', 'denied');
  assert.strictEqual(stateOf(grants, 'demo', 'telemetry'), 'denied');
  assert.ok(!isGranted(grants, plugin(), 'telemetry'));
});

test('setGrant is pure and undecided clears the entry', () => {
  const before = {};
  const granted = setGrant(before, 'demo', 'storage', 'granted');
  assert.deepStrictEqual(before, {}, 'must not mutate the input');
  assert.strictEqual(stateOf(granted, 'demo', 'storage'), 'granted');

  const cleared = setGrant(granted, 'demo', 'storage', 'undecided');
  assert.strictEqual(stateOf(cleared, 'demo', 'storage'), 'undecided');
  assert.deepStrictEqual(cleared, {}, 'empty plugins should not linger');
});

test('setGrant ignores unknown permissions and states', () => {
  assert.deepStrictEqual(setGrant({}, 'demo', 'hack-everything', 'granted'), {});
  assert.deepStrictEqual(setGrant({}, 'demo', 'telemetry', 'maybe'), {});
});

test('unrecognised stored values read as undecided, not granted', () => {
  const tampered = { demo: { telemetry: 'GRANTED', storage: true } };
  assert.strictEqual(stateOf(tampered, 'demo', 'telemetry'), 'undecided');
  assert.ok(!isGranted(tampered, plugin(), 'telemetry'));
  assert.ok(!isGranted(tampered, plugin(), 'storage'));
});

test('resetPlugin forgets every decision for one plugin', () => {
  let g = setGrant({}, 'demo', 'telemetry', 'granted');
  g = setGrant(g, 'other', 'storage', 'granted');
  const reset = resetPlugin(g, 'demo');
  assert.strictEqual(stateOf(reset, 'demo', 'telemetry'), 'undecided');
  assert.strictEqual(stateOf(reset, 'other', 'storage'), 'granted');
});

test('pruneGrants drops consent for removed plugins and dropped capabilities', () => {
  let g = setGrant({}, 'demo', 'telemetry', 'granted');
  g = setGrant(g, 'demo', 'storage', 'granted');
  g = setGrant(g, 'gone', 'telemetry', 'granted');

  // "demo" no longer asks for storage; "gone" is uninstalled.
  const pruned = pruneGrants(g, [plugin({ permissions: ['telemetry'] })]);
  assert.strictEqual(stateOf(pruned, 'demo', 'telemetry'), 'granted');
  assert.strictEqual(stateOf(pruned, 'demo', 'storage'), 'undecided');
  assert.strictEqual(stateOf(pruned, 'gone', 'telemetry'), 'undecided');
});

test('summarize reports state and last use for everything requested', () => {
  const grants = setGrant({}, 'demo', 'telemetry', 'granted');
  const rows = summarize(plugin(), grants, { demo: { telemetry: 1700000000000 } });
  assert.strictEqual(rows.length, 2);
  const tel = rows.find((r) => r.name === 'telemetry');
  assert.strictEqual(tel.state, 'granted');
  assert.strictEqual(tel.lastUsed, 1700000000000);
  assert.ok(tel.title && tel.detail);
  assert.strictEqual(rows.find((r) => r.name === 'storage').state, 'undecided');
});

test('summarize hides capabilities that are not real', () => {
  const rows = summarize(plugin({ permissions: ['telemetry', 'bogus'] }), {});
  assert.deepStrictEqual(rows.map((r) => r.name), ['telemetry']);
});

test('hasUndecided drives the needs-review badge', () => {
  const p = plugin();
  assert.ok(hasUndecided(p, {}));
  let g = setGrant({}, 'demo', 'telemetry', 'granted');
  assert.ok(hasUndecided(p, g), 'storage is still unanswered');
  g = setGrant(g, 'demo', 'storage', 'denied');
  assert.ok(!hasUndecided(p, g), 'denied counts as decided');
});
