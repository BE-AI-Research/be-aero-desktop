// Builds the searchable index: Start Menu apps, Windows Settings pages and
// files/folders in the user's common locations. Pure Node, no admin rights.
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { indexUwpApps } = require('./uwp');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const PROGRAMDATA = process.env.ProgramData || 'C:\\ProgramData';

const APP_ROOTS = [
  path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  path.join(PROGRAMDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
];

const DEFAULT_FILE_ROOTS = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']
  .map((d) => path.join(HOME, d));

// OneDrive often redirects Desktop/Documents/Pictures.
const ONEDRIVE = process.env.OneDrive || process.env.OneDriveConsumer;
if (ONEDRIVE) {
  for (const d of ['Desktop', 'Documents', 'Pictures']) DEFAULT_FILE_ROOTS.push(path.join(ONEDRIVE, d));
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', 'bin', 'obj',
  '.cache', '.idea', '.vs', '.vscode', 'dist', 'build', 'target', '$recycle.bin', 'appdata'
]);

// Windows Settings deep links (ms-settings:) shown as search results.
const SETTINGS = [
  ['Display settings', 'ms-settings:display'], ['Sound settings', 'ms-settings:sound'],
  ['Bluetooth & devices', 'ms-settings:bluetooth'], ['Wi-Fi settings', 'ms-settings:network-wifi'],
  ['Network & internet', 'ms-settings:network'], ['Personalization', 'ms-settings:personalization'],
  ['Background / wallpaper', 'ms-settings:personalization-background'], ['Colors / dark mode', 'ms-settings:colors'],
  ['Taskbar settings', 'ms-settings:taskbar'], ['Apps & features', 'ms-settings:appsfeatures'],
  ['Default apps', 'ms-settings:defaultapps'], ['Startup apps', 'ms-settings:startupapps'],
  ['Accounts', 'ms-settings:yourinfo'], ['Date & time', 'ms-settings:dateandtime'],
  ['Language & region', 'ms-settings:regionlanguage'], ['Windows Update', 'ms-settings:windowsupdate'],
  ['Privacy & security', 'ms-settings:privacy'], ['Storage settings', 'ms-settings:storagesense'],
  ['Power & battery', 'ms-settings:powersleep'], ['Notifications', 'ms-settings:notifications'],
  ['Mouse settings', 'ms-settings:mousetouchpad'], ['Keyboard / typing', 'ms-settings:typing'],
  ['Printers & scanners', 'ms-settings:printers'], ['About this PC', 'ms-settings:about'],
  ['Focus assist / Do not disturb', 'ms-settings:quiethours'], ['Night light', 'ms-settings:nightlight'],
  ['Multitasking / Snap', 'ms-settings:multitasking'], ['Gaming', 'ms-settings:gaming'],
  ['Accessibility', 'ms-settings:easeofaccess'], ['VPN', 'ms-settings:network-vpn']
].map(([name, uri]) => ({ name, path: uri, kind: 'setting' }));

// Handy shell locations.
const PLACES = [
  ['This PC', 'shell:MyComputerFolder'], ['Recycle Bin', 'shell:RecycleBinFolder'],
  ['Control Panel', 'shell:ControlPanelFolder'], ['Downloads', path.join(HOME, 'Downloads')],
  ['Home folder', HOME]
].map(([name, p]) => ({ name, path: p, kind: 'folder' }));

async function walk(root, { maxDepth, maxEntries, onEntry, filesToo }) {
  let count = 0;
  async function visit(dir, depth) {
    if (count >= maxEntries) return;
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied / missing
    }
    const subdirs = [];
    for (const it of items) {
      if (count >= maxEntries) return;
      if (it.name.startsWith('.') || it.name.toLowerCase() === 'desktop.ini') continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (SKIP_DIRS.has(it.name.toLowerCase())) continue;
        if (filesToo) { onEntry({ name: it.name, path: full, kind: 'folder' }); count++; }
        if (depth < maxDepth) subdirs.push(full);
      } else if (it.isFile() || it.isSymbolicLink()) {
        if (onEntry(null, it.name, full) !== false) count++;
      }
    }
    for (const sd of subdirs) await visit(sd, depth + 1);
  }
  await visit(root, 0);
  return count;
}

const APP_EXTS = new Set(['.lnk', '.url', '.appref-ms', '.exe']);
const APP_NOISE = /^(uninstall|readme|help|license|release notes|documentation|website|support)\b/i;

async function indexApps() {
  const apps = [];
  for (const root of APP_ROOTS) {
    await walk(root, {
      maxDepth: 4, maxEntries: 5000, filesToo: false,
      onEntry: (_e, name, full) => {
        const ext = path.extname(name).toLowerCase();
        if (!APP_EXTS.has(ext)) return false;
        const base = name.slice(0, -ext.length);
        if (APP_NOISE.test(base)) return false;
        apps.push({ name: base, path: full, kind: 'app' });
        return true;
      }
    });
  }
  return apps;
}

async function indexFiles(roots = DEFAULT_FILE_ROOTS, { maxPerRoot = 15000, maxDepth = 5 } = {}) {
  const files = [];
  const seenRoots = new Set();
  for (const root of roots) {
    const key = root.toLowerCase();
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    await walk(root, {
      maxDepth, maxEntries: maxPerRoot, filesToo: true,
      onEntry: (entry, name, full) => {
        if (entry) { files.push(entry); return true; }
        files.push({ name, path: full, kind: 'file' });
        return true;
      }
    });
  }
  return files;
}

// Start Menu shortcuts and AppsFolder apps can describe the same program;
// keep the shortcut (it has a real file path) and drop the duplicate.
function dedupeApps(shortcutApps, uwpApps) {
  const seen = new Set(shortcutApps.map((a) => a.name.trim().toLowerCase()));
  return uwpApps.filter((a) => {
    const key = a.name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildIndex({ extraRoots = [] } = {}) {
  const started = Date.now();
  const [apps, files, uwp] = await Promise.all([
    indexApps(),
    indexFiles([...DEFAULT_FILE_ROOTS, ...extraRoots]),
    indexUwpApps()
  ]);
  const uwpApps = dedupeApps(apps, uwp.entries);
  const entries = [...apps, ...uwpApps, ...SETTINGS, ...PLACES, ...files];
  return {
    entries,
    uwpRoots: uwp.roots,
    stats: {
      apps: apps.length + uwpApps.length,
      uwp: uwpApps.length,
      files: files.length,
      ms: Date.now() - started,
      builtAt: Date.now()
    }
  };
}

module.exports = { buildIndex, indexApps, indexFiles, dedupeApps, walk, SETTINGS, DEFAULT_FILE_ROOTS };
