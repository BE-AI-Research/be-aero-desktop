const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Piper, CATALOG, ENGINES, lengthScaleFor } = require('../src/main/piper');
const { wavHeader } = require('../src/main/voice');

test('bundled Piper catalog is pinned and complete', () => {
  assert.match(CATALOG.revision, /^[0-9a-f]{40}$/);
  const keys = Object.keys(CATALOG.voices);
  assert.ok(keys.length >= 100, `${keys.length} voices`);
  assert.ok(CATALOG.voices['en_US-lessac-medium'], 'default voice present');
  for (const [k, v] of Object.entries(CATALOG.voices)) {
    assert.match(v.onnx.md5, /^[0-9a-f]{32}$/, k);
    assert.match(v.config.md5, /^[0-9a-f]{32}$/, k);
    assert.ok(v.onnx.size > 1e6 && v.onnx.path.endsWith(`${k}.onnx`), k);
  }
  for (const e of Object.values(ENGINES)) assert.match(e.sha256, /^[0-9a-f]{64}$/);
});

test('rate maps to length_scale (faster speech = shorter phonemes)', () => {
  assert.strictEqual(lengthScaleFor(1), 1);
  assert.strictEqual(lengthScaleFor(2), 0.5);
  assert.strictEqual(lengthScaleFor(0.5), 2);
  assert.strictEqual(lengthScaleFor(9), 0.5, 'clamped');
});

test('voice download is refused on an MD5 or size mismatch', async () => {
  const body = Buffer.from('fake onnx bytes');
  const server = http.createServer((_q, r) => { r.writeHead(200); r.end(body); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-piper-'));
  try {
    const p = new Piper({ dir });
    const url = `http://127.0.0.1:${server.address().port}/v.onnx`;
    const md5 = crypto.createHash('md5').update(body).digest('hex');
    await assert.rejects(p.download(url, path.join(dir, 'a'), { md5: 'f'.repeat(32) }), /checksum mismatch/);
    await assert.rejects(p.download(url, path.join(dir, 'b'), { md5, size: body.length + 1 }), /checksum mismatch/);
    await p.download(url, path.join(dir, 'c'), { md5, size: body.length });
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'c')), body);
    assert.deepStrictEqual(p.status().installedVoices, []);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('synth explains what is missing before anything runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-piper-'));
  try {
    const p = new Piper({ dir });
    await assert.rejects(p.synth('hello', { voice: 'en_US-lessac-medium' }), /not installed/);
    assert.strictEqual(await p.synth('   ', {}), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A stand-in for piper's --json-input mode: one JSON line in, a WAV written
// to output_file, its path printed. Exercises the persistent-worker protocol.
test('persistent --json-input worker: requests are answered by output path, model stays loaded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-piper-'));
  const fake = path.join(dir, 'fake-piper.js');
  const startsFile = path.join(dir, 'starts.txt');
  fs.writeFileSync(fake, `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(startsFile)}, 'start\\n');
    const args = process.argv.slice(2);
    if (!args.includes('--json-input')) process.exit(3);
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const req = JSON.parse(line);
        const pcm = Buffer.alloc(3200 + req.text.length * 2);
        const h = Buffer.from(${JSON.stringify([...wavHeader(0)])});
        h.writeUInt32LE(36 + pcm.length, 4); h.writeUInt32LE(pcm.length, 40);
        fs.writeFileSync(req.output_file, Buffer.concat([h, pcm]));
        process.stdout.write(req.output_file + '\\n');
      }
    });
  `);
  try {
    const p = new Piper({ dir });
    // Point the engine at node + the fake script, and pretend a voice is installed.
    p.binPath = () => process.execPath;
    const realArgs = p.args.bind(p);
    p.args = (opts, out) => [fake, ...realArgs(opts, out)];
    fs.mkdirSync(p.voiceDir, { recursive: true });
    fs.writeFileSync(p.voicePath('en_US-lessac-medium'), 'x');
    fs.writeFileSync(p.configPath('en_US-lessac-medium'), '{}');
    fs.mkdirSync(p.binDir, { recursive: true });
    const opts = { voice: 'en_US-lessac-medium', rate: 1.25 };
    const [a, b] = await Promise.all([p.synth('first sentence.', opts), p.synth('a second, longer sentence.', opts)]);
    assert.strictEqual(a.toString('ascii', 0, 4), 'RIFF');
    assert.ok(b.length > a.length, 'each request got its own file');
    await p.synth('third.', opts);
    assert.strictEqual(fs.readFileSync(startsFile, 'utf8').trim().split('\n').length, 1, 'one process served all three');
    assert.ok(p.args(opts, null).includes('0.8'), 'length_scale from rate 1.25');
    const procs = [...p.workers.values()].map((w) => w.proc);
    p.shutdown();
    assert.strictEqual(p.workers.size, 0);
    await Promise.all(procs.map((pr) => (pr.exitCode !== null ? null : new Promise((r) => pr.once('exit', r)))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
