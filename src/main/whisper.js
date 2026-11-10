// Whisper (whisper.cpp) as the dictation engine: far more accurate than the
// OS recognizers, still fully offline. The user installs it from Settings;
// every download is pinned to an exact URL and SHA-256, so nothing but the
// expected files is ever installed. A local whisper-server keeps the model
// loaded between phrases (bound to 127.0.0.1 on a random port) and is shut
// down after a few idle minutes.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { spawn, execFile } = require('child_process');

const BUILD = 'b5454';
const BINARIES = {
  win32: {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${BUILD}/whisper-bin-x64.zip`,
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
    archive: 'zip', dir: 'Release', server: 'whisper-server.exe'
  },
  linux: {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${BUILD}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c',
    archive: 'tar', dir: 'whisper-bin-ubuntu-x64', server: 'whisper-server'
  }
};
const MODELS = {
  'tiny.en': { label: 'Tiny (English, 75 MB - fastest)', size: 77704715, sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f' },
  'base.en': { label: 'Base (English, 148 MB - recommended)', size: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' },
  'small.en': { label: 'Small (English, 488 MB - most accurate, slower)', size: 487614201, sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d' }
};
const modelUrl = (id) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${id}.bin`;
const IDLE_MS = 5 * 60 * 1000;

// Text whisper produces for silence or noise rather than speech.
const NON_SPEECH = /^\s*(?:[[(][^\])]*[\])]\s*)+$|^\s*(?:you|thank you\.?|thanks for watching!?|\.+)\s*$/i;

function cleanTranscript(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || NON_SPEECH.test(t)) return '';
  return t;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

class Whisper {
  constructor({ dir }) {
    this.dir = dir;                       // <userData>/whisper
    this.binDir = path.join(dir, 'bin');
    this.server = null;                   // { proc, port, model, ready }
    this.idleTimer = null;
    this.installing = null;
  }

  platformBuild() { return BINARIES[process.platform] || null; }
  serverPath() { const b = this.platformBuild(); return b ? path.join(this.binDir, b.server) : null; }
  modelPath(id) { return path.join(this.dir, `ggml-${id}.bin`); }

