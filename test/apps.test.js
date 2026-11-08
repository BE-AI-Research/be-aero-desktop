const test = require('node:test');
const assert = require('node:assert');
const {
  APP_CAPABILITIES, CAPABILITIES, createApp, findByToken, can, stateOf,
  setGrant, revoke, touch, summarize, sanitizeAppName, normalizeCapabilities,
  isCapability, newToken
} = require('../src/main/apps');

const make = (name, caps) => createApp({ name, capabilities: caps, now: 1000 });

test('every app capability has prompt wording and a risk level', () => {
  assert.ok(CAPABILITIES.length > 0);
  for (const name of CAPABILITIES) {
    const info = APP_CAPABILITIES[name];
    assert.ok(info.title && info.detail);
    assert.ok(['low', 'medium', 'high'].includes(info.risk));
  }
});

test('sanitizeAppName strips what could fake a trusted name', () => {
  // Control characters and bidi overrides can visually rewrite a dialog.
  assert.strictEqual(sanitizeAppName(`Build${String.fromCharCode(0x202E)}Monitor`), 'BuildMonitor');
  assert.strictEqual(sanitizeAppName(`a${String.fromCharCode(0)}b`), 'ab');
  assert.strictEqual(sanitizeAppName(`x${String.fromCharCode(0x200B)}y`), 'xy');
  // Padding cannot push text off the edge of the dialog.
  assert.strictEqual(sanitizeAppName('   a     b   '), 'a b');
  assert.strictEqual(sanitizeAppName('x'.repeat(200)).length, 48);
  assert.strictEqual(sanitizeAppName(''), 'Unnamed app');
  assert.strictEqual(sanitizeAppName(null), 'Unnamed app');
  assert.strictEqual(sanitizeAppName({}), 'Unnamed app');
});

test('normalizeCapabilities keeps only real ones, deduplicated', () => {
  assert.deepStrictEqual(normalizeCapabilities(['panes', 'panes', 'root', 'telemetry']),
    ['panes', 'telemetry']);
  assert.deepStrictEqual(normalizeCapabilities('panes'), []);
  assert.deepStrictEqual(normalizeCapabilities(null), []);
  assert.ok(!isCapability('__proto__'));
});

test('a paired app starts with exactly what the user approved', () => {
  const app = make('Build Monitor', ['panes']);
  assert.strictEqual(app.name, 'Build Monitor');
  assert.deepStrictEqual(app.requested, ['panes']);
  assert.ok(can(app, 'panes'));
  // Never asked for, so never allowed.
  assert.ok(!can(app, 'telemetry'));
  assert.strictEqual(stateOf(app, 'telemetry'), 'denied');
});

test('apps get distinct ids and tokens', () => {
  const a = make('A', ['panes']);
  const b = make('B', ['panes']);
  assert.notStrictEqual(a.id, b.id);
  assert.notStrictEqual(a.token, b.token);
  assert.ok(a.token.length >= 32);
});

test('findByToken matches the right app and rejects everything else', () => {
  const a = make('A', ['panes']);
  const b = make('B', ['telemetry']);
  const table = { [a.id]: a, [b.id]: b };
  assert.strictEqual(findByToken(table, a.token).id, a.id);
  assert.strictEqual(findByToken(table, b.token).id, b.id);
  assert.strictEqual(findByToken(table, newToken()), null);
  assert.strictEqual(findByToken(table, a.token.slice(0, -1)), null);
  assert.strictEqual(findByToken(table, ''), null);
  assert.strictEqual(findByToken(table, null), null);
  assert.strictEqual(findByToken({}, a.token), null);
});

test('blocking a capability takes it away without unpairing', () => {
  const a = make('A', ['panes', 'telemetry']);
  let table = { [a.id]: a };
  table = setGrant(table, a.id, 'telemetry', 'denied');
  assert.ok(can(table[a.id], 'panes'));
  assert.ok(!can(table[a.id], 'telemetry'));
  // And it can be handed back.
  table = setGrant(table, a.id, 'telemetry', 'granted');
  assert.ok(can(table[a.id], 'telemetry'));
});

test('setGrant is pure and ignores nonsense', () => {
  const a = make('A', ['panes']);
  const table = { [a.id]: a };
  const next = setGrant(table, a.id, 'panes', 'denied');
  assert.ok(can(table[a.id], 'panes'), 'original must be untouched');
  assert.ok(!can(next[a.id], 'panes'));
  assert.strictEqual(setGrant(table, 'nope', 'panes', 'denied'), table);
  assert.strictEqual(setGrant(table, a.id, 'fly', 'granted'), table);
  assert.strictEqual(setGrant(table, a.id, 'panes', 'maybe'), table);
});

test('a tampered grant value is not treated as granted', () => {
  const a = make('A', ['panes']);
  a.grants.panes = 'GRANTED';
  assert.ok(!can(a, 'panes'));
  a.grants.panes = true;
  assert.ok(!can(a, 'panes'));
});

test('revoke removes the app and its token entirely', () => {
  const a = make('A', ['panes']);
  const b = make('B', ['panes']);
  const table = revoke({ [a.id]: a, [b.id]: b }, a.id);
  assert.strictEqual(findByToken(table, a.token), null);
  assert.strictEqual(findByToken(table, b.token).id, b.id);
});

test('touch records when an app was last seen', () => {
  const a = make('A', ['panes']);
  const table = touch({ [a.id]: a }, a.id, 9999);
  assert.strictEqual(table[a.id].lastSeenAt, 9999);
  assert.strictEqual(a.lastSeenAt, 1000, 'original untouched');
});

