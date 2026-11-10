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
  close: 'close'
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
        exe = $proc.Path; min = [WinEnum]::IsIconic($h)
        fg = ($h -eq [WinEnum]::GetForegroundWindow())
      })
      $true
    }
    [WinEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($list) -Compress))
  } elseif ($cmd -eq 'act' -and $parts.Length -gt 1) {
    $h = [IntPtr][int64]$parts[1]
    if ([WinEnum]::IsIconic($h)) { [WinEnum]::ShowWindowAsync($h, 9) | Out-Null }
    [WinEnum]::SetForegroundWindow($h) | Out-Null
    [Console]::Out.WriteLine('ok')
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
        min: !!r.min,
        fg: !!r.fg
      }));
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
