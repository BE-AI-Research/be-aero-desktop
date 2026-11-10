const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Voice, wavHeader, RATE } = require('../src/main/voice');

test('wavHeader describes 16 kHz mono 16-bit PCM', () => {
  const h = wavHeader(32000);
  assert.strictEqual(h.length, 44);
  assert.strictEqual(h.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(h.readUInt32LE(24), RATE);
  assert.strictEqual(h.readUInt16LE(22), 1);
  assert.strictEqual(h.readUInt32LE(40), 32000);
  assert.strictEqual(h.readUInt32LE(4), 36 + 32000);
});

test('feed/stop are inert when nothing is listening', () => {
  const v = new Voice({ emit: () => {} });
  assert.strictEqual(v.listening(), false);
  assert.strictEqual(v.feed(Buffer.alloc(10)), false);
  assert.strictEqual(v.stop(), true);
});

// The real Windows recognizer, fed synthesized speech as PCM - the same
// bytes the renderer streams from the microphone.
test('Windows recognizer transcribes PCM streamed through the worker', { skip: process.platform !== 'win32' }, async () => {
  const wav = path.join(os.tmpdir(), `aero-voice-test-${process.pid}.wav`);
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `$s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}', (New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono))); ` +
    `$s.Speak('turn on the desk lamp please'); $s.Dispose()`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 60000 });
  const pcm = fs.readFileSync(wav).subarray(44);
  fs.unlinkSync(wav);

  const events = [];
  let resolveEnd;
  const ended = new Promise((r) => { resolveEnd = r; });
  const v = new Voice({ emit: (e) => { events.push(e); if (e.type === 'end') resolveEnd(); } });
  assert.strictEqual(v.start(), true);
  // Stream in 8 KB chunks like the renderer, then a second of silence so
  // the end-silence timeout closes the phrase, then end the stream.
  for (let i = 0; i < pcm.length; i += 8192) v.feed(pcm.subarray(i, i + 8192));
  v.feed(Buffer.alloc(RATE * 2));
  v.stop();
  await Promise.race([ended, new Promise((r) => setTimeout(r, 60000))]);
  const finals = events.filter((e) => e.type === 'final').map((e) => String(e.text).toLowerCase());
  assert.ok(events.some((e) => e.type === 'ready'), 'worker reported ready: ' + JSON.stringify(events));
  assert.ok(finals.length >= 1, 'got a transcription: ' + JSON.stringify(events));
  assert.match(finals.join(' '), /lamp|desk|turn/);
  assert.strictEqual(v.listening(), false);
});

test('Windows TTS renders a WAV and lists voices', { skip: process.platform !== 'win32' }, async () => {
  const v = new Voice({ emit: () => {} });
  const voices = await v.voices();
  assert.ok(Array.isArray(voices) && voices.length >= 1, 'at least one installed voice');
  const b64 = await v.speak('hello from the test', { voice: voices[0].name, rate: 1.2 });
  assert.ok(b64 && b64.length > 1000, 'wav rendered');
  const buf = Buffer.from(b64, 'base64');
  assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(await v.speak('   '), null);
});
