// Who is on the other end of a loopback socket?
//
// Windows knows which process owns every TCP connection, so for a request to
// the local API we can resolve the caller's executable: netstat maps our
// (localPort, remotePort) pair to a PID, and a persistent PowerShell worker
// maps the PID to its image path. That path is what app identity binds to -
// a token stolen from one program is useless in the hands of another binary.
//
// Results are cached per socket: a TCP connection belongs to one process for
// its whole life, so each keep-alive connection pays the cost once (~35ms).
const { spawn, execFile } = require('child_process');

const NETSTAT_TIMEOUT_MS = 5000;
const WORKER_QUERY_TIMEOUT_MS = 4000;

// ------------------------------------------------------------------ netstat
// (localPort, remotePort) -> owning PID of the remote end, or null.
function pidForConnection(localPort, remotePort) {
  return new Promise((resolve) => {
    execFile('netstat.exe', ['-ano', '-p', 'TCP'],
      { windowsHide: true, timeout: NETSTAT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        // The remote end of our connection appears as its own row: local
        // address = their port, remote address = our port.
        for (const line of String(stdout).split('\n')) {
          const m = /^\s*TCP\s+\S+:(\d+)\s+\S+:(\d+)\s+ESTABLISHED\s+(\d+)/.exec(line);
          if (m && Number(m[1]) === remotePort && Number(m[2]) === localPort) {
            resolve(Number(m[3]));
            return;
          }
        }
        resolve(null);
      });
  });
}

// ------------------------------------------------------- pid -> path worker
// One long-lived PowerShell answering "pid\n" with "pid|startMs|path\n".
// Spawning PowerShell per query costs ~1s; the warm worker answers in ~5ms.
class PidResolver {
  constructor() {
    this.ps = null;
    this.buffer = '';
    this.waiters = [];
  }

