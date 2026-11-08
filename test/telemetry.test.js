const test = require('node:test');
const assert = require('node:assert');
const { sample, parseNetstat, diskUsage } = require('../src/main/telemetry');

test('telemetry sample returns sane values', () => {
  const t = sample();
  for (const key of ['cpu', 'ram']) {
    assert.ok(t[key] >= 0 && t[key] <= 100, `${key} out of range: ${t[key]}`);
  }
  assert.ok(t.cores > 0);
  assert.strictEqual(t.perCore.length, t.cores);
  assert.ok(t.totalMemGB > 0 && t.usedMemGB <= t.totalMemGB);
  assert.ok(t.uptime >= 0);
});

test('parseNetstat reads the Bytes row', () => {
  const text = 'Interface Statistics\r\n\r\n                           Received            Sent\r\n\r\n' +
    'Bytes                    1234567890       987654321\r\nUnicast packets             100              200\r\n';
  assert.deepStrictEqual(parseNetstat(text), { rx: 1234567890, tx: 987654321 });
  assert.strictEqual(parseNetstat('garbage'), null);
});

test('diskUsage reports the system drive', { skip: process.platform !== 'win32' }, () => {
  const d = diskUsage('C:');
  assert.ok(d && d.percent >= 0 && d.percent <= 100 && d.totalGB > 0);
  assert.strictEqual(d.drive, 'C:');
});
