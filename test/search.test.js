const test = require('node:test');
const assert = require('node:assert');
const { search, levenshtein, calculate, categorize } = require('../src/main/search');

const entries = [
  { name: 'Visual Studio Code', path: 'C:\\sm\\Visual Studio Code.lnk', kind: 'app' },
  { name: 'Google Chrome', path: 'C:\\sm\\Google Chrome.lnk', kind: 'app' },
  { name: 'Calculator', path: 'C:\\sm\\Calculator.lnk', kind: 'app' },
  { name: 'Display settings', path: 'ms-settings:display', kind: 'setting' },
  { name: 'budget 2026.xlsx', path: 'C:\\u\\Documents\\budget 2026.xlsx', kind: 'file' },
  { name: 'holiday.jpg', path: 'C:\\u\\Pictures\\holiday.jpg', kind: 'file' },
  { name: 'Downloads', path: 'C:\\u\\Downloads', kind: 'folder' },
  { name: 'chrome-notes.txt', path: 'C:\\u\\Documents\\chrome-notes.txt', kind: 'file' }
];

test('levenshtein distance', () => {
  assert.strictEqual(levenshtein('kitten', 'sitting'), 3);
  assert.strictEqual(levenshtein('', 'abc'), 3);
  assert.strictEqual(levenshtein('same', 'same'), 0);
});

test('prefix match finds apps first', () => {
  const r = search('chr', entries);
  assert.strictEqual(r.top.name, 'Google Chrome');
  assert.strictEqual(r.groups[0].category, 'APPLICATIONS');
  assert.ok(r.groups.some((g) => g.category === 'DOCUMENTS'));
});

test('acronym and typo tolerance', () => {
  assert.strictEqual(search('vsc', entries).top.name, 'Visual Studio Code');
  assert.strictEqual(search('calculater', entries).top.name, 'Calculator');
});

test('multi-word queries require every term', () => {
  const r = search('budget 2026', entries);
  assert.strictEqual(r.top.name, 'budget 2026.xlsx');
  assert.strictEqual(search('budget banana', entries).top, null);
});

test('launch counts boost results', () => {
  const plain = search('c', entries);
  const boosted = search('c', entries, { launchCounts: { 'C:\\sm\\Calculator.lnk': 50 } });
  assert.notStrictEqual(plain.top.name, undefined);
  assert.strictEqual(boosted.top.name, 'Calculator');
});

test('empty query returns nothing', () => {
  assert.deepStrictEqual(search('   ', entries), { top: null, groups: [], total: 0 });
});

test('categorize by kind and extension', () => {
  assert.strictEqual(categorize({ kind: 'file', name: 'a.mp3', path: 'a.mp3' }), 'MUSIC');
  assert.strictEqual(categorize({ kind: 'file', name: 'a.weird', path: 'a.weird' }), 'OTHER');
  assert.strictEqual(categorize({ kind: 'folder', name: 'x', path: 'x' }), 'FOLDERS');
});

test('calculator', () => {
  assert.strictEqual(calculate('2+2'), 4);
  assert.strictEqual(calculate('2 + 3 * 4'), 14);
  assert.strictEqual(calculate('(2+3)*4'), 20);
  assert.strictEqual(calculate('2^10'), 1024);
  assert.strictEqual(calculate('-3 + 5'), 2);
  assert.strictEqual(calculate('sqrt(16)'), 4);
  assert.strictEqual(calculate('50%'), 0.5);
  assert.strictEqual(calculate('10 % 3'), 1);
  assert.strictEqual(calculate('0.1+0.2'), 0.3);
  assert.strictEqual(calculate('42'), null);
  assert.strictEqual(calculate('chrome'), null);
  assert.strictEqual(calculate('2+'), null);
  assert.strictEqual(calculate('process.exit()'), null);
});
