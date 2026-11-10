// OS-wide media controller: what is playing anywhere on the machine (any
// app that publishes a media session) and the transport verbs for it.
//
// Windows: Global System Media Transport Controls through WinRT, reached
// from a long-lived Windows PowerShell 5.1 worker (pwsh 7 cannot project
// WinRT types). Volume goes through the keyboard volume keys, which every
// app and the OS mixer honour. Linux: playerctl (MPRIS) for sessions and
// wpctl / pactl / amixer for volume. Pure helpers are exported for tests.
const { spawn, execFile } = require('child_process');
const fs = require('fs');

const QUERY_TIMEOUT_MS = 6000;
const ACTIONS = new Set(['play', 'pause', 'toggle', 'next', 'prev', 'stop', 'volup', 'voldown', 'mute']);

const WORKER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class VolKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Tap(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
}
'@
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(8000) | Out-Null
  $t.Result
}
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$lastKey = ''
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $cmd = $line.Trim()
  if ($null -eq $mgr) { $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) }
  if ($cmd -eq 'info') {
    $s = $null
    if ($mgr) { $s = $mgr.GetCurrentSession() }
    if ($null -eq $s) { [Console]::Out.WriteLine('{"status":"none"}'); continue }
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $pb = $s.GetPlaybackInfo()
    $tl = $s.GetTimelineProperties()
    $key = [string]$props.Title + '|' + [string]$props.Artist + '|' + [string]$props.AlbumTitle
    $thumb = $null
    $thumbSame = $true
    if ($key -ne $lastKey) {
      $thumbSame = $false
      $lastKey = $key
      $thumb = ''
      if ($props.Thumbnail) {
        try {
          $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
          $size = [uint32]$stream.Size
          if ($size -gt 0 -and $size -lt 400000) {
            $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
            $null = Await ($reader.LoadAsync($size)) ([uint32])
            $bytes = New-Object byte[] $size
            $reader.ReadBytes($bytes)
            $thumb = 'data:' + $stream.ContentType + ';base64,' + [Convert]::ToBase64String($bytes)
          }
        } catch { $thumb = '' }
      }
    }
    $out = [PSCustomObject]@{
      status = ([string]$pb.PlaybackStatus).ToLower(); title = [string]$props.Title; artist = [string]$props.Artist; album = [string]$props.AlbumTitle
      app = [string]$s.SourceAppUserModelId; position = [double]$tl.Position.TotalSeconds; duration = [double]$tl.EndTime.TotalSeconds
      updatedAt = [double]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()
      canSeek = [bool]$pb.Controls.IsPlaybackPositionEnabled
      rate = $(if ($pb.PlaybackRate) { [double]$pb.PlaybackRate } else { 1.0 })
      canNext = [bool]$pb.Controls.IsNextEnabled; canPrev = [bool]$pb.Controls.IsPreviousEnabled
      canPlay = [bool]$pb.Controls.IsPlayEnabled; canPause = [bool]$pb.Controls.IsPauseEnabled
      thumb = $thumb; thumbSame = $thumbSame
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Compress))
  } elseif ($cmd -eq 'volup') { [VolKeys]::Tap(0xAF); [Console]::Out.WriteLine('ok') }
  elseif ($cmd -eq 'voldown') { [VolKeys]::Tap(0xAE); [Console]::Out.WriteLine('ok') }
  elseif ($cmd -eq 'mute') { [VolKeys]::Tap(0xAD); [Console]::Out.WriteLine('ok') }
  else {
    $s = $null
    if ($mgr) { $s = $mgr.GetCurrentSession() }
    if ($null -eq $s) { [Console]::Out.WriteLine('none'); continue }
    $r = $false
    if ($cmd.StartsWith('seek ')) {
      $ticks = [int64]([double]$cmd.Substring(5) * 10000000)
      $r = Await ($s.TryChangePlaybackPositionAsync($ticks)) ([bool])
    } else { switch ($cmd) {
      'play'   { $r = Await ($s.TryPlayAsync()) ([bool]) }
      'pause'  { $r = Await ($s.TryPauseAsync()) ([bool]) }
      'toggle' { $r = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
      'next'   { $r = Await ($s.TrySkipNextAsync()) ([bool]) }
      'prev'   { $r = Await ($s.TrySkipPreviousAsync()) ([bool]) }
      'stop'   { $r = Await ($s.TryStopAsync()) ([bool]) }
    } }
    if ($r) { [Console]::Out.WriteLine('ok') } else { [Console]::Out.WriteLine('err') }
  }
}
`;

// Where the track is NOW. Windows reports the timeline only when the app
// publishes it (often just on play/pause/seek), stamped with LastUpdatedTime;
// while playing, the live position is that report plus the time since,
// scaled by the playback rate, clamped to the track. A missing or
// implausible stamp (older than the track itself) leaves the report as is.
function livePosition(info, now = Date.now()) {
  const pos = Number(info && info.position) || 0;
  const dur = Number(info && info.duration) || 0;
  const at = Number(info && info.updatedAt) || 0;
  if (!info || info.status !== 'playing' || at <= 0) return pos;
  const elapsed = (now - at) / 1000;
  if (elapsed < 0) return pos;
  if (dur > 0 && elapsed > dur + 60) return pos;
  const rate = Number(info.rate) > 0 ? Number(info.rate) : 1;
  const live = pos + elapsed * rate;
  return dur > 0 ? Math.min(dur, live) : live;
}

// playerctl's tab-separated metadata line -> info object.
function parsePlayerctl(line) {
  const parts = String(line || '').replace(/\r?\n$/, '').split('\t');
  if (parts.length < 5) return null;
  const [status, title, artist, album, player, position, length, artUrl] = parts;
  const st = String(status || '').toLowerCase();
  return {
    status: st === 'playing' ? 'playing' : st === 'paused' ? 'paused' : st === 'stopped' ? 'stopped' : 'none',
    title: title || '', artist: artist || '', album: album || '', app: player || '',
    position: (Number(position) || 0) / 1e6, duration: (Number(length) || 0) / 1e6,
    canNext: true, canPrev: true, canPlay: true, canPause: true,
    artUrl: artUrl || ''
  };
}

// "Volume: 0.45 [MUTED]" (wpctl) or "... 45% ..." (pactl / amixer) -> {volume, muted}
function parseVolume(text) {
  const s = String(text || '');
  let m = /Volume:\s*([\d.]+)(\s*\[MUTED\])?/i.exec(s);
  if (m) return { volume: Math.round(Number(m[1]) * 100), muted: !!m[2] };
  m = /(\d{1,3})%/.exec(s);
  if (m) return { volume: Number(m[1]), muted: /\[off\]|Mute:\s*yes/i.test(s) };
  return null;
}

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

class MediaController {
  constructor() {
    this.ps = null;
    this.buffer = '';
    this.queue = Promise.resolve();
    this.waiters = [];
    this.lastThumb = '';
    this.artCache = new Map();
    this.missing = 0;      // Linux: when playerctl was last found absent
    this.mpris = null;     // Linux: D-Bus backend when playerctl is not installed
    this.linuxBackend = null;   // 'playerctl' | 'dbus' | null
  }

  // ---------------------------------------------------------------- windows
  ensure() {
    if (this.ps || process.platform !== 'win32') return;
    this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WORKER_SCRIPT], { windowsHide: true });
    this.ps.stdout.on('data', (d) => {
      this.buffer += d;
      let i;
      while ((i = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(line);
      }
    });
    const die = () => { for (const w of this.waiters.splice(0)) w(null); this.ps = null; this.buffer = ''; };
    this.ps.on('exit', die);
    this.ps.on('error', die);
  }

  send(command) {
    this.ensure();
    if (!this.ps) return Promise.resolve(null);
    const go = () => new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(null);
      }, QUERY_TIMEOUT_MS);
      const waiter = (line) => { clearTimeout(timer); resolve(line); };
      this.waiters.push(waiter);
      try { this.ps.stdin.write(`${command}\n`); } catch { resolve(null); }
    });
    const next = this.queue.then(go, go);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  async infoWindows() {
    const line = await this.send('info');
    if (!line) return { available: false, status: 'none', hint: 'The media worker did not answer.' };
    let r;
    try { r = JSON.parse(line); } catch { return { available: true, status: 'none' }; }
    if (!r || r.status === 'none') return { available: true, status: 'none' };
    if (r.thumbSame) r.thumb = this.lastThumb; else this.lastThumb = r.thumb || '';
    delete r.thumbSame;
    const now = Date.now();
    return { available: true, volume: null, muted: null, ...r, reported: r.position, position: livePosition(r, now), sampledAt: now };
  }

  // ------------------------------------------------------------------ linux
  async artFor(url) {
    if (!url) return '';
    if (/^https?:/i.test(url)) return url;
    if (this.artCache.has(url)) return this.artCache.get(url);
    let data = '';
    const m = /^file:\/\/(.*)$/i.exec(url);
    if (m) {
      try {
        const p = decodeURIComponent(m[1]);
        const buf = fs.readFileSync(p);
        if (buf.length && buf.length < 600 * 1024) {
          const mime = /\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
          data = `data:${mime};base64,${buf.toString('base64')}`;
        }
      } catch { data = ''; }
    }
    if (this.artCache.size > 20) this.artCache.clear();
    this.artCache.set(url, data);
    return data;
  }

  async volumeLinux() {
    let out = await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']);
    if (out === null) out = await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
    if (out === null) out = await run('amixer', ['get', 'Master']);
    return out === null ? {} : (parseVolume(out) || {});
  }

  // Linux: playerctl when installed, otherwise MPRIS straight over D-Bus
  // (gdbus / busctl), which every desktop session has. Debian does not ship
  // playerctl, so the D-Bus path is the one most people use.
  async infoLinux() {
    if (Date.now() - this.missing < 30000) return this.infoDbus();
    const out = await run('playerctl', ['metadata', '--format', '{{status}}\t{{title}}\t{{artist}}\t{{album}}\t{{playerName}}\t{{position}}\t{{mpris:length}}\t{{mpris:artUrl}}']);
    if (out === null) {
      // playerctl exits non-zero both when absent and when no player runs.
      const which = await run('sh', ['-c', 'command -v playerctl']);
      if (!which) { this.missing = Date.now(); return this.infoDbus(); }
      this.linuxBackend = 'playerctl';
      return { available: true, status: 'none', ...(await this.volumeLinux()) };
    }
    this.linuxBackend = 'playerctl';
    const info = parsePlayerctl(out) || { status: 'none' };
    info.sampledAt = Date.now();      // MPRIS reports the position as of now
    const thumb = await this.artFor(info.artUrl);
    delete info.artUrl;
    return { available: true, ...info, thumb, ...(await this.volumeLinux()) };
  }

  async infoDbus() {
    if (!this.mpris) this.mpris = new (require('./mpris').Mpris)();
    const info = await this.mpris.info();
    if (!info) {
      this.linuxBackend = null;
      return { available: false, status: 'none', hint: 'No way to reach media players: install playerctl (sudo apt install playerctl) or the gdbus tool from GLib.' };
    }
    this.linuxBackend = 'dbus';
    if (info.status === 'none') return { available: true, status: 'none', ...(await this.volumeLinux()) };
    const thumb = await this.artFor(info.artUrl);
    delete info.artUrl;
    return { available: true, ...info, thumb, ...(await this.volumeLinux()) };
  }

  async actionLinux(name) {
    if (name === 'volup' || name === 'voldown' || name === 'mute') {
      const wp = name === 'mute' ? ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle'] : ['set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', name === 'volup' ? '5%+' : '5%-'];
      if (await run('wpctl', wp) !== null) return true;
      const pa = name === 'mute' ? ['set-sink-mute', '@DEFAULT_SINK@', 'toggle'] : ['set-sink-volume', '@DEFAULT_SINK@', name === 'volup' ? '+5%' : '-5%'];
      if (await run('pactl', pa) !== null) return true;
      const am = name === 'mute' ? ['set', 'Master', 'toggle'] : ['set', 'Master', name === 'volup' ? '5%+' : '5%-'];
      return (await run('amixer', am)) !== null;
    }
    if (this.linuxBackend === 'dbus' && this.mpris) return this.mpris.action(name);
    const verb = { play: 'play', pause: 'pause', toggle: 'play-pause', next: 'next', prev: 'previous', stop: 'stop' }[name];
    return verb ? (await run('playerctl', [verb])) !== null : false;
  }

  // ------------------------------------------------------------------ public
  async info() {
    if (process.platform === 'win32') return this.infoWindows();
    if (process.platform === 'linux') return this.infoLinux();
    return { available: false, status: 'none', hint: 'Media control is not available on this platform yet.' };
  }

  // Jump to `seconds` in the current track.
  async seek(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s < 0 || s > 24 * 3600) return false;
    if (process.platform === 'win32') return (await this.send(`seek ${s.toFixed(3)}`)) === 'ok';
    if (process.platform === 'linux') {
      if (this.linuxBackend === 'dbus' && this.mpris) return this.mpris.seek(s);
      return (await run('playerctl', ['position', s.toFixed(3)])) !== null;
    }
    return false;
  }

  async action(name) {
    if (!ACTIONS.has(name)) return false;
    if (process.platform === 'win32') return (await this.send(name)) === 'ok';
    if (process.platform === 'linux') return this.actionLinux(name);
    return false;
  }

  destroy() {
    if (this.ps) { try { this.ps.kill(); } catch { /* gone */ } }
    this.ps = null;
  }
}

module.exports = { MediaController, parsePlayerctl, parseVolume, livePosition, ACTIONS };
