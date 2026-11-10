// Piper: fast neural text-to-speech that runs on this computer.
//
// The engine (rhasspy/piper 2023.11.14-2, a standalone build that needs no
// Python) and each voice are installed from Settings. Every download is
// pinned: the engine by URL + SHA-256, voices by the catalog bundled with
// the app (piper-voices.json, a fixed revision of rhasspy/piper-voices with
// each file's size and MD5), so nothing but the expected bytes is installed.
//
// Synthesis keeps one piper process per voice/setting combination alive in
// --json-input mode (the model stays loaded; each request is one JSON line
// naming its output file, and piper prints that path when it is written),
// with a one-shot fallback.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const CATALOG = require('./piper-voices.json');
const VOICE_BASE = `https://huggingface.co/rhasspy/piper-voices/resolve/${CATALOG.revision}/`;
const ENGINES = {
  win32: {
    url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
    sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea',
    archive: 'zip', bin: 'piper.exe'
  },
  linux: {
    url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz',
    sha256: 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992',
    archive: 'tar', bin: 'piper'
  }
};
const IDLE_MS = 5 * 60 * 1000;
const SYNTH_TIMEOUT_MS = 60000;

function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// Catalog rows for the UI: [{ key, name, lang, language, country, quality, speakers, size, installed }]
function catalogList(installed = new Set()) {
  return Object.entries(CATALOG.voices).map(([key, v]) => ({
    key, name: v.name, lang: v.lang, language: v.language, country: v.country, quality: v.quality,
    speakers: v.speakers, speakerIds: v.speakerIds || null, size: v.onnx.size + v.config.size, installed: installed.has(key)
  }));
}

// Turn the chat's rate (0.5-2, 1 = normal) into piper's length_scale.
function lengthScaleFor(rate) {
  const r = Math.max(0.5, Math.min(2, Number(rate) || 1));
  return Math.round((1 / r) * 100) / 100;
}

class Piper {
  constructor({ dir }) {
    this.dir = dir;                              // <userData>/piper
    this.binDir = path.join(dir, 'piper');
    this.voiceDir = path.join(dir, 'voices');
    this.workers = new Map();                    // key -> worker
    this.installing = null;
  }

  engine() { return ENGINES[process.platform] || null; }
  binPath() { const e = this.engine(); return e ? path.join(this.binDir, e.bin) : null; }
  voicePath(key) { return path.join(this.voiceDir, `${key}.onnx`); }
  configPath(key) { return path.join(this.voiceDir, `${key}.onnx.json`); }

  installedVoices() {
    let names = [];
    try { names = fs.readdirSync(this.voiceDir); } catch { return new Set(); }
    return new Set(names.filter((n) => n.endsWith('.onnx')).map((n) => n.slice(0, -5)).filter((k) => names.includes(`${k}.onnx.json`)));
  }

  status() {
    const e = this.engine();
    const voices = this.installedVoices();
    return {
      supported: !!e && process.arch === 'x64',
      engine: !!(e && fs.existsSync(this.binPath())),
      installedVoices: [...voices],
      installing: this.installing ? this.installing.what : null
    };
  }

  catalog() { return catalogList(this.installedVoices()); }