  status() {
    const b = this.platformBuild();
    const installedModels = Object.keys(MODELS).filter((id) => fs.existsSync(this.modelPath(id)));
    return {
      supported: !!b && process.arch === 'x64',
      binary: !!(b && fs.existsSync(this.serverPath())),
      models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, size: m.size, installed: installedModels.includes(id) })),
      installed: !!(b && fs.existsSync(this.serverPath())) && installedModels.length > 0,
      installing: !!this.installing,
      running: !!(this.server && this.server.ready)
    };
  }

  // Download to a temp name, verify the hash, then move into place.
  async download(url, dest, sha256, onProgress) {
    const tmp = `${dest}.part`;
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'be-aero-desktop' } });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(tmp);
    const h = crypto.createHash('sha256');
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
    if (digest !== sha256) {
      try { fs.unlinkSync(tmp); } catch { /* gone */ }
      throw new Error(`checksum mismatch for ${path.basename(dest)} - the download was refused`);
    }
    fs.renameSync(tmp, dest);
  }

  extract(archive, kind, into) {
    return new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(new Error(`could not unpack the Whisper engine: ${err.message}`)) : resolve());
      if (kind === 'zip') {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath $env:AERO_ZIP -DestinationPath $env:AERO_DEST -Force`],
        { windowsHide: true, timeout: 120000, env: { ...process.env, AERO_ZIP: archive, AERO_DEST: into } }, done);
      } else {
        execFile('tar', ['-xzf', archive, '-C', into], { timeout: 120000 }, done);
      }
    });
  }

  // Install the engine (once) and the chosen model. onProgress({stage, got, total}).
  async install(modelId = 'base.en', onProgress = () => {}) {
    if (this.installing) return this.installing;
    const b = this.platformBuild();
    if (!b || process.arch !== 'x64') throw new Error('Whisper downloads are available for Windows and Linux on x64.');
    if (!MODELS[modelId]) throw new Error(`unknown model ${modelId}`);
    this.installing = (async () => {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(this.serverPath())) {
        const archive = path.join(this.dir, b.archive === 'zip' ? 'engine.zip' : 'engine.tar.gz');
        await this.download(b.url, archive, b.sha256, (got, total) => onProgress({ stage: 'engine', got, total }));
        onProgress({ stage: 'unpack' });
        const stage = path.join(this.dir, 'unpack');
        fs.rmSync(stage, { recursive: true, force: true });
        fs.mkdirSync(stage, { recursive: true });
        await this.extract(archive, b.archive, stage);
        fs.rmSync(this.binDir, { recursive: true, force: true });
        fs.renameSync(path.join(stage, b.dir), this.binDir);
        fs.rmSync(stage, { recursive: true, force: true });
        fs.unlinkSync(archive);
        if (process.platform !== 'win32') { try { fs.chmodSync(this.serverPath(), 0o755); } catch { /* best effort */ } }
      }
      const m = this.modelPath(modelId);
      if (!fs.existsSync(m)) {
        await this.download(modelUrl(modelId), m, MODELS[modelId].sha256, (got, total) => onProgress({ stage: 'model', got, total: total || MODELS[modelId].size }));
      }
      onProgress({ stage: 'done' });
      return this.status();
    })();
    try { return await this.installing; } finally { this.installing = null; }
  }

  removeModel(id) {
    if (!MODELS[id]) return false;
    if (this.server && this.server.model === id) this.shutdown();
    try { fs.unlinkSync(this.modelPath(id)); return true; } catch { return false; }
  }

  pickModel(preferred) {
    if (preferred && fs.existsSync(this.modelPath(preferred))) return preferred;
    return ['base.en', 'small.en', 'tiny.en'].find((id) => fs.existsSync(this.modelPath(id))) || null;
  }

  // Start (or reuse) the server for `model`. Resolves when it answers.
  async ensureServer(model) {
    const id = this.pickModel(model);
    if (!id || !fs.existsSync(this.serverPath())) throw new Error('Whisper is not installed - download it in Settings > AI assistant > Voice.');
    this.touch();
    if (this.server && this.server.model === id && this.server.ready) return this.server;
    if (this.server && this.server.model === id && this.server.starting) return this.server.starting;
    this.shutdown();
    const port = await freePort();
    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 1)));
    const env = { ...process.env };
    if (process.platform === 'linux') env.LD_LIBRARY_PATH = [this.binDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    const proc = spawn(this.serverPath(), ['-m', this.modelPath(id), '--host', '127.0.0.1', '--port', String(port), '-t', threads, '-l', 'en', '-nt'],
      { cwd: this.binDir, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    proc.stdout.on('data', (d) => { log = (log + d).slice(-4000); });
    proc.stderr.on('data', (d) => { log = (log + d).slice(-4000); });
    const srv = { proc, port, model: id, ready: false, starting: null };
    this.server = srv;
    proc.on('exit', () => { if (this.server === srv) this.server = null; });
    srv.starting = (async () => {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) throw new Error(`Whisper server exited: ${log.split(/\r?\n/).filter(Boolean).slice(-2).join(' ')}`);
        try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.status) { srv.ready = true; return srv; } } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      this.shutdown();
      throw new Error('Whisper server did not start within 60 s');
    })();
    try { return await srv.starting; } finally { srv.starting = null; }
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.shutdown(), IDLE_MS);
  }

  // 16 kHz mono 16-bit WAV buffer -> text ('' for non-speech).
  async transcribe(wav, { model, prompt } = {}) {
    const srv = await this.ensureServer(model);
    this.touch();
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    if (prompt) fd.append('prompt', String(prompt).slice(0, 400));
    const res = await fetch(`http://127.0.0.1:${srv.port}/inference`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`Whisper: HTTP ${res.status}`);
    const j = await res.json();
    return cleanTranscript(j && j.text);
  }

  shutdown() {
    clearTimeout(this.idleTimer);
    if (this.server) { try { this.server.proc.kill(); } catch { /* gone */ } this.server = null; }
  }
}

module.exports = { Whisper, MODELS, BINARIES, cleanTranscript, sha256File };
