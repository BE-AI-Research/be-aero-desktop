const test = require('node:test');
const assert = require('node:assert');
const {
  parseVersion, compareVersions, isNewer, parseLatestRelease, repoSlug, checkLatest
} = require('../src/main/updater');

test('parseVersion reads tags with and without the v', () => {
  assert.deepStrictEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepStrictEqual(parseVersion('1.0.0'), [1, 0, 0]);
  assert.deepStrictEqual(parseVersion('v2.10.0-beta.1'), [2, 10, 0]);
  assert.strictEqual(parseVersion('latest'), null);
  assert.strictEqual(parseVersion(''), null);
  assert.strictEqual(parseVersion(null), null);
});

test('compareVersions orders numerically, not lexically', () => {
  assert.strictEqual(compareVersions('1.10.0', '1.9.0'), 1);
  assert.strictEqual(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1);
  assert.strictEqual(compareVersions('junk', '1.0.0'), null);
});

test('isNewer is strict: equal and unparseable are not updates', () => {
  assert.ok(isNewer('1.0.1', '1.0.0'));
  assert.ok(!isNewer('1.0.0', '1.0.0'));
  assert.ok(!isNewer('0.9.9', '1.0.0'));
  assert.ok(!isNewer('not-a-tag', '1.0.0'), 'a weird tag must never nag the user');
});

test('parseLatestRelease takes only what it needs, from github.com only', () => {
  const ok = parseLatestRelease({ tag_name: 'v1.1.0', html_url: 'https://github.com/x/y/releases/tag/v1.1.0', name: 'Big one' });
  assert.deepStrictEqual(ok, { version: 'v1.1.0', url: 'https://github.com/x/y/releases/tag/v1.1.0', name: 'Big one' });
  // A notification must never open an off-github url.
  assert.strictEqual(parseLatestRelease({ tag_name: 'v1.1.0', html_url: 'https://evil.example/x' }), null);
  assert.strictEqual(parseLatestRelease({}), null);
  assert.strictEqual(parseLatestRelease(null), null);
});

test('repoSlug understands the common repository field shapes', () => {
  assert.strictEqual(repoSlug('https://github.com/be-aero/be-aero-desktop'), 'be-aero/be-aero-desktop');
  assert.strictEqual(repoSlug('git+https://github.com/a/b.git'), 'a/b');
  assert.strictEqual(repoSlug({ type: 'git', url: 'git@github.com:a/b.git' }), 'a/b');
  assert.strictEqual(repoSlug('a/b'), 'a/b');
  assert.strictEqual(repoSlug('not a repo'), null);
  assert.strictEqual(repoSlug(undefined), null);
});

// checkLatest with an injected fetch - no network in tests.
const fakeFetch = (status, body) => async () => ({
  status, ok: status >= 200 && status < 300, json: async () => body
});

test('checkLatest: newer release -> update', async () => {
  const r = await checkLatest('x/y', '1.0.0', fakeFetch(200, {
    tag_name: 'v1.2.0', html_url: 'https://github.com/x/y/releases/tag/v1.2.0'
  }));
  assert.strictEqual(r.state, 'update');
  assert.strictEqual(r.release.version, 'v1.2.0');
});

test('checkLatest: same version -> current; 404 -> none; 500 -> error', async () => {
  assert.strictEqual((await checkLatest('x/y', '1.2.0', fakeFetch(200, {
    tag_name: 'v1.2.0', html_url: 'https://github.com/x/y/releases/tag/v1.2.0'
  }))).state, 'current');
  assert.strictEqual((await checkLatest('x/y', '1.0.0', fakeFetch(404, {}))).state, 'none');
  assert.strictEqual((await checkLatest('x/y', '1.0.0', fakeFetch(500, {}))).state, 'error');
});

test('checkLatest: network failure resolves, never throws', async () => {
  const r = await checkLatest('x/y', '1.0.0', async () => { throw new Error('offline'); });
  assert.strictEqual(r.state, 'error');
  assert.match(r.message, /offline/);
  assert.strictEqual((await checkLatest(null, '1.0.0', fakeFetch(200, {}))).state, 'error');
});
