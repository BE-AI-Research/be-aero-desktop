// Open-window enumeration and control for the Task switcher widget.
//
// Windows has no Node-level API for other apps' windows, so a single
// long-lived PowerShell worker (same pattern as peer.js) does the Win32 calls:
// EnumWindows filtered the way the taskbar filters (visible, titled, not a
// tool window, not a DWM-cloaked ghost), plus ShowWindowAsync /
// SetForegroundWindow / WM_CLOSE for the management actions.
const { spawn } = require('child_process');

const QUERY_TIMEOUT_MS = 5000;

// What the context menu may do. Anything else from the renderer is refused.
const ACTIONS = Object.freeze({
  activate: 'act',
  minimize: 'min',
  maximize: 'max',
  restore: 'restore',
  close: 'close',
  raise: 'raise'
});

const WORKER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
# UTF-8 stdout, or the console codepage's best-fit mapping mangles Unicode on
# the way out: a bullet (U+2022) in a window title becomes byte 0x07 - a raw
# control character inside what is supposed to be JSON.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int cy, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, ref int value, uint winIni);
}
[StructLayout(LayoutKind.Sequential)]
public struct SHQUERYRBINFO { public int cbSize; public long i64Size; public long i64NumItems; }
public class WinBin {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SHQueryRecycleBin(string root, ref SHQUERYRBINFO info);
}
[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct AumKey { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct AumVar { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAumStore {
  [PreserveSig] int GetCount(out uint c);
  [PreserveSig] int GetAt(uint i, out AumKey k);
  [PreserveSig] int GetValue(ref AumKey k, out AumVar v);
  [PreserveSig] int SetValue(ref AumKey k, ref AumVar v);
  [PreserveSig] int Commit();
}
public class WinAum {
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, out IAumStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref AumVar v);
  // A window's AppUserModelID (how the taskbar tells apps apart), or null.
  public static string Get(IntPtr h) {
    IAumStore s = null;
    try {
      Guid iid = typeof(IAumStore).GUID;
      if (SHGetPropertyStoreForWindow(h, ref iid, out s) != 0 || s == null) return null;
      AumKey k = new AumKey(); k.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); k.pid = 5;
      AumVar v;
      if (s.GetValue(ref k, out v) != 0) return null;
      string r = (v.vt == 31 && v.p != IntPtr.Zero) ? Marshal.PtrToStringUni(v.p) : null;
      PropVariantClear(ref v);
      return r;
    } catch { return null; }
    finally { if (s != null) Marshal.ReleaseComObject(s); }
  }
}
'@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim() -split ' '
  $cmd = $parts[0]
  if ($cmd -eq 'list') {
    $list = New-Object System.Collections.ArrayList
    $cb = [WinEnum+EnumProc]{ param($h, $l)
      if (-not [WinEnum]::IsWindowVisible($h)) { return $true }
      $len = [WinEnum]::GetWindowTextLength($h)
      if ($len -lt 1) { return $true }
      $ex = [WinEnum]::GetWindowLong($h, -20)
      if ($ex -band 0x80) { return $true }
      $cloaked = 0
      [WinEnum]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4) | Out-Null
      if ($cloaked -ne 0) { return $true }
      $sb = New-Object System.Text.StringBuilder ($len + 1)
      [WinEnum]::GetWindowText($h, $sb, $len + 1) | Out-Null
      # Window titles can carry raw control characters (Threads' PWA does);
      # PowerShell 5.1's ConvertTo-Json passes some straight through, which is
      # invalid JSON and would blank the whole list. Scrub them here. The char
      # class is built from char codes because this script travels through a
      # JS template literal, which silently eats backslash escapes.
      $ctl = '[' + [char]1 + '-' + [char]31 + [char]127 + ']'
      $title = $sb.ToString() -replace $ctl, ' '
      $wpid = [uint32]0
      [WinEnum]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
      $proc = Get-Process -Id $wpid
      $null = $list.Add([PSCustomObject]@{
        hwnd = [int64]$h; title = $title; pid = $wpid
        exe = $proc.Path; min = [WinEnum]::IsIconic($h); aumid = [WinAum]::Get($h)
        fg = ($h -eq [WinEnum]::GetForegroundWindow())
      })
      $true
    }
    [WinEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($list) -Compress))
  } elseif ($cmd -eq 'saver') {
    # SPI_GETSCREENSAVERRUNNING (0x72): is the screen saver on screen now?
    $v = 0
    [WinEnum]::SystemParametersInfo(0x72, 0, [ref]$v, 0) | Out-Null
    [Console]::Out.WriteLine([string]$v)
  } elseif ($cmd -eq 'act' -and $parts.Length -gt 1) {
    $h = [IntPtr][int64]$parts[1]
    if ([WinEnum]::IsIconic($h)) { [WinEnum]::ShowWindowAsync($h, 9) | Out-Null }
    [WinEnum]::SetForegroundWindow($h) | Out-Null
    [Console]::Out.WriteLine('ok')
  } elseif ($cmd -eq 'raise' -and $parts.Length -gt 1) {
    # Bring a window up even though this helper is not the foreground app:
    # borrow the foreground window's input (the sidebar, just clicked) so
    # Windows lets SetForegroundWindow through.
    $h = [IntPtr][int64]$parts[1]
    $fg = [WinEnum]::GetForegroundWindow()
    $x = [uint32]0
    $fgT = [WinEnum]::GetWindowThreadProcessId($fg, [ref]$x)
    $me = [WinEnum]::GetCurrentThreadId()
    $att = $false
    if ($fgT -ne 0 -and $fgT -ne $me) { $att = [WinEnum]::AttachThreadInput($me, $fgT, $true) }
    $min = [WinEnum]::IsIconic($h)
    if (-not $min) { [WinEnum]::ShowWindow($h, 5) | Out-Null }
    # HWND_TOPMOST (-1) then HWND_NOTOPMOST (-2): to the top of the z-order. SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW = 0x43
    [WinEnum]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x43) | Out-Null
    [WinEnum]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x43) | Out-Null
    [WinEnum]::BringWindowToTop($h) | Out-Null
    [WinEnum]::SetForegroundWindow($h) | Out-Null
    # Minimized (a UAC prompt Windows held back sits minimized on the
    # taskbar): restore it the way a taskbar click does - WM_SYSCOMMAND
    # SC_RESTORE. Activating alone does not make consent.exe show the prompt;
    # this does (verified: the secure desktop opens at once).
    if ($min) { [WinEnum]::PostMessage($h, 0x0112, [IntPtr]0xF120, [IntPtr]::Zero) | Out-Null }
    if ($att) { [WinEnum]::AttachThreadInput($me, $fgT, $false) | Out-Null }
    [Console]::Out.WriteLine('ok')
  } elseif ($cmd -eq 'bin') {
    $info = New-Object SHQUERYRBINFO
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
    $hr = [WinBin]::SHQueryRecycleBin($null, [ref]$info)
    [Console]::Out.WriteLine('{"hr":' + $hr + ',"items":' + $info.i64NumItems + ',"size":' + $info.i64Size + '}')
  } elseif ($cmd -eq 'min' -and $parts.Length -gt 1) {
    [WinEnum]::ShowWindowAsync([IntPtr][int64]$parts[1], 6) | Out-Null
    [Console]::Out.WriteLine('ok')
  } elseif ($cmd -eq 'max' -and $parts.Length -gt 1) {
    [WinEnum]::ShowWindowAsync([IntPtr][int64]$parts[1], 3) | Out-Null
    [Console]::Out.WriteLine('ok')
  } elseif ($cmd -eq 'restore' -and $parts.Length -gt 1) {
    [WinEnum]::ShowWindowAsync([IntPtr][int64]$parts[1], 9) | Out-Null
    [Console]::Out.WriteLine('ok')
  } elseif ($cmd -eq 'close' -and $parts.Length -gt 1) {
    [WinEnum]::PostMessage([IntPtr][int64]$parts[1], 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    [Console]::Out.WriteLine('ok')
  } elseif ($cmd -eq 'bottom' -and $parts.Length -gt 1) {
    # HWND_BOTTOM = 1; SWP_NOSIZE(1) + SWP_NOMOVE(2) + SWP_NOACTIVATE(16) = 0x13
    [WinEnum]::SetWindowPos([IntPtr][int64]$parts[1], [IntPtr]1, 0, 0, 0, 0, 0x13) | Out-Null
    [Console]::Out.WriteLine('ok')
  } elseif ($cmd -eq 'setpos' -and $parts.Length -gt 5) {
    [WinEnum]::MoveWindow([IntPtr][int64]$parts[1], [int]$parts[2], [int]$parts[3], [int]$parts[4], [int]$parts[5], $true) | Out-Null
    [Console]::Out.WriteLine('ok')
  } elseif ($cmd -eq 'uac') {
    # UAC shield: is consent.exe (the elevation prompt) running, and does it
    # have a visible window on this desktop (a prompt Windows held back)?
    $cp = @(Get-Process consent -ErrorAction SilentlyContinue)
    $script:uacHwnd = 0
    if ($cp.Count -gt 0) {
      $uacIds = @{}
      foreach ($p in $cp) { $uacIds[[uint32]$p.Id] = $true }
      $cbu = [WinEnum+EnumProc]{ param($h, $l)
        $wpid = [uint32]0
        [WinEnum]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
        if ($uacIds.ContainsKey($wpid) -and [WinEnum]::IsWindowVisible($h)) { $script:uacHwnd = [int64]$h; return $false }
        $true
      }
      [WinEnum]::EnumWindows($cbu, [IntPtr]::Zero) | Out-Null
    }
    [Console]::Out.WriteLine('{"count":' + $cp.Count + ',"hwnd":' + $script:uacHwnd + '}')
  } else {
    [Console]::Out.WriteLine('err')
  }
}
`;

class TaskWindows {
  constructor({ ownExePath = null } = {}) {
    this.ownExe = ownExePath ? ownExePath.toLowerCase() : null;
    this.ps = null;
    this.buffer = '';
    this.queue = Promise.resolve();   // one command in flight at a time
    this.waiters = [];
  }

  ensure() {
    if (this.ps || process.platform !== 'win32') return;
    this.ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WORKER_SCRIPT], { windowsHide: true });
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
    const die = () => {
      for (const w of this.waiters.splice(0)) w(null);
      this.ps = null;
      this.buffer = '';
    };
    this.ps.on('exit', die);
    this.ps.on('error', die);
    this.ps.stdin.on('error', () => {});      // a dead worker: 'exit' cleans up
  }

  send(command) {
    this.ensure();
    if (!this.ps) return Promise.resolve(null);
    const run = () => new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(null);
      }, QUERY_TIMEOUT_MS);
      const waiter = (line) => { clearTimeout(timer); resolve(line); };
      this.waiters.push(waiter);
      try { this.ps.stdin.write(`${command}\n`); } catch { resolve(null); }
    });
    const next = this.queue.then(run, run);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  // Open top-level windows, the way a task switcher would list them.
  async list() {
    const line = await this.send('list');
    if (!line) return [];
    let rows;
    try {
      rows = JSON.parse(line);
    } catch {
      // A window title smuggled a raw control character through ConvertTo-Json
      // (seen in the wild: the Threads PWA). Blank them and parse again - one
      // odd window must never erase the whole dock.
      try {
        rows = JSON.parse(line.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' '));
      } catch { return []; }
    }
    if (!Array.isArray(rows)) rows = [rows].filter(Boolean);
    return rows
      .filter((r) => r && r.hwnd && r.title)
      // Never list the sidebar itself (or the Spotlight window).
      .filter((r) => !this.ownExe || String(r.exe || '').toLowerCase() !== this.ownExe)
      .map((r) => ({
        hwnd: Number(r.hwnd),
        title: String(r.title).slice(0, 120),
        pid: Number(r.pid) || 0,
        exe: typeof r.exe === 'string' ? r.exe : null,
        aumid: typeof r.aumid === 'string' ? r.aumid.slice(0, 200) : null,
        min: !!r.min,
        fg: !!r.fg
      }));
  }

  // Is the screen saver running? (true / false; null when the helper did not answer)
  async screenSaverRunning() {
    const r = await this.send('saver');
    return r === '1' ? true : r === '0' ? false : null;
  }

  // Push a window to the bottom of the z-order without activating it - how a
  // desktop widget layer behaves: visible on the desktop, behind every app.
  async sendToBottom(hwnd) {
    const h = Number(hwnd);
    if (!Number.isSafeInteger(h) || h <= 0) return false;
    return (await this.send(`bottom ${h}`)) === 'ok';
  }

  // Place a window at EXACT physical pixel bounds. Electron's setBounds works
  // in DIP and mis-converts rects spanning displays with different scale
  // factors; MoveWindow takes the OS's own units and is exact.
  async setPhysicalBounds(hwnd, { x, y, w, h }) {
    const vals = [hwnd, x, y, w, h].map(Number);
    if (vals.some((v) => !Number.isSafeInteger(v))) return false;
    return (await this.send(`setpos ${vals.join(' ')}`)) === 'ok';
  }

  // One of ACTIONS on one window. hwnd is validated numeric.
  async action(name, hwnd) {
    const verb = ACTIONS[name];
    const h = Number(hwnd);
    if (!verb || !Number.isSafeInteger(h) || h <= 0) return false;
    return (await this.send(`${verb} ${h}`)) === 'ok';
  }

  destroy() {
    if (this.ps) { try { this.ps.kill(); } catch { /* gone */ } }
    this.ps = null;
  }
}

module.exports = { TaskWindows, ACTIONS };
