const test = require('node:test');
const assert = require('node:assert');
const { parseToast, guessAppName, filetimeToMs } = require('../src/main/win-notifications');

test('windows notifications: toast XML, app names, arrival times', () => {
  const xml = '<toast><visual><binding template="ToastGeneric"><text hint-maxLines="1">Ana &amp; Bo</text><text>See you at 5 &lt;3</text><text></text><image src="x.png"/></binding></visual></toast>';
  assert.deepStrictEqual(parseToast(xml), { title: 'Ana & Bo', body: 'See you at 5 <3' });
  assert.strictEqual(parseToast('<toast><visual/></toast>'), null);
  assert.strictEqual(parseToast('<toast><text>&#x1F600; hi</text></toast>').title, '\u{1F600} hi');

  assert.strictEqual(guessAppName('Microsoft.WindowsStore_8wekyb3d8bbwe!App'), 'Windows Store');
  assert.strictEqual(guessAppName('com.squirrel.Discord.Discord'), 'Discord');
  assert.strictEqual(guessAppName('C:\\Program Files\\Foo\\foo.exe'), 'foo');
  assert.strictEqual(guessAppName(''), 'An app');

  // 2026-01-01T00:00:00Z as a FILETIME
  const ms = Date.UTC(2026, 0, 1);
  assert.strictEqual(filetimeToMs(String((BigInt(ms) + 11644473600000n) * 10000n)), ms);
});
