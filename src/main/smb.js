// Network drives (SMB) for the file browser, through each OS's own SMB
// support - nothing is bundled:
//   Windows: UNC paths (\\server\share) work with fs directly; connecting
//     uses New-SmbMapping (optionally to a drive letter; "remember" saves the
//     password in Windows Credential Manager); shares are listed with
//     `net view \\server`.
//   Linux:   GNOME's gvfs - `gio mount smb://server/share` as the user (no
//     root); mounted shares appear under /run/user/<uid>/gvfs/.
// Passwords travel to those tools on stdin, never on a command line (where
// other processes could read them), and BE-Aero does not store them.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

// "\\server\share\dir", "//server/share", "smb://user@server/share/dir"
// -> { server, share, rest } (share and rest may be '').
function parseAddress(input) {
  const s = String(input || '').trim();
  let m = /^smb:\/\/(?:[^@/]+@)?([^/]+)(?:\/([^/]*))?(?:\/(.*))?$/i.exec(s);
  if (!m) m = /^(?:\\\\|\/\/)([^\\/]+)(?:[\\/]([^\\/]*))?(?:[\\/](.*))?$/.exec(s);
  if (!m) return null;
  return { server: m[1], share: m[2] || '', rest: (m[3] || '').replace(/[\\/]+$/, '') };
}

const isNetworkAddress = (s) => !!parseAddress(s);

// Run a program; `input` goes to stdin (credentials). -> { code, stdout, stderr }
function run(cmd, args, { input = null, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const p = spawn(cmd, args, { windowsHide: true, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
    const t = setTimeout(() => { if (!done) { try { p.kill(); } catch { /* gone */ } resolve({ code: -1, stdout: out, stderr: `${err}\ntimed out` }); done = true; } }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, stdout: out, stderr: e.message }); } });
    p.on('close', (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, stdout: out, stderr: err }); } });
    if (input !== null) { p.stdin.write(input); }
    p.stdin.end();
  });
}

// A PowerShell script run from stdin, so nothing sensitive is in argv.
function ps(script, timeout) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { input: script, timeout });
}
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;     // PowerShell single-quoted string

// `net view \\server` output -> share names (Disk shares only).
function parseNetView(text) {
  const shares = [];
  let inTable = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^-{5,}/.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (/^The command completed|^$/.test(line.trim())) continue;
    const m = /^(.+?)\s{2,}(Disk|Print|IPC)\b/i.exec(line);
    if (m && /^disk$/i.test(m[2])) shares.push(m[1].trim());
  }
  return shares;
}

// `gio mount -l` -> [{ server, share, uri }]
function parseGioMounts(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /->\s*(smb:\/\/[^\s]+)/i.exec(line);
    if (!m) continue;
    const a = parseAddress(m[1]);
    if (a && a.share) out.push({ server: a.server, share: a.share, uri: m[1].replace(/\/+$/, '') });
  }
  return out;
}

// Where gvfs exposes a mounted share.
function gvfsPath(server, share) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  return path.join(`/run/user/${uid}/gvfs`, `smb-share:server=${server.toLowerCase()},share=${share.toLowerCase()}`);
}

class SmbService {
  // Connected network shares: [{ name, path, remote, status, letter? }]
  async connections() {
    if (process.platform === 'win32') {
      const r = await ps('Get-SmbMapping | Select-Object LocalPath, RemotePath, Status | ConvertTo-Json -Compress', 15000);
      let rows = [];
      try { rows = JSON.parse(r.stdout || '[]'); } catch { rows = []; }
      if (!Array.isArray(rows)) rows = [rows];
      return rows.filter((x) => x && x.RemotePath).map((x) => {
        const a = parseAddress(x.RemotePath) || {};
        const status = { 0: 'OK', 1: 'Paused', 2: 'Disconnected', 3: 'Network error', 4: 'Connecting', 5: 'Reconnecting', 6: 'Unavailable' }[x.Status] || String(x.Status);
        return { name: `${a.share || x.RemotePath} on ${a.server || '?'}`, letter: x.LocalPath || '', path: x.LocalPath ? `${x.LocalPath}\\` : x.RemotePath, remote: x.RemotePath, status };
      });
    }
    if (process.platform === 'linux') {
      const r = await run('gio', ['mount', '-l'], { timeout: 10000 });
      return parseGioMounts(r.stdout).map((m) => ({ name: `${m.share} on ${m.server}`, path: gvfsPath(m.server, m.share), remote: m.uri, status: 'OK' }));
    }
    return [];
  }

  // Shares a server offers.
  async shares(server) {
    if (process.platform === 'win32') {
      const r = await run('net', ['view', `\\\\${server}`], { timeout: 20000 });
      if (r.code !== 0) throw new Error(/System error 5|Access is denied/i.test(r.stdout + r.stderr) ? 'needs sign-in' : /53|not found|network path/i.test(r.stdout + r.stderr) ? `"${server}" was not found on the network.` : (r.stderr || r.stdout).trim().split('\n').pop());
      return parseNetView(r.stdout);
    }
    if (process.platform === 'linux') {
      const r = await run('gio', ['list', `smb://${server}/`], { timeout: 20000 });
      if (r.code !== 0) throw new Error(/not mounted|location is not mounted/i.test(r.stderr) ? 'needs sign-in' : r.stderr.trim() || 'could not list that server');
      return r.stdout.split('\n').map((x) => x.trim()).filter((x) => x && !x.endsWith('$'));
    }
    return [];
  }

