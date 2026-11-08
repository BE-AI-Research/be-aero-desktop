const test = require('node:test');
const assert = require('node:assert');
const { PaneRegistry, sanitizePane } = require('../src/main/panes');

test('sanitizePane keeps the structured fields', () => {
  const { pane, error } = sanitizePane('build', {
    title: 'CI',
    subtitle: 'main',
    lines: ['step 3 of 7', 'running tests'],
    metrics: [{ label: 'coverage', value: '92%', percent: 92, color: '#34d399' }],
    progress: 43,
    accent: '#38bdf8',
    actions: [{ label: 'Open', url: 'https://ci.example.com/42' }]
  });
  assert.strictEqual(error, undefined);
  assert.strictEqual(pane.title, 'CI');
  assert.deepStrictEqual(pane.lines, ['step 3 of 7', 'running tests']);
  assert.strictEqual(pane.metrics[0].percent, 92);
  assert.strictEqual(pane.progress, 43);
  assert.strictEqual(pane.actions[0].url, 'https://ci.example.com/42');
});

test('sanitizePane validates the id', () => {
  for (const id of ['', '../etc', 'has space', 'a/b', null, 'x'.repeat(65)]) {
    assert.ok(sanitizePane(id, {}).error, `expected "${id}" to be rejected`);
  }
  assert.strictEqual(sanitizePane('a.b-c_1', {}).error, undefined);
});

test('sanitizePane never carries markup or scripts through', () => {
  const { pane } = sanitizePane('x', {
    title: '<img src=x onerror=alert(1)>',
    lines: ['<script>alert(1)</script>']
  });
  // The strings are preserved verbatim - the renderer writes them with
  // textContent - but nothing is interpreted as a field it is not.
  assert.strictEqual(typeof pane.title, 'string');
  assert.strictEqual(pane.lines.length, 1);
  assert.strictEqual(pane.metrics.length, 0);
});

test('sanitizePane only accepts http(s) action urls', () => {
  const { pane } = sanitizePane('x', {
    actions: [
      { label: 'ok', url: 'https://example.com' },
      { label: 'js', url: 'javascript:alert(1)' },
      { label: 'file', url: 'file:///C:/Windows/system32/cmd.exe' },
      { label: 'proto', url: 'ms-settings:display' },
      { label: 'nourl' }
    ]
  });
  assert.strictEqual(pane.actions.length, 1);
  assert.strictEqual(pane.actions[0].url, 'https://example.com');
});

test('sanitizePane clamps numbers and rejects bad colours', () => {
  const { pane } = sanitizePane('x', {
    progress: 900,
    accent: 'red',
    metrics: [{ label: 'a', percent: -40, color: 'nope' }]
  });
  assert.strictEqual(pane.progress, 100);
  assert.strictEqual(pane.accent, null);
  assert.strictEqual(pane.metrics[0].percent, 0);
  assert.strictEqual(pane.metrics[0].color, null);
});

test('sanitizePane caps list lengths', () => {
  const { pane } = sanitizePane('x', {
    lines: Array.from({ length: 50 }, (_, i) => `line ${i}`),
    metrics: Array.from({ length: 50 }, (_, i) => ({ label: `m${i}` }))
  });
  assert.strictEqual(pane.lines.length, 12);
  assert.strictEqual(pane.metrics.length, 8);
});

test('sanitizePane falls back from text to lines', () => {
  const { pane } = sanitizePane('x', { text: 'one\ntwo\nthree' });
  assert.deepStrictEqual(pane.lines, ['one', 'two', 'three']);
});

const owner = (id, name) => ({ id, name });

test('PaneRegistry notifies on every change', () => {
  const seen = [];
  const reg = new PaneRegistry({ onChange: (list) => seen.push(list.length) });
  const o = owner('app1', 'App One');
  reg.set('a', { title: 'A' }, 1, o);
  reg.set('b', { title: 'B' }, 2, o);
  reg.set('a', { title: 'A2' }, 3, o);
  assert.strictEqual(reg.get('app1', 'a').title, 'A2');
  reg.delete('app1', 'a');
  reg.delete('app1', 'missing');   // no change, so no notification
  reg.clear();
  assert.deepStrictEqual(seen, [1, 2, 2, 1, 0]);
});

test('PaneRegistry keeps each owner pane set separate', () => {
  const reg = new PaneRegistry();
  const a = owner('a1', 'A');
  const b = owner('b1', 'B');
  // The same pane id from two apps must not collide.
  reg.set('status', { title: 'From A' }, 1, a);
  reg.set('status', { title: 'From B' }, 1, b);
  assert.strictEqual(reg.list().length, 2);
  assert.strictEqual(reg.get('a1', 'status').title, 'From A');
  assert.strictEqual(reg.get('b1', 'status').title, 'From B');
  assert.deepStrictEqual(reg.listFor('a1').map((p) => p.title), ['From A']);

  // Deleting touches only your own.
  reg.delete('a1', 'status');
  assert.strictEqual(reg.get('a1', 'status'), null);
  assert.strictEqual(reg.get('b1', 'status').title, 'From B');
});

test('PaneRegistry records who owns each pane', () => {
  const reg = new PaneRegistry();
  const { pane } = reg.set('a', { title: 'A' }, 1, owner('app1', 'Build Monitor'));
  assert.strictEqual(pane.ownerId, 'app1');
  assert.strictEqual(pane.ownerName, 'Build Monitor');
});

test('clearOwner removes one app pane set and leaves the rest', () => {
  const reg = new PaneRegistry();
  reg.set('x', {}, 1, owner('a1', 'A'));
  reg.set('y', {}, 1, owner('a1', 'A'));
  reg.set('z', {}, 1, owner('b1', 'B'));
  assert.strictEqual(reg.clearOwner('a1'), 2);
  assert.deepStrictEqual(reg.list().map((p) => p.id), ['z']);
  assert.strictEqual(reg.clearOwner('nobody'), 0);
});

test('PaneRegistry caps panes globally and per owner', () => {
  const perOwner = new PaneRegistry({ perOwner: 2 });
  const a = owner('a1', 'A');
  assert.strictEqual(perOwner.set('p1', {}, 1, a).error, undefined);
  assert.strictEqual(perOwner.set('p2', {}, 1, a).error, undefined);
  assert.ok(perOwner.set('p3', {}, 1, a).error, 'third pane from one app refused');
  // A different app is unaffected by another's quota.
  assert.strictEqual(perOwner.set('p1', {}, 1, owner('b1', 'B')).error, undefined);
  // Updating an existing pane is not a new pane.
  assert.strictEqual(perOwner.set('p1', { title: 'again' }, 2, a).error, undefined);

  const global = new PaneRegistry({ max: 2, perOwner: 10 });
  assert.strictEqual(global.set('p1', {}, 1, owner('a1', 'A')).error, undefined);
  assert.strictEqual(global.set('p2', {}, 1, owner('b1', 'B')).error, undefined);
  assert.ok(global.set('p3', {}, 1, owner('c1', 'C')).error);
});

test('PaneRegistry stamps the time the caller supplies', () => {
  const reg = new PaneRegistry();
  const { pane } = reg.set('a', { title: 'A' }, 12345, owner('a1', 'A'));
  assert.strictEqual(pane.updatedAt, 12345);
});
