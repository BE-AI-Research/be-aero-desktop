const test = require('node:test');
const assert = require('node:assert');
const { hostKey, sameSite, describeLoadError } = require('../src/shared/weburl');

test('hostKey normalises default ports and case', () => {
  assert.strictEqual(hostKey('https://Example.com/x'), 'example.com:443');
  assert.strictEqual(hostKey('https://example.com:443/'), 'example.com:443');
  assert.strictEqual(hostKey('http://192.168.1.130:8006/ui'), '192.168.1.130:8006');
  assert.strictEqual(hostKey('http://a.local'), 'a.local:80');
});

test('hostKey rejects non-http and junk', () => {
  assert.strictEqual(hostKey('file:///C:/x.html'), null);
  assert.strictEqual(hostKey('javascript:alert(1)'), null);
  assert.strictEqual(hostKey('not a url'), null);
  assert.strictEqual(hostKey(null), null);
});

test('sameSite tolerates www and subdomain redirects, not strangers', () => {
  assert.ok(sameSite('https://google.com', 'https://www.google.com/'));
  assert.ok(sameSite('https://example.com', 'https://login.example.com/auth'));
  assert.ok(sameSite('https://192.168.1.130:8006', 'https://192.168.1.130:8006/#v1'));
  // A different port on the same device is a different service.
  assert.ok(!sameSite('https://192.168.1.130:8006', 'https://192.168.1.130:8007/'));
  assert.ok(!sameSite('https://example.com', 'https://evil.com/'));
  // Suffix tricks must not pass: evil-example.com is not example.com.
  assert.ok(!sameSite('https://example.com', 'https://evil-example.com/'));
});

test('describeLoadError names the common failures and skips aborts', () => {
  assert.match(describeLoadError(-27, 'ERR_BLOCKED_BY_RESPONSE'), /refuses to be embedded/);
  assert.match(describeLoadError(-202, 'ERR_CERT_AUTHORITY_INVALID'), /certificate/);
  assert.match(describeLoadError(-102, ''), /refused the connection/);
  assert.match(describeLoadError(-105, ''), /could not be found/);
  assert.strictEqual(describeLoadError(-3, 'ERR_ABORTED'), null);
  assert.match(describeLoadError(-999, 'ERR_WHO_KNOWS'), /ERR_WHO_KNOWS/);
});