  // Connect a share. { address, user, password, domain, letter, remember }
  async connect({ address, user = '', password = '', domain = '', letter = '', remember = false }) {
    const a = parseAddress(address);
    if (!a || !a.share) throw new Error('Enter a share, for example \\\\server\\share or smb://server/share');
    if (process.platform === 'win32') {
      const remote = `\\\\${a.server}\\${a.share}`;
      const lines = [`$ErrorActionPreference = 'Stop'`, `$p = @{ RemotePath = ${psq(remote)} }`];
      if (/^[d-z]$/i.test(String(letter).replace(':', ''))) lines.push(`$p.LocalPath = ${psq(`${String(letter).replace(':', '').toUpperCase()}:`)}`);
      if (user) {
        lines.push(`$p.UserName = ${psq(domain ? `${domain}\\${user}` : user)}`);
        lines.push(`$p.Password = ${psq(password)}`);
      }
      if (remember) { lines.push('$p.Persistent = $true'); if (user) lines.push('$p.SaveCredentials = $true'); }
      lines.push('try { New-SmbMapping @p | Out-Null; "OK" } catch { "ERR " + $_.Exception.Message }');
      const r = await ps(lines.join('\n'), 45000);
      const out = (r.stdout || '').trim();
      if (!out.endsWith('OK')) throw new Error(friendly(out.replace(/^ERR\s*/, '') || r.stderr));
      const local = (lines.find((l) => l.startsWith('$p.LocalPath')) || '').match(/'([A-Z]:)'/);
      return { path: local ? `${local[1]}\\` : `${remote}${a.rest ? `\\${a.rest.replace(/\//g, '\\')}` : ''}` };
    }
    if (process.platform === 'linux') {
      const uri = `smb://${a.server}/${a.share}`;
      // gio prompts: User, Domain, Password (one line each) when asked.
      const input = user ? `${user}\n${domain}\n${password}\n` : '\n\n\n';
      const args = user ? ['mount', uri] : ['mount', '-a', uri];      // -a: anonymous
      const r = await run('gio', args, { input, timeout: 45000 });
      if (r.code !== 0 && !/already mounted/i.test(r.stderr)) throw new Error(friendly(r.stderr));
      return { path: path.join(gvfsPath(a.server, a.share), a.rest || '') };
    }
    throw new Error('Network drives are not supported on this system.');
  }

  async disconnect(remoteOrLetter) {
    const target = String(remoteOrLetter || '');
    if (process.platform === 'win32') {
      const byLetter = /^[A-Z]:\\?$/i.test(target);
      const r = await ps(`$ErrorActionPreference = 'Stop'\ntry { Remove-SmbMapping ${byLetter ? `-LocalPath ${psq(target.slice(0, 2))}` : `-RemotePath ${psq(target)}`} -Force -UpdateProfile; "OK" } catch { "ERR " + $_.Exception.Message }`, 20000);
      if (!(r.stdout || '').trim().endsWith('OK')) throw new Error(friendly((r.stdout || '').replace(/^ERR\s*/, '') || r.stderr));
      return true;
    }
    if (process.platform === 'linux') {
      const r = await run('gio', ['mount', '-u', target], { timeout: 20000 });
      if (r.code !== 0) throw new Error(friendly(r.stderr));
      return true;
    }
    return false;
  }

  // Drive letters free for a new mapping (Windows), Z down to D.
  async freeLetters() {
    if (process.platform !== 'win32') return [];
    const fs = require('fs');
    const out = [];
    for (let c = 90; c >= 68; c--) {
      const L = String.fromCharCode(c);
      if (!fs.existsSync(`${L}:\\`)) out.push(L);
    }
    const taken = new Set((await this.connections()).map((x) => (x.letter || '').charAt(0)));
    return out.filter((L) => !taken.has(L));
  }
}

function friendly(msg) {
  const m = String(msg || '').trim();
  if (/1326|logon failure|password is incorrect|unknown user name|permission denied|Failed to mount.*Permission/i.test(m)) return 'The user name or password was not accepted.';
  if (/53|network path was not found|No such file or directory|Failed to resolve|could not resolve/i.test(m)) return 'That server or share was not found on the network.';
  if (/1219|multiple connections/i.test(m)) return 'Windows is already connected to that server as a different user. Disconnect the other connection first.';
  if (/85|local device name is already in use/i.test(m)) return 'That drive letter is already in use.';
  return m.split('\n').filter(Boolean).pop() || 'Could not connect.';
}

module.exports = { SmbService, parseAddress, isNetworkAddress, parseNetView, parseGioMounts, gvfsPath, friendly };
