const test = require('node:test');
const assert = require('node:assert');
const { parseBtDevices, parseBtInfo, pactlVolume } = require('../src/main/sound');

test('sound (Linux): bluetoothctl and pactl output', () => {
  assert.deepStrictEqual(parseBtDevices('Device E8:EE:CC:DC:43:DC Soundcore Life Q30\nDevice C4:49:3E:4F:C2:56 Phone\nnoise'), [
    { id: 'E8:EE:CC:DC:43:DC', name: 'Soundcore Life Q30' }, { id: 'C4:49:3E:4F:C2:56', name: 'Phone' }
  ]);
  const info = 'Device E8:EE:CC:DC:43:DC (public)\n\tName: Soundcore Life Q30\n\tIcon: audio-headset\n\tPaired: yes\n\tConnected: yes\n\tBattery Percentage: 0x55 (85)\n';
  assert.deepStrictEqual(parseBtInfo(info), { connected: true, paired: true, audio: true, battery: 85 });
  assert.deepStrictEqual(parseBtInfo('\tConnected: no\n\tIcon: phone\n'), { connected: false, paired: false, audio: false, battery: null });
  assert.strictEqual(pactlVolume({ 'front-left': { value: 32768, value_percent: '50%' }, 'front-right': { value: 32768, value_percent: '50%' } }), 0.5);
  assert.strictEqual(pactlVolume(null), 0);
});