  ensure() {
    if (this.ps || process.platform !== 'win32') return;
    this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='SilentlyContinue'
# UTF-8 stdout, or the console codepage's best-fit mapping mangles Unicode on
# the way out: a bullet (U+2022) in a window title becomes byte 0x07 - a raw
# control character inside what is supposed to be JSON.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -match '^pid (\\d+)$') {
    $p = Get-Process -Id ([int]$Matches[1])
    if ($p -and $p.Path) {
      $start = [long]($p.StartTime.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds
      [Console]::Out.WriteLine(('ok|{0}|{1}' -f $start, $p.Path))
    } else { [Console]::Out.WriteLine('miss||') }
  } else {
    [Console]::Out.WriteLine('err||')
  }
}
`], { windowsHide: true });

    this.ps.stdout.on('data', (d) => {
      this.buffer += d;
      let i;
      while ((i = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w.resolve(line);
      }
    });
    // On crash, fail every pending query and start fresh next time.
    const die = () => {
      const pending = this.waiters.splice(0);
      for (const w of pending) w.resolve(null);
      this.ps = null;
      this.buffer = '';
    };
    this.ps.on('exit', die);
    this.ps.on('error', die);
    this.ps.stdin.on('error', () => {});      // a dead worker: 'exit' cleans up
  }

  // -> { pid, startMs, path } or null.
  query(pid) {
    this.ensure();
    if (!this.ps) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = { resolve: (line) => { clearTimeout(timer); resolve(parse(line)); } };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(null);
      }, WORKER_QUERY_TIMEOUT_MS);
      const parse = (line) => {
        if (!line) return null;
        const [status, startMs, ...rest] = line.split('|');
        const path = rest.join('|');
        if (status !== 'ok' || !path) return null;
        return { pid, startMs: Number(startMs) || null, path };
      };
      this.waiters.push(waiter);
      try { this.ps.stdin.write(`pid ${pid}\n`); } catch { resolve(null); }
    });
  }

  // Send any worker command and get the raw "status|a|b" line.
  raw(command) {
    this.ensure();
    if (!this.ps) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = { resolve: (line) => { clearTimeout(timer); resolve(line || null); } };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(null);
      }, 15000);   // hashing a large binary takes a moment
      this.waiters.push(waiter);
      try { this.ps.stdin.write(`${command}\n`); } catch { resolve(null); }
    });
  }

  destroy() {
    if (this.ps) { try { this.ps.kill(); } catch { /* already gone */ } }
    this.ps = null;
  }
}

// ------------------------------------------------------------ the public API
class PeerResolver {
  constructor() {
    this.pids = new PidResolver();
    this.binaries = new Map();   // exe path -> { stamp, value } identity cache
    // socket -> Promise<identity|null>; one resolution per connection, and
    // concurrent requests on the same socket share the same lookup.
    this.bySocket = new WeakMap();
  }

  // Identity of the process behind an incoming request: { pid, path, startMs }
  // or null when it cannot be established.
  identify(req) {
    const socket = req && req.socket;
    if (!socket || !socket.remotePort || !socket.localPort) return Promise.resolve(null);
    let promise = this.bySocket.get(socket);
    if (!promise) {
      promise = (async () => {
        const pid = await pidForConnection(socket.localPort, socket.remotePort);
        if (!pid) return null;
        return this.pids.query(pid);
      })();
      this.bySocket.set(socket, promise);
    }
    return promise;
  }

  // What a binary IS, beyond its path: its Authenticode signer when validly
  // signed, its SHA-256 otherwise. Cached by (path, mtime, size), so a
  // request only pays for verification when the file on disk actually
  // changed - which is exactly the event the binding needs to notice.
  //
  // Windows PowerShell 5.1 cannot load its Security module on machines whose
  // PSModulePath was contaminated by PS7 (this one - recorded quirk), so the
  // signature check runs in pwsh when present and the hash uses certutil,
  // which always exists.
  async describeBinary(exePath) {
    if (typeof exePath !== 'string' || !exePath) return null;
    let stat;
    try { stat = require('fs').statSync(exePath); } catch { return null; }
    const cacheKey = exePath.toLowerCase();
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const hit = this.binaries.get(cacheKey);
    if (hit && hit.stamp === stamp) return hit.value;

    let value = null;
    const sig = await signatureOf(exePath);
    if (sig) {
      value = { signed: true, thumbprint: sig.thumbprint, subject: sig.subject };
    } else {
      const sha256 = await sha256Of(exePath);
      if (sha256) value = { signed: false, sha256 };
    }
    if (value) {
      if (this.binaries.size > 64) this.binaries.clear();
      this.binaries.set(cacheKey, { stamp, value });
    }
    return value;
  }

  destroy() {
    this.pids.destroy();
  }
}

// Authenticode check in pwsh (PowerShell 7): returns { thumbprint, subject }
// only for a VALID signature, null otherwise or when pwsh is unavailable.
function signatureOf(exePath) {
  return new Promise((resolve) => {
    // -Command does not populate $args (that is -File behaviour), so the
    // path is embedded, single-quoted with PowerShell's '' escaping.
    const quoted = String(exePath).replace(/'/g, "''");
    const script = `$s = Get-AuthenticodeSignature -LiteralPath '${quoted}'; `
      + `if ($s.Status -eq 'Valid' -and $s.SignerCertificate) { `
      + `[Console]::Out.WriteLine($s.SignerCertificate.Thumbprint + '|' + ($s.SignerCertificate.Subject -replace '[|]', ' ')) }`;
    execFile('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        const line = String(stdout || '').trim();
        if (err || !line) { resolve(null); return; }
        const i = line.indexOf('|');
        resolve(i > 0 ? { thumbprint: line.slice(0, i), subject: line.slice(i + 1).slice(0, 200) } : null);
      });
  });
}

// SHA-256 via certutil: present on every Windows, immune to the module mess.
function sha256Of(exePath) {
  return new Promise((resolve) => {
    execFile('certutil.exe', ['-hashfile', exePath, 'SHA256'],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const m = /^[0-9a-f]{64}$/im.exec(String(stdout || ''));
        resolve(m ? m[0].toLowerCase() : null);
      });
  });
}

// Case-insensitive path equality: NTFS paths differ only by spelling.
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

module.exports = { PeerResolver, PidResolver, pidForConnection, samePath };
