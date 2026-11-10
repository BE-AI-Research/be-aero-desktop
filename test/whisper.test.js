const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Whisper, MODELS, BINARIES, cleanTranscript } = require('../src/main/whisper');
const { Segmenter, tidySystemText, Voice, RATE } = require('../src/main/voice');

function tone(ms, amp = 0.2, hz = 220) {
  const n = Math.round(RATE * ms / 1000);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin(2 * Math.PI * hz * i / RATE) * amp * 32767);
  return a;
}
const quiet = (ms) => new Int16Array(Math.round(RATE * ms / 1000));

test('Segmenter cuts phrases at pauses and keeps a pre-roll', () => {
  const seg = new Segmenter({ silenceMs: 700 });
  const out = [];
  for (const chunk of [quiet(500), tone(1200), quiet(900), tone(600), quiet(1000)]) {
    // feed in renderer-sized pieces (4096 samples)
    for (let i = 0; i < chunk.length; i += 4096) out.push(...seg.push(chunk.subarray(i, i + 4096)));
  }
  assert.strictEqual(out.length, 2, 'two phrases');
  // phrase 1: 300 ms pre-roll + 1200 ms speech + 700 ms closing silence
  const ms0 = out[0].length / RATE * 1000;
  assert.ok(ms0 > 1900 && ms0 < 2400, `phrase 1 length ${ms0}`);
  assert.strictEqual(seg.flush(), null, 'nothing left');
});

test('Segmenter ignores clicks shorter than the minimum speech length', () => {
  const seg = new Segmenter({ silenceMs: 500 });
  const out = [...seg.push(quiet(300)), ...seg.push(tone(100)), ...seg.push(quiet(800))];
  assert.strictEqual(out.length, 0);
});

test('Segmenter forces a cut at the maximum phrase length and flushes the tail', () => {
  const seg = new Segmenter({ silenceMs: 700, maxMs: 2000 });
  const out = seg.push(tone(3000));
  assert.strictEqual(out.length, 1);
  const tail = seg.flush();
  assert.ok(tail && tail.length > 0, 'remaining speech flushed on stop');
});

test('cleanTranscript drops non-speech markers and silence hallucinations', () => {
  assert.strictEqual(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.strictEqual(cleanTranscript('(music)'), '');
  assert.strictEqual(cleanTranscript('Thank you.'), '');
  assert.strictEqual(cleanTranscript('  Open the   weather widget. '), 'Open the weather widget.');
  assert.strictEqual(tidySystemText('open the weather'), 'Open the weather');
});

test('pinned downloads: every model and engine carries a sha256', () => {
  for (const m of Object.values(MODELS)) assert.match(m.sha256, /^[0-9a-f]{64}$/);
  for (const b of Object.values(BINARIES)) { assert.match(b.sha256, /^[0-9a-f]{64}$/); assert.match(b.url, /^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b\d+\//); }
});

test('download refuses a file whose checksum does not match', async () => {
  const body = Buffer.from('not the model you were promised');
  const server = http.createServer((_q, r) => { r.writeHead(200, { 'Content-Length': body.length }); r.end(body); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-whisper-'));
  try {
    const w = new Whisper({ dir });
    const url = `http://127.0.0.1:${server.address().port}/m.bin`;
    const dest = path.join(dir, 'm.bin');
    await assert.rejects(w.download(url, dest, '0'.repeat(64)), /checksum mismatch/);
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + '.part'), 'nothing left behind');
    const good = crypto.createHash('sha256').update(body).digest('hex');
    let last = null;
    await w.download(url, dest, good, (got, total) => { last = [got, total]; });
    assert.deepStrictEqual(fs.readFileSync(dest), body);
    assert.deepStrictEqual(last, [body.length, body.length]);
    const st = w.status();
    assert.strictEqual(st.installed, false, 'no engine, no installed models');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Voice engine choice: auto falls back without Whisper; forced Whisper reports why', async () => {
  const fake = (installed) => ({ status: () => ({ installed }), pickModel: () => 'base.en' });
  let cfg = { engine: 'auto' };
  const v = new Voice({ emit: () => {}, whisper: fake(false), settings: () => cfg });
  assert.strictEqual(v.engine(), process.platform === 'win32' ? 'system' : null);
  const v2 = new Voice({ emit: () => {}, whisper: fake(true), settings: () => cfg });
  assert.strictEqual(v2.engine(), 'whisper');
  cfg = { engine: 'whisper' };
  assert.strictEqual(v.engine(), null);
  const a = await v.available();
  assert.strictEqual(a.stt, false);
  assert.match(a.reason, /not installed/);
  cfg = { engine: 'system' };
  assert.strictEqual(v2.engine(), process.platform === 'win32' ? 'system' : null);
});

test('Whisper session: phrases are transcribed in order with context, end after the last', async () => {
  const calls = [];
  const events = [];
  const whisper = {
    status: () => ({ installed: true }), pickModel: () => 'base.en',
    ensureServer: async () => ({}),
    transcribe: async (wav, { prompt }) => { calls.push(prompt); return `phrase ${calls.length}.`; }
  };
  let ended;
  const done = new Promise((r) => { ended = r; });
  const v = new Voice({ emit: (e) => { events.push(e); if (e.type === 'end') ended(); }, whisper, settings: () => ({ engine: 'whisper', phrasePauseMs: 500 }) });
  assert.strictEqual(v.start(), true);
  const pcm = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  v.feed(pcm(quiet(300))); v.feed(pcm(tone(800))); v.feed(pcm(quiet(700))); v.feed(pcm(tone(800)));
  v.stop();   // the second phrase has no closing pause: flushed on stop
  await done;
  const finals = events.filter((e) => e.type === 'final').map((e) => e.text);
  assert.deepStrictEqual(finals, ['phrase 1.', 'phrase 2.']);
  assert.deepStrictEqual(calls, ['', 'phrase 1.'], 'second phrase primed with the first');
  assert.strictEqual(v.listening(), false);
});
