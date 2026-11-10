// Voice for the AI chat, offline: nothing leaves the machine.
//
// Audio is captured in the RENDERER (getUserMedia, so the user picks the
// microphone and the speaker like any web app) and streamed here as 16 kHz
// mono 16-bit PCM. Speech-to-text: Windows feeds that stream straight into
// the OS recognizer (System.Speech) in a PowerShell worker; Linux writes a
// WAV and hands it to whisper.cpp when installed. Text-to-speech renders a
// WAV in main (System.Speech / espeak-ng) that the renderer plays on the
// chosen output device; without an engine the renderer falls back to
// speechSynthesis.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RATE = 16000;

// Reads raw PCM from stdin until it closes; every recognized phrase is one
// JSON line on stdout. InitialSilence/Babble timeouts are zero (= none), so
// Recognize() only returns null at the end of the stream.
const WIN_STT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Emit($o) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress)); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Speech
  # System.Speech insists on a seekable stream; a pipe is not. This wrapper
  # reports a position it tracks itself and treats every Seek as a no-op.
  Add-Type @'
using System; using System.IO;
public class PipeAudioStream : Stream {
  private readonly Stream inner; private long pos;
  public PipeAudioStream(Stream s) { inner = s; }
  public override bool CanRead { get { return true; } }
  public override bool CanSeek { get { return true; } }
  public override bool CanWrite { get { return false; } }
  public override long Length { get { return long.MaxValue; } }
  public override long Position { get { return pos; } set { } }
  public override void Flush() { }
  // Fill the whole request: a pipe hands out small pieces and the recognizer
  // treats a short read as the end of the audio.
  public override int Read(byte[] b, int o, int c) {
    int total = 0;
    while (total < c) { int n = inner.Read(b, o + total, c - total); if (n <= 0) break; total += n; }
    pos += total; return total;
  }
  public override long Seek(long off, SeekOrigin or) { return pos; }
  public override void SetLength(long v) { }
  public override void Write(byte[] b, int o, int c) { throw new NotSupportedException(); }
}
'@
  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $rec.SetInputToAudioStream((New-Object PipeAudioStream([Console]::OpenStandardInput())), $fmt)
  $rec.InitialSilenceTimeout = [TimeSpan]::Zero
  $rec.BabbleTimeout = [TimeSpan]::Zero
  $rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(0.8)
  $rec.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(1.1)
} catch {
  Emit @{ type = 'error'; text = ('Speech recognition is not available: ' + $_.Exception.Message) }
  exit 0
}
Emit @{ type = 'ready'; engine = 'System.Speech' }
while ($true) {
  $r = $null
  try { $r = $rec.Recognize() } catch { Emit @{ type = 'error'; text = $_.Exception.Message }; break }
  if ($null -eq $r) { break }
  if ($r.Text) { Emit @{ type = 'final'; text = $r.Text; confidence = [math]::Round($r.Confidence, 2) } }
}
`;

// Text on stdin -> WAV (22.05 kHz mono) written to the path in argv.
const WIN_TTS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [Console]::In.ReadToEnd()
$out = $env:AERO_TTS_OUT; $voice = $env:AERO_TTS_VOICE; $rate = [int]$env:AERO_TTS_RATE
$syn = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($voice) { try { $syn.SelectVoice($voice) } catch { } }
$syn.Rate = [math]::Max(-10, [math]::Min(10, $rate))
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$syn.SetOutputToWaveFile($out, $fmt)
$syn.Speak($text)
$syn.Dispose()
`;

const WIN_VOICES = `
Add-Type -AssemblyName System.Speech
$syn = New-Object System.Speech.Synthesis.SpeechSynthesizer
$syn.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + "\`t" + $_.VoiceInfo.Culture.Name + "\`t" + $_.VoiceInfo.Gender }
`;

function which(cmd) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? [cmd] : ['-c', `command -v ${cmd}`], { windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim().split(/\r?\n/)[0] || null));
  });
}

async function whisperTools() {
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
  return { whisper, model };
}

// 44-byte RIFF header for 16-bit mono PCM.
function wavHeader(dataBytes, rate = RATE) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  return b;
}

function runPs(script, env, { input, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, ...(env || {}) } });
    let out = '';
    let err = '';
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.on('error', () => { clearTimeout(t); resolve({ code: -1, out, err: 'spawn failed' }); });
    if (input !== undefined) { try { p.stdin.write(input, 'utf8'); } catch { /* ignore */ } }
    try { p.stdin.end(); } catch { /* ignore */ }
  });
}

class Voice {
  constructor({ emit }) {
    this.emit = emit;          // (event) => void: { type: ready|final|error|end, text? }
    this.proc = null;          // Windows recognizer worker
    this.chunks = null;        // Linux: PCM collected for whisper
    this.fedBytes = 0;
    this.voiceCache = null;
  }

  async available() {
    const base = { listening: this.listening(), fedBytes: this.fedBytes };
    if (process.platform === 'win32') return { ...base, stt: true, tts: true, engine: 'Windows Speech Recognition (offline)' };
    if (process.platform === 'linux') {
      const t = await whisperTools();
      const tts = !!(await which('espeak-ng')) || !!(await which('espeak'));
      if (!t.whisper) return { ...base, stt: false, tts, reason: 'No offline recognizer found: install whisper.cpp (whisper-cli) and a ggml model, or set WHISPER_MODEL.' };
      if (!t.model) return { ...base, stt: false, tts, reason: 'whisper.cpp found but no ggml model: put one in ~/.cache/whisper or set WHISPER_MODEL.' };
      return { ...base, stt: true, tts, engine: `whisper.cpp (${path.basename(t.model)})` };
    }
    return { ...base, stt: false, tts: false, reason: 'Voice input is not available on this platform yet.' };
  }