test('summarize never leaks tokens and sorts by most recent', () => {
  const a = make('Older', ['panes']);
  const b = make('Newer', ['panes', 'telemetry']);
  const table = touch({ [a.id]: a, [b.id]: b }, b.id, 5000);
  const rows = summarize(table);
  assert.deepStrictEqual(rows.map((r) => r.name), ['Newer', 'Older']);
  assert.strictEqual(JSON.stringify(rows).includes(a.token), false);
  assert.strictEqual(JSON.stringify(rows).includes(b.token), false);
  assert.strictEqual(rows[0].capabilities.length, 2);
  assert.ok(rows[0].capabilities[0].title);
});

test('matchesBinary binds a token to its executable', () => {
  const { matchesBinary } = require('../src/main/apps');
  const bound = createApp({ name: 'A', capabilities: ['panes'],
    exePath: 'C:\\Tools\\build.exe', now: 1 });
  // Same binary, any spelling: NTFS is case-insensitive.
  assert.ok(matchesBinary(bound, 'C:\\Tools\\build.exe'));
  assert.ok(matchesBinary(bound, 'c:\\tools\\BUILD.EXE'));
  // A different binary presenting the same token is refused.
  assert.ok(!matchesBinary(bound, 'C:\\Evil\\stealer.exe'));
  // So is a caller whose identity could not be established.
  assert.ok(!matchesBinary(bound, null));
  assert.ok(!matchesBinary(bound, ''));
  assert.ok(!matchesBinary(null, 'C:\\Tools\\build.exe'));
});

test('apps paired before binding existed still work until re-paired', () => {
  const { matchesBinary } = require('../src/main/apps');
  const legacy = createApp({ name: 'Old', capabilities: ['panes'], now: 1 });
  assert.strictEqual(legacy.exePath, null);
  assert.ok(matchesBinary(legacy, 'C:\\Anything\\at-all.exe'));
  assert.ok(matchesBinary(legacy, null));
});

test('summarize exposes the bound path but never the token', () => {
  const bound = createApp({ name: 'A', capabilities: ['panes'],
    exePath: 'C:\\Tools\\build.exe', now: 1 });
  const rows = summarize({ [bound.id]: bound });
  assert.strictEqual(rows[0].exePath, 'C:\\Tools\\build.exe');
  assert.ok(!JSON.stringify(rows).includes(bound.token));
});


test('matchesBinaryIdentity binds signed apps to their signer', () => {
  const { matchesBinaryIdentity } = require('../src/main/apps');
  const app = createApp({ name: 'A', capabilities: ['panes'],
    exePath: 'C:\\x\\a.exe',
    binary: { signed: true, thumbprint: 'ABC123', subject: 'CN=Good Corp' }, now: 1 });
  // Same signer after an in-place update: still fine.
  assert.strictEqual(matchesBinaryIdentity(app, { signed: true, thumbprint: 'ABC123', subject: 'CN=Good Corp' }), 'ok');
  // Different certificate at the same path: changed.
  assert.strictEqual(matchesBinaryIdentity(app, { signed: true, thumbprint: 'EVIL99', subject: 'CN=Evil' }), 'changed');
  // Signature stripped: changed.
  assert.strictEqual(matchesBinaryIdentity(app, { signed: false, sha256: 'aa' }), 'changed');
  // Could not verify at all: refuse rather than assume.
  assert.strictEqual(matchesBinaryIdentity(app, null), 'unverifiable');
});

test('matchesBinaryIdentity pins unsigned apps to their hash', () => {
  const { matchesBinaryIdentity } = require('../src/main/apps');
  const app = createApp({ name: 'A', capabilities: ['panes'],
    exePath: 'C:\\x\\a.exe',
    binary: { signed: false, sha256: 'DEADBEEF' }, now: 1 });
  assert.strictEqual(matchesBinaryIdentity(app, { signed: false, sha256: 'deadbeef' }), 'ok', 'hash compare is case-insensitive');
  assert.strictEqual(matchesBinaryIdentity(app, { signed: false, sha256: 'cafebabe' }), 'changed');
  // Becoming signed is still a different file.
  assert.strictEqual(matchesBinaryIdentity(app, { signed: true, thumbprint: 'X' }), 'changed');
  assert.strictEqual(matchesBinaryIdentity(app, { signed: false }), 'unverifiable');
});

test('legacy apps without a recorded identity pass until re-paired', () => {
  const { matchesBinaryIdentity } = require('../src/main/apps');
  const legacy = createApp({ name: 'Old', capabilities: ['panes'], exePath: 'C:\\x\\a.exe', now: 1 });
  assert.strictEqual(legacy.binary, null);
  assert.strictEqual(matchesBinaryIdentity(legacy, null), 'ok');
  assert.strictEqual(matchesBinaryIdentity(legacy, { signed: false, sha256: 'anything' }), 'ok');
});

test('summarize exposes the publisher but never key material beyond it', () => {
  const signed = createApp({ name: 'A', capabilities: ['panes'], exePath: 'C:\\x\\a.exe',
    binary: { signed: true, thumbprint: 'T', subject: 'CN=Good Corp' }, now: 1 });
  const unsigned = createApp({ name: 'B', capabilities: ['panes'], exePath: 'C:\\x\\b.exe',
    binary: { signed: false, sha256: 'ff' }, now: 1 });
  const rows = summarize({ [signed.id]: signed, [unsigned.id]: unsigned });
  assert.strictEqual(rows.find((r) => r.name === 'A').publisher, 'CN=Good Corp');
  assert.strictEqual(rows.find((r) => r.name === 'B').publisher, 'unsigned (hash-pinned)');
  assert.ok(!JSON.stringify(rows).includes(signed.token));
});
