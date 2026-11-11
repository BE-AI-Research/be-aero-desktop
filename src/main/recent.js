// Recent files and recent apps for the search bar's drop-down.
//
// Files come from the OS's own list: Windows' Recent items (shortcuts in
// %APPDATA%\Microsoft\Windows\Recent, resolved), Linux's
// ~/.local/share/recently-used.xbel. Missing files are skipped.
// Apps: on Windows the shell's UserAssist record of programs run (what
// Start's "recent" draws on), merged with apps opened through BE-Aero
// (search, Spotlight, dock - search.launchHistory); elsewhere the BE-Aero
// history alone.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FILES_MAX = 10;
const APPS_MAX = 8;

// ------------------------------------------------------------ files
function windowsRecentFiles(shell) {
  const dir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Recent');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.lnk')); } catch { return []; }
  const items = [];
  for (const n of names) {
    try { items.push({ lnk: path.join(dir, n), t: fs.statSync(path.join(dir, n)).mtimeMs }); } catch { /* gone */ }
  }
  items.sort((a, b) => b.t - a.t);
  const out = [];
  for (const it of items.slice(0, 60)) {
    let target = '';
    try { target = shell.readShortcutLink(it.lnk).target; } catch { continue; }
    if (!target) continue;
    let st;
    try { st = fs.statSync(target); } catch { continue; }
    if (st.isDirectory()) continue;                 // files only; folders crowd the list
    if (out.some((o) => o.path.toLowerCase() === target.toLowerCase())) continue;
    out.push({ name: path.basename(target), path: target, time: it.t });
    if (out.length >= FILES_MAX) break;
  }
  return out;
}

// recently-used.xbel: <bookmark href="file:///..." modified="..." visited="...">
function parseXbel(text) {
  const out = [];
  const re = /<bookmark\b([^>]*)>/g;
  let m;
  while ((m = re.exec(String(text)))) {
    const attrs = m[1];
    const href = (/href="([^"]+)"/.exec(attrs) || [])[1];
    if (!href || !href.startsWith('file://')) continue;
    const when = (/visited="([^"]+)"/.exec(attrs) || /modified="([^"]+)"/.exec(attrs) || [])[1];
    let p;
    try { p = decodeURIComponent(href.replace(/^file:\/\//, '')); } catch { continue; }
    out.push({ path: p, time: when ? Date.parse(when) || 0 : 0 });
  }
  return out;
}

function linuxRecentFiles() {
  let text = '';
  try { text = fs.readFileSync(path.join(os.homedir(), '.local', 'share', 'recently-used.xbel'), 'utf8'); } catch { return []; }
  const seen = new Set();
  return parseXbel(text)
    .sort((a, b) => b.time - a.time)
    .filter((x) => { if (seen.has(x.path)) return false; seen.add(x.path); try { return fs.statSync(x.path).isFile(); } catch { return false; } })
    .slice(0, FILES_MAX)
    .map((x) => ({ name: path.basename(x.path), path: x.path, time: x.time }));
}

// ------------------------------------------------------------ apps (Windows UserAssist)
const ROT13 = (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= 'Z' ? 65 : 97) + ((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26)));
// Known-folder GUIDs UserAssist uses as path prefixes.
const KNOWN = {
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}': () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  '{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}': () => path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64'),
  '{F38BF404-1D43-42F2-9305-67DE0B28FC23}': () => process.env.SystemRoot || 'C:\\Windows',
  '{6D809377-6AF0-444B-8957-A3773F02200E}': () => process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files',
  '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}': () => process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  '{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}': () => process.env.LOCALAPPDATA || '',
  '{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}': () => process.env.APPDATA || ''
};
function resolveUserAssist(name) {
  const m = /^(\{[0-9A-F-]{36}\})\\(.*)$/i.exec(name);
  if (m && KNOWN[m[1].toUpperCase()]) return path.join(KNOWN[m[1].toUpperCase()](), m[2]);
  return name;
}

function runPs(script, timeout = 8000) {
  return new Promise((resolve) => {
    let out = '';
    // -EncodedCommand: multi-line blocks (foreach { ... }) do not survive
    // being fed line by line through stdin. Nothing secret is in this script.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve(''); }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => { clearTimeout(t); resolve(out); });
    p.on('error', () => { clearTimeout(t); resolve(''); });
    p.stdin.end();
  });
}

const USERASSIST_PS = `
$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}\\Count'
$out = @()
try { $key = Get-Item $k -ErrorAction Stop } catch { '[]'; exit }
foreach ($n in $key.GetValueNames()) {
  $v = $key.GetValue($n)
  if ($v -isnot [byte[]] -or $v.Length -lt 68) { continue }
  $ft = [BitConverter]::ToInt64($v, 60)
  if ($ft -le 0) { continue }
  $out += [pscustomobject]@{ n = $n; t = [DateTimeOffset]::FromFileTime($ft).ToUnixTimeMilliseconds() }
}
$out | Sort-Object t -Descending | Select-Object -First 40 | ConvertTo-Json -Compress
`;