  listening() { return !!(this.proc || this.chunks); }

  // Begin a dictation session; the renderer then streams PCM with feed().
  start() {
    if (this.listening()) return true;
    this.fedBytes = 0;
    if (process.platform === 'win32') {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_STT], { windowsHide: true });
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
      p.stdin.on('error', () => { /* worker went away mid-feed */ });
      const done = () => { if (this.proc === p) { this.proc = null; this.emit({ type: 'end' }); } };
      p.on('exit', done);
      p.on('error', (err) => { this.emit({ type: 'error', text: err.message }); done(); });
      return true;
    }
    if (process.platform === 'linux') {
      this.chunks = [];
      whisperTools().then((t) => {
        if (!t.whisper || !t.model) {
          this.available().then((a) => { this.emit({ type: 'error', text: a.reason }); this.chunks = null; this.emit({ type: 'end' }); });
          return;
        }
        this.emit({ type: 'ready', engine: 'whisper.cpp' });
      });
      return true;
    }
    this.emit({ type: 'error', text: 'Voice input is not available on this platform yet.' });
    this.emit({ type: 'end' });
    return false;
  }

  // 16 kHz mono 16-bit little-endian PCM from the renderer.
  feed(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer ? bytes.buffer : bytes);
    if (!buf.length) return false;
    this.fedBytes += buf.length;
    if (this.proc) { try { this.proc.stdin.write(buf); } catch { return false; } return true; }
    if (this.chunks) {
      this.chunks.push(buf);
      // 5 minutes of audio is plenty for one dictation.
      if (this.fedBytes > RATE * 2 * 300) this.stop();
      return true;
    }
    return false;
  }

  stop() {
    if (this.proc) { try { this.proc.stdin.end(); } catch { /* gone */ } }
    if (this.chunks) {
      const data = Buffer.concat(this.chunks);
      this.chunks = null;
      this.transcribeLinux(data);
    }
    return true;
  }

  async transcribeLinux(pcm) {
    const t = await whisperTools();
    if (!t.whisper || !t.model) { this.emit({ type: 'end' }); return; }
    if (pcm.length < RATE) { this.emit({ type: 'end' }); return; }   // under half a second: nothing said
    const wav = path.join(os.tmpdir(), `aero-voice-${process.pid}-${Date.now()}.wav`);
    try { fs.writeFileSync(wav, Buffer.concat([wavHeader(pcm.length), pcm])); } catch (err) { this.emit({ type: 'error', text: err.message }); this.emit({ type: 'end' }); return; }
    execFile(t.whisper, ['-m', t.model, '-f', wav, '-nt', '-np', '-l', 'auto'], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      try { fs.unlinkSync(wav); } catch { /* gone */ }
      if (err) this.emit({ type: 'error', text: `Transcription failed: ${String(err.message).split('\n')[0]}` });
      else {
        const text = String(stdout || '').split(/\r?\n/).map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean).join(' ');
        if (text) this.emit({ type: 'final', text });
      }
      this.emit({ type: 'end' });
    });
  }

  // Installed TTS voices: [{ name, lang, gender }]. Empty when the renderer
  // should fall back to speechSynthesis.
  async voices() {
    if (this.voiceCache) return this.voiceCache;
    let list = [];
    if (process.platform === 'win32') {
      const r = await runPs(WIN_VOICES, {}, { timeout: 15000 });
      list = String(r.out || '').split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p[0]).map(([name, lang, gender]) => ({ name, lang: lang || '', gender: gender || '' }));
    } else if (process.platform === 'linux' && (await which('espeak-ng'))) {
      const out = await new Promise((resolve) => execFile('espeak-ng', ['--voices'], { timeout: 5000 }, (e, o) => resolve(e ? '' : String(o))));
      list = out.split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 4).map((p) => ({ name: p[3], lang: p[1], gender: p[2] })).slice(0, 200);
    }
    this.voiceCache = list;
    return list;
  }

  // Render text to a WAV (base64) with the chosen voice and rate (0.5-2).
  async speak(text, { voice = '', rate = 1 } = {}) {
    const t = String(text || '').trim().slice(0, 4000);
    if (!t) return null;
    const out = path.join(os.tmpdir(), `aero-tts-${process.pid}-${Date.now()}.wav`);
    try {
      if (process.platform === 'win32') {
        const r10 = Math.round((Math.max(0.5, Math.min(2, Number(rate) || 1)) - 1) * 10);
        const r = await runPs(WIN_TTS, { AERO_TTS_OUT: out, AERO_TTS_VOICE: voice || '', AERO_TTS_RATE: String(r10) }, { input: t, timeout: 60000 });
        if (r.code !== 0 && !fs.existsSync(out)) return null;
      } else if (process.platform === 'linux' && (await which('espeak-ng') || await which('espeak'))) {
        const bin = (await which('espeak-ng')) ? 'espeak-ng' : 'espeak';
        const wpm = Math.round(175 * Math.max(0.5, Math.min(2, Number(rate) || 1)));
        const args = ['-w', out, '-s', String(wpm), ...(voice ? ['-v', voice] : []), t];
        const ok = await new Promise((resolve) => execFile(bin, args, { timeout: 60000 }, (e) => resolve(!e)));
        if (!ok) return null;
      } else return null;
      const wav = fs.readFileSync(out);
      return wav.length > 44 ? wav.toString('base64') : null;
    } catch { return null; } finally {
      try { fs.unlinkSync(out); } catch { /* gone */ }
    }
  }
}

module.exports = { Voice, wavHeader, whisperTools, RATE };
