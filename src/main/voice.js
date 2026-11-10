// Voice input for the AI chat: offline speech-to-text, nothing leaves the
// machine. Windows: System.Speech dictation (the OS's own recognizer) in a
// PowerShell worker that streams JSON lines until it is stopped. Linux: a
// recording (parecord / arecord) handed to whisper.cpp when it is installed.
// Text-to-speech happens in the renderer (speechSynthesis).
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Emit($o) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress)) }
try {
  Add-Type -AssemblyName System.Speech
  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $rec.SetInputToDefaultAudioDevice()
  $rec.InitialSilenceTimeout = [TimeSpan]::FromSeconds(30)
  $rec.BabbleTimeout = [TimeSpan]::FromSeconds(10)
  $rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(0.9)
  $rec.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(1.2)
} catch {
  Emit @{ type = 'error'; text = ('Speech recognition is not available: ' + $_.Exception.Message) }
  exit 0
}
Emit @{ type = 'ready' }
while ($true) {
  $r = $null
  try { $r = $rec.Recognize([TimeSpan]::FromSeconds(30)) } catch { Emit @{ type = 'error'; text = $_.Exception.Message }; break }
  if ($r -and $r.Text) { Emit @{ type = 'final'; text = $r.Text; confidence = [math]::Round($r.Confidence, 2) } }
}
`;

function which(cmd) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? [cmd] : ['-c', `command -v ${cmd}`], { windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim().split(/\r?\n/)[0] || null));
  });
}

async function linuxTools() {
  const recorder = (await which('parecord')) ? 'parecord' : (await which('arecord')) ? 'arecord' : null;
  const whisper = (await which('whisper-cli')) || (await which('whisper-cpp')) || (await which('whisper')) || (await which('main'));
  let model = process.env.WHISPER_MODEL || '';
  if (!model) {
    for (const dir of [path.join(os.homedir(), '.cache', 'whisper'), path.join(os.homedir(), '.local', 'share', 'whisper'), '/usr/share/whisper', '/usr/local/share/whisper', path.join(os.homedir(), 'whisper.cpp', 'models')]) {
      try {
        const f = fs.readdirSync(dir).find((n) => /^ggml-.*\.bin$/.test(n));
        if (f) { model = path.join(dir, f); break; }
      } catch { /* next */ }
    }
  }
  return { recorder, whisper, model };
}

class Voice {
  constructor({ emit }) {
    this.emit = emit;        // (event) => void, event: { type: ready|final|error|end, text? }
    this.proc = null;
    this.recording = null;
  }

  async available() {
    if (process.platform === 'win32') return { stt: true, engine: 'Windows Speech Recognition (offline)' };
    if (process.platform === 'linux') {
      const t = await linuxTools();
      if (!t.recorder) return { stt: false, reason: 'No recorder found (install pulseaudio-utils for parecord, or alsa-utils for arecord).' };
      if (!t.whisper) return { stt: false, reason: 'No offline recognizer found: install whisper.cpp (whisper-cli) and a ggml model, or set WHISPER_MODEL.' };
      if (!t.model) return { stt: false, reason: 'whisper.cpp found but no ggml model: put one in ~/.cache/whisper or set WHISPER_MODEL.' };
      return { stt: true, engine: `whisper.cpp (${path.basename(t.model)})` };
    }
    return { stt: false, reason: 'Voice input is not available on this platform yet.' };
  }

  listening() { return !!(this.proc || this.recording); }

  start() {
    if (this.listening()) return true;
    if (process.platform === 'win32') {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT], { windowsHide: true });
      this.proc = p;
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try { this.emit(JSON.parse(line)); } catch { /* not ours */ }
        }
      });
      const done = () => { if (this.proc === p) { this.proc = null; this.emit({ type: 'end' }); } };
      p.on('exit', done);
      p.on('error', (err) => { this.emit({ type: 'error', text: err.message }); done(); });
      return true;
    }
    if (process.platform === 'linux') {
      this.startLinux();
      return true;
    }
    this.emit({ type: 'error', text: 'Voice input is not available on this platform yet.' });
    this.emit({ type: 'end' });
    return false;
  }

  async startLinux() {
    const t = await linuxTools();
    if (!t.recorder || !t.whisper || !t.model) {
      this.emit({ type: 'error', text: (await this.available()).reason });
      this.emit({ type: 'end' });
      return;
    }
    const wav = path.join(os.tmpdir(), `aero-voice-${process.pid}-${Date.now()}.wav`);
    const args = t.recorder === 'parecord'
      ? ['--format=s16le', '--rate=16000', '--channels=1', '--file-format=wav', wav]
      : ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', wav];
    const rec = spawn(t.recorder, args, { stdio: 'ignore' });
    this.recording = { proc: rec, wav, tools: t };
    this.emit({ type: 'ready' });
    rec.on('exit', () => this.transcribeLinux(wav, t));
    rec.on('error', (err) => { this.emit({ type: 'error', text: err.message }); this.recording = null; this.emit({ type: 'end' }); });
    // Safety stop: a forgotten microphone is not recorded for ever.
    setTimeout(() => { if (this.recording && this.recording.proc === rec) this.stop(); }, 60 * 1000);
  }

  transcribeLinux(wav, t) {
    this.recording = null;
    execFile(t.whisper, ['-m', t.model, '-f', wav, '-nt', '-np', '-l', 'auto'], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      try { fs.unlinkSync(wav); } catch { /* gone */ }
      if (err) this.emit({ type: 'error', text: `Transcription failed: ${err.message.split('\n')[0]}` });
      else {
        const text = String(stdout || '').split(/\r?\n/).map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean).join(' ');
        if (text) this.emit({ type: 'final', text });
      }
      this.emit({ type: 'end' });
    });
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch { /* gone */ } }
    if (this.recording) { try { this.recording.proc.kill('SIGINT'); } catch { /* gone */ } }
    return true;
  }
}

module.exports = { Voice, linuxTools };