async function windowsRecentApps() {
  const raw = await runPs(USERASSIST_PS);
  let rows = [];
  try { rows = JSON.parse(raw || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [rows];
  const out = [];
  for (const r of rows) {
    const name = ROT13(String(r.n || ''));
    if (/^UEME_|Microsoft\.Windows\.(Explorer|ShellExperienceHost)|^::\{/i.test(name)) continue;
    const target = resolveUserAssist(name);
    if (/\.exe$/i.test(target)) {
      if (!fs.existsSync(target)) continue;
      if (/\\(rundll32|explorer|cmd|conhost|dllhost|SearchHost|consent|pwahelper|msedgewebview2|backgroundTaskHost)\.exe$/i.test(target)) continue;
      if (/\\WindowsApps\\/i.test(target)) continue;                 // the Store entry (AUMID) covers it
      out.push({ path: target, time: Number(r.t) || 0, kind: 'exe' });
    } else if (target.includes('!')) {
      out.push({ path: `shell:AppsFolder\\${target}`, aumid: target, time: Number(r.t) || 0, kind: 'store' });   // a Store app (AUMID)
    }
  }
  return out;
}

// ------------------------------------------------------------ service
class RecentService {
  // { store, shell, indexEntries() -> spotlight entries }
  constructor({ store, shell, indexEntries }) {
    this.store = store;
    this.shell = shell;
    this.indexEntries = indexEntries || (() => []);
  }

  files() {
    if (process.platform === 'win32') return windowsRecentFiles(this.shell);
    if (process.platform === 'linux') return linuxRecentFiles();
    return [];
  }

  // exe path -> the Start-menu name, from the index's shortcuts (resolved
  // once per index; Windows only).
  exeNames(entries) {
    if (this.exeMap && this.exeMapFor === entries) return this.exeMap;
    const map = new Map();
    if (process.platform === 'win32' && this.shell && this.shell.readShortcutLink) {
      for (const e of entries) {
        if (e.kind !== 'app' || !/\.lnk$/i.test(String(e.path))) continue;
        try { const t = this.shell.readShortcutLink(e.path).target; if (t && !map.has(t.toLowerCase())) map.set(t.toLowerCase(), e.name); } catch { /* broken shortcut */ }
      }
    }
    this.exeMap = map;
    this.exeMapFor = entries;
    return map;
  }

  // A display name for an app path: the search index's name when it knows
  // the app, else the file name.
  nameFor(p, entries) {
    const lower = p.toLowerCase();
    const hit = entries.find((e) => e.kind === 'app' && String(e.path).toLowerCase() === lower);
    if (hit) return hit.name;
    const viaLnk = this.exeNames(entries).get(lower);
    if (viaLnk) return viaLnk;
    const aumid = /^shell:AppsFolder\\(.+)$/i.exec(p);
    if (aumid) {
      const byId = entries.find((e) => e.kind === 'app' && String(e.path).toLowerCase().includes(aumid[1].toLowerCase()));
      if (byId) return byId.name;
      // An unindexed package: its id, tidied - "www.threads.com-865DBF95_91be…"
      // (an Edge web app) -> "threads.com", "Microsoft.WindowsNotepad_8wek…" -> "WindowsNotepad".
      const id = aumid[1].split('!')[0].replace(/_.*$/, '');
      if (/-[0-9A-F]{8}$/i.test(id)) return id.replace(/-[0-9A-F]{8}$/i, '').replace(/^www\./i, '');
      return id.replace(/^[^.]+\./, '');
    }
    return path.basename(p).replace(/\.(exe|lnk|desktop)$/i, '');
  }

  async apps() {
    const entries = this.indexEntries() || [];
    const hist = ((this.store.get('search') || {}).launchHistory) || [];
    const list = (Array.isArray(hist) ? hist : []).map((h) => ({ path: h.p, time: h.t, kind: 'aero' }));
    if (process.platform === 'win32') list.push(...await windowsRecentApps());
    list.sort((a, b) => b.time - a.time);
    const seen = new Set();
    const out = [];
    for (const a of list) {
      const name = this.nameFor(a.path, entries);
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, path: a.path, time: a.time });
      if (out.length >= APPS_MAX) break;
    }
    return out;
  }

  async recent() {
    const [files, apps] = await Promise.all([Promise.resolve().then(() => this.files()), this.apps()]);
    return { files, apps };
  }
}

// Remember a launch made through BE-Aero (the newest 100). An array, not
// an object: the settings store deep-merges objects, so keys could never
// be dropped, while arrays are replaced whole.
function recordLaunch(store, p) {
  if (!p) return;
  const s = store.get('search') || {};
  const prev = Array.isArray(s.launchHistory) ? s.launchHistory : [];
  const next = [{ p, t: Date.now() }, ...prev.filter((h) => h && h.p !== p)].slice(0, 100);
  store.set({ search: { launchHistory: next } });
}

module.exports = { RecentService, recordLaunch, parseXbel, resolveUserAssist, ROT13 };
