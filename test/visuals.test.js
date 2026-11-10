const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Visuals, buildPage, VISUAL_CSP, MAX_HTML } = require('../src/main/ai/visuals');
const tools = require('../src/main/ai/tools');

test('buildPage wraps a fragment and injects into a full document', () => {
  const frag = buildPage('<h2>Sales</h2><table><tr><td>1</td></tr></table>');
  assert.match(frag, /^<!doctype html><html><head><meta charset="utf-8">/);
  assert.match(frag, /<h2>Sales<\/h2>/);
  assert.match(frag, /__aeroVisual:1/, 'height reporter');
  const full = buildPage('<!doctype html><html lang="en"><head><title>x</title></head><body><p>hi</p></body></html>');
  assert.match(full, /<head><meta charset="utf-8">[\s\S]*<title>x<\/title>/);
  assert.match(full, /__aeroVisual:1[\s\S]*<\/script><\/body>/);
});

test('the visual CSP blocks network access and only allows scripts from the CDNs', () => {
  assert.match(VISUAL_CSP, /default-src 'none'/);
  assert.match(VISUAL_CSP, /connect-src 'none'/);
  assert.match(VISUAL_CSP, /form-action 'none'/);
  assert.match(VISUAL_CSP, /script-src 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net https:\/\/cdnjs\.cloudflare\.com https:\/\/unpkg\.com(;|$)/);
});

test('store: create, update in place, list, serve, remove; ids are validated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-vis-'));
  try {
    const v = new Visuals(dir);
    const a = v.save({ title: 'Chart', html: '<b>1</b>' });
    assert.match(a.id, /^v[a-f0-9]{10}$/);
    assert.strictEqual(a.where, 'chat');
    const b = v.save({ id: a.id, title: 'Chart 2', html: '<b>2</b>', where: 'desktop' });
    assert.strictEqual(b.id, a.id);
    assert.strictEqual(v.list().length, 1);
    assert.match(v.page(a.id), /<b>2<\/b>/);
    assert.strictEqual(new Visuals(dir).get(a.id).title, 'Chart 2', 'index persisted');
    assert.strictEqual(v.page('../../etc/passwd'), null);
    assert.throws(() => v.save({ id: 'vffffffffff', title: 'x', html: 'y' }), /no visual/);
    assert.throws(() => v.save({ title: 'x', html: '   ' }), /empty/);
    assert.throws(() => v.save({ title: 'x', html: 'a'.repeat(MAX_HTML + 1) }), /too large/);
    assert.strictEqual(v.remove(a.id), true);
    assert.strictEqual(v.page(a.id), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('show_visual tool validates input and returns the id', async () => {
  assert.match(tools.validateInput('show_visual', { title: 't' }), /missing required field "html"/);
  assert.strictEqual(tools.categoryOf('show_visual'), 'read');
  const calls = [];
  const ctx = { visuals: { show: (a) => { calls.push(a); return { id: 'v0123456789', where: a.where, title: a.title }; } } };
  const r = await tools.execute('show_visual', { title: 'T', html: '<p>x</p>' }, ctx);
  assert.deepStrictEqual(r, { ok: true, visual: 'v0123456789', where: 'chat', title: 'T' });
  assert.strictEqual(calls[0].where, 'chat');
});
