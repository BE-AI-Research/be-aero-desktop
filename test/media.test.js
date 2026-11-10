const test = require('node:test');
const assert = require('node:assert');
const { livePosition, parsePlayerctl } = require('../src/main/media');

test('livePosition runs the clock forward from the timeline stamp while playing', () => {
  const now = 1_000_000;
  const base = { status: 'playing', position: 30, duration: 200, updatedAt: now - 12_500, rate: 1 };
  assert.strictEqual(livePosition(base, now), 42.5);
  assert.strictEqual(livePosition({ ...base, rate: 2 }, now), 55, 'playback rate');
  assert.strictEqual(livePosition({ ...base, status: 'paused' }, now), 30, 'paused: as reported');
  assert.strictEqual(livePosition({ ...base, position: 195 }, now), 200, 'clamped to the end');
  assert.strictEqual(livePosition({ ...base, updatedAt: 0 }, now), 30, 'no stamp');
  assert.strictEqual(livePosition({ ...base, updatedAt: now - 3_600_000 }, now), 30, 'stamp older than the track: ignored');
  assert.strictEqual(livePosition({ ...base, updatedAt: now + 5000 }, now), 30, 'stamp in the future: ignored');
  assert.strictEqual(livePosition({ ...base, duration: 0 }, now), 42.5, 'unknown length: unclamped');
});

test('parsePlayerctl reads the tab-separated metadata line', () => {
  const r = parsePlayerctl('Playing	Song	Artist	Album	spotify	12000000	240000000	file:///tmp/a.jpg');
  assert.strictEqual(r.status, 'playing');
  assert.strictEqual(r.position, 12);
  assert.strictEqual(r.duration, 240);
  assert.strictEqual(parsePlayerctl('garbage'), null);
});