  async download(url, dest, { sha256, md5, size }, onProgress) {
    const tmp = `${dest}.part`;
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'be-aero-desktop' } });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || size || 0;
    const out = fs.createWriteStream(tmp);
    const h = crypto.createHash(sha256 ? 'sha256' : 'md5');
    let got = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        got += value.length;
        h.update(value);
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        if (onProgress) onProgress(got, total);
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    const digest = h.digest('hex');
    const want = sha256 || md5;
    if (digest !== want || (size && got !== size)) {
      try { fs.unlinkSync(tmp); } catch { /* gone */ }
      throw new Error(`checksum mismatch for ${path.basename(dest)} - the download was refused`);
    }
    fs.renameSync(tmp, dest);
  }

  extract(archive, kind, into) {
    return new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(new Error(`could not unpack Piper: ${err.message}`)) : resolve());
      if (kind === 'zip') {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:AERO_ZIP -DestinationPath $env:AERO_DEST -Force'],
          { windowsHide: true, timeout: 120000, env: { ...process.env, AERO_ZIP: archive, AERO_DEST: into } }, done);
      } else {
        execFile('tar', ['-xzf', archive, '-C', into], { timeout: 120000 }, done);
      }
    });
  }

  async installEngine(onProgress = () => {}) {
    const e = this.engine();
    if (!e || process.arch !== 'x64') throw new Error('Piper downloads are available for Windows and Linux on x64.');
    if (fs.existsSync(this.binPath())) return this.status();
    fs.mkdirSync(this.dir, { recursive: true });
    const archive = path.join(this.dir, e.archive === 'zip' ? 'piper.zip' : 'piper.tar.gz');
    await this.download(e.url, archive, { sha256: e.sha256 }, (got, total) => onProgress({ stage: 'engine', got, total }));
    onProgress({ stage: 'unpack' });
    fs.rmSync(this.binDir, { recursive: true, force: true });
    await this.extract(archive, e.archive, this.dir);       // both archives contain a top-level piper/
    fs.unlinkSync(archive);
    if (process.platform !== 'win32') {
      for (const f of ['piper', 'espeak-ng', 'piper_phonemize']) { try { fs.chmodSync(path.join(this.binDir, f), 0o755); } catch { /* optional */ } }
      this.repairLinuxLibs();
    }
    if (!fs.existsSync(this.binPath())) throw new Error('Piper unpacked without its executable');
    return this.status();
  }

  async installVoice(key, onProgress = () => {}) {
    const v = CATALOG.voices[key];
    if (!v) throw new Error(`unknown Piper voice ${key}`);
    fs.mkdirSync(this.voiceDir, { recursive: true });
    if (!fs.existsSync(this.configPath(key))) {
      await this.download(VOICE_BASE + v.config.path, this.configPath(key), { md5: v.config.md5, size: v.config.size });
    }
    if (!fs.existsSync(this.voicePath(key))) {
      await this.download(VOICE_BASE + v.onnx.path, this.voicePath(key), { md5: v.onnx.md5, size: v.onnx.size }, (got, total) => onProgress({ stage: 'voice', key, got, total }));
    }
    return this.status();
  }

  // Engine (once) plus one voice; serialised so two clicks do not race.
  async install(key, onProgress = () => {}) {
    if (this.installing) return this.installing.promise;
    const run = (async () => {
      await this.installEngine(onProgress);
      if (key) await this.installVoice(key, onProgress);
      onProgress({ stage: 'done' });
      return this.status();
    })();
    this.installing = { what: key || 'engine', promise: run };
    try { return await run; } finally { this.installing = null; }
  }

  removeVoice(key) {
    if (!CATALOG.voices[key]) return false;
    for (const [k, w] of this.workers) if (w.voice === key) { this.killWorker(k); }
    let ok = false;
    for (const f of [this.voicePath(key), this.configPath(key)]) { try { fs.unlinkSync(f); ok = true; } catch { /* gone */ } }
    return ok;
  }

  // Piper and its phonemizer load libespeak-ng.so.1 / libpiper_phonemize.so.1
  // by soname, which the archive provides only as symlinks. If one is missing
  // or broken, the loader quietly takes the distribution's own espeak-ng
  // (Debian ships 1.51), which lacks espeak_TextToPhonemesWithTerminator, and
  // every request fails. Make each soname a real copy of the bundled library.
  repairLinuxLibs(platform = process.platform) {
    if (platform !== 'linux') return [];
    let names;
    try { names = fs.readdirSync(this.binDir); } catch { return []; }
    const fixed = [];
    for (const n of names) {
      const m = /^(lib[\w+-]+\.so)\.(\d+)\.[\d.]+$/.exec(n);
      if (!m) continue;
      const real = path.join(this.binDir, n);
      try { if (!fs.lstatSync(real).isFile()) continue; } catch { continue; }
      for (const alias of [`${m[1]}.${m[2]}`, m[1]]) {
        const dest = path.join(this.binDir, alias);
        if (fs.existsSync(dest)) continue;          // follows links: a broken link counts as missing
        try { fs.rmSync(dest, { force: true }); fs.copyFileSync(real, dest); fixed.push(alias); } catch { /* read-only dir */ }
      }
    }
    return fixed;
  }

  args(opts, outFile) {
    const a = ['--model', this.voicePath(opts.voice), '--config', this.configPath(opts.voice),
      '--length_scale', String(lengthScaleFor(opts.rate)),
      '--noise_scale', String(clampNum(opts.noiseScale, 0, 1.5, 0.667)),
      '--noise_w', String(clampNum(opts.noiseW, 0, 1.5, 0.8)),
      '--sentence_silence', String(clampNum(opts.sentenceSilence, 0, 2, 0.2))];
    const sp = Number(opts.speaker);
    if (Number.isInteger(sp) && sp > 0) a.push('--speaker', String(sp));
    const espeak = path.join(this.binDir, 'espeak-ng-data');
    if (fs.existsSync(espeak)) a.push('--espeak_data', espeak);
    if (outFile) a.push('--output_file', outFile);
    else a.push('--json-input');
    return a;
  }

  env() {
    const env = { ...process.env };
    if (process.platform === 'linux') env.LD_LIBRARY_PATH = [this.binDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    return env;
  }

  workerKey(o) { return [o.voice, lengthScaleFor(o.rate), o.noiseScale, o.noiseW, o.sentenceSilence, o.speaker].join('|'); }

  getWorker(opts) {
    if (!this.libsChecked) { this.libsChecked = true; this.repairLinuxLibs(); }
    const key = this.workerKey(opts);
    let w = this.workers.get(key);
    if (w && w.proc.exitCode === null) { this.touch(key); return w; }
    const proc = spawn(this.binPath(), this.args(opts, null), { cwd: this.binDir, windowsHide: true, env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] });
    w = { proc, voice: opts.voice, buf: '', waiters: [], log: '', timer: null };
    proc.stdout.on('data', (d) => {
      w.buf += d;
      let i;
      while ((i = w.buf.indexOf('\n')) !== -1) {
        const line = w.buf.slice(0, i).trim();
        w.buf = w.buf.slice(i + 1);
        if (!line) continue;
        const idx = w.waiters.findIndex((x) => path.resolve(x.file) === path.resolve(line));
        if (idx >= 0) { const [x] = w.waiters.splice(idx, 1); x.resolve(true); }
      }
    });
    proc.stderr.on('data', (d) => { w.log = (w.log + d).slice(-2000); });
    proc.stdin.on('error', () => { /* worker died */ });
    proc.on('exit', () => {
      for (const x of w.waiters.splice(0)) x.resolve(false);
      if (this.workers.get(key) === w) this.workers.delete(key);
    });
    this.workers.set(key, w);
    this.touch(key);
    return w;
  }

  touch(key) {
    const w = this.workers.get(key);
    if (!w) return;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => this.killWorker(key), IDLE_MS);
  }

  killWorker(key) {
    const w = this.workers.get(key);
    if (!w) return;
    clearTimeout(w.timer);
    try { w.proc.kill(); } catch { /* gone */ }
    this.workers.delete(key);
  }

  oneShot(text, opts, outFile) {
    return new Promise((resolve) => {
      const p = spawn(this.binPath(), this.args(opts, outFile), { cwd: this.binDir, windowsHide: true, env: this.env() });
      let log = '';
      const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, SYNTH_TIMEOUT_MS);
      p.stderr.on('data', (d) => { log = (log + d).slice(-2000); });
      p.on('exit', (code) => { clearTimeout(t); resolve({ ok: code === 0, log }); });
      p.on('error', () => { clearTimeout(t); resolve({ ok: false, log: 'spawn failed' }); });
      p.stdin.on('error', () => {});
      p.stdin.end(text, 'utf8');
    });
  }

  // text -> WAV buffer, or throws with piper's own message.
  async synth(text, opts) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (!fs.existsSync(this.binPath())) throw new Error('Piper is not installed - download it in Settings > Text to speech.');
    if (!opts.voice || !fs.existsSync(this.voicePath(opts.voice))) throw new Error('Choose and download a Piper voice in Settings > Text to speech.');
    const out = path.join(os.tmpdir(), `aero-piper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    try {
      let ok = false;
      const w = this.getWorker(opts);
      ok = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), SYNTH_TIMEOUT_MS);
        w.waiters.push({ file: out, resolve: (v) => { clearTimeout(timer); resolve(v); } });
        try { w.proc.stdin.write(`${JSON.stringify({ text: t, output_file: out })}\n`); } catch { resolve(false); }
      });
      if (!ok || !fs.existsSync(out)) {
        // The persistent mode failed (older build, crash): one process per request.
        this.killWorker(this.workerKey(opts));
        const r = await this.oneShot(t, opts, out);
        if (!r.ok || !fs.existsSync(out)) {
          const lines = String(r.log || w.log || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          throw new Error(`Piper failed: ${lines.slice(-3).join(' | ') || 'no output'}`);
        }
      }
      // piper prints the path when it starts writing on some builds; wait for a stable size.
      let last = -1;
      for (let i = 0; i < 20; i++) {
        const n = fs.statSync(out).size;
        if (n > 44 && n === last) break;
        last = n;
        await new Promise((r) => setTimeout(r, 25));
      }
      return fs.readFileSync(out);
    } finally {
      try { fs.unlinkSync(out); } catch { /* gone */ }
    }
  }

  shutdown() { for (const k of [...this.workers.keys()]) this.killWorker(k); }
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

module.exports = { Piper, CATALOG, ENGINES, catalogList, lengthScaleFor, hashFile };
