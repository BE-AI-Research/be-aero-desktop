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

test('CPU heatmap: quick extra callers reuse the last reading instead of shrinking the window', () => {
  const a = sample();
  const b = sample(); // immediately after: must not take a new, near-empty reading
  assert.deepStrictEqual(b.perCore, a.perCore);
  assert.strictEqual(b.cpu, a.cpu);
});

test('CPU heatmap: per-core use from 10 ms Linux-style ticks, and a changed core count starts over', () => {
  const { cpuUsage } = require('../src/main/telemetry');
  const snap = (cores) => ({ idle: cores.reduce((s, c) => s + c.idle, 0), total: cores.reduce((s, c) => s + c.total, 0), cores });
  const prev = snap([{ idle: 1000, total: 2000 }, { idle: 5000, total: 6000 }]);
  const now = snap([{ idle: 1150, total: 2300 }, { idle: 5300, total: 6300 }]);
  const r = cpuUsage(prev, now);
  assert.deepStrictEqual(r.perCore, [50, 0]);
  assert.strictEqual(Math.round(r.cpu), 25);
  assert.strictEqual(cpuUsage(prev, snap([{ idle: 1150, total: 2300 }])), null);
  assert.strictEqual(cpuUsage(prev, prev), null);
});
