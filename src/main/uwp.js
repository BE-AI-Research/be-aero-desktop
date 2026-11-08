// UWP / AppX / PWA apps for the search index.
//
// These never appear in the Start Menu's .lnk tree, so the file indexer cannot
// see them: Calculator, Photos, Terminal, Store apps and browser-installed PWAs
// all live in the AppsFolder shell namespace instead. Windows exposes them
// through Get-StartApps (resolved display names + AppUserModelIDs), and their
// icons come from each package's AppxManifest.
//
// Everything here works as a normal user: C:\Program Files\WindowsApps cannot be
// listed, but an individual package folder can be read once its exact path is
// known, and the registry hands us those paths.
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const PACKAGE_REPO =
  'HKCU:\\SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';

// One PowerShell round trip for both halves: the app list and the package roots
// its icons live under.
const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$apps = @(Get-StartApps | Select-Object Name, AppID)
$pkgs = @(Get-ChildItem '${PACKAGE_REPO}' | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  if ($p.PackageRootFolder) { [PSCustomObject]@{ id = $_.PSChildName; root = $p.PackageRootFolder } }
})
[PSCustomObject]@{ apps = $apps; packages = $pkgs } | ConvertTo-Json -Depth 4 -Compress
`;

const PS_TIMEOUT_MS = 20000;

// A package id is Name_Version_Arch__PublisherHash; an AppUserModelID is keyed
// by the family, Name_PublisherHash.
function familyOf(packageId) {
  const parts = String(packageId).split('_');
  if (parts.length < 2) return String(packageId);
  return `${parts[0]}_${parts[parts.length - 1]}`;
}

// Square44x44Logo for a specific Application id, falling back to the first one
// in the manifest (most packages ship exactly one app).
function logoFromManifest(xml, appId) {
  const escaped = String(appId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`<Application\\b[^>]*\\bId="${escaped}"[\\s\\S]*?(?:</Application>|/>)`, 'i').exec(xml);
  const scope = block ? block[0] : xml;
  const m = /Square44x44Logo="([^"]+)"/i.exec(scope) || /Square44x44Logo="([^"]+)"/i.exec(xml);
  return m ? m[1] : null;
}

// Windows ships one logo as many pre-scaled files. Pick the crispest ~48px
// variant and skip the high-contrast ones meant for accessibility themes.
function pickIconAsset(files, baseName) {
  const base = String(baseName).toLowerCase();
  const rank = (f) => {
    const s = f.toLowerCase();
    if (s.includes('targetsize-48_altform-unplated')) return 0;
    if (s.includes('targetsize-48')) return 1;
    if (s.includes('targetsize-44')) return 2;
    if (s.includes('targetsize-32')) return 3;
    if (s.includes('scale-200')) return 4;
    if (s.includes('scale-100')) return 5;
    return 9;
  };
  const candidates = files
    .filter((f) => f.toLowerCase().startsWith(base)
      && /\.png$/i.test(f)
      && !/contrast-(black|white)/i.test(f))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length);
  return candidates[0] || null;
}

// Ask Windows for the Start apps and the package roots. Resolves to empty on
// any failure so a locked-down machine just means no UWP results.
function queryWindows() {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: PS_TIMEOUT_MS },
      (err, stdout) => {
        if (err) { resolve({ apps: [], packages: [] }); return; }
        try {
          const data = JSON.parse(stdout);
          resolve({
            apps: Array.isArray(data.apps) ? data.apps : [data.apps].filter(Boolean),
            packages: Array.isArray(data.packages) ? data.packages : [data.packages].filter(Boolean)
          });
        } catch { resolve({ apps: [], packages: [] }); }
      });
  });
}

// Index entries for every AppsFolder app, plus the family -> package root map
// the icon lookup needs later.
async function indexUwpApps() {
  if (process.platform !== 'win32') return { entries: [], roots: {} };
  const { apps, packages } = await queryWindows();

  const roots = {};
  for (const p of packages) {
    if (p && p.id && p.root) roots[familyOf(p.id).toLowerCase()] = p.root;
  }

  const entries = [];
  for (const a of apps) {
    // An AppUserModelID always contains "!"; plain paths are desktop shortcuts
    // the file indexer already covers.
    if (!a || !a.AppID || !a.AppID.includes('!') || !a.Name) continue;
    entries.push({
      name: a.Name,
      path: `shell:AppsFolder\\${a.AppID}`,
      kind: 'app',
      aumid: a.AppID
    });
  }
  return { entries, roots };
}

// Read a UWP app's icon as a data URL, or null when it cannot be resolved.
async function uwpIcon(aumid, roots) {
  if (!aumid || !aumid.includes('!')) return null;
  const [family, appId] = [aumid.slice(0, aumid.indexOf('!')), aumid.slice(aumid.indexOf('!') + 1)];
  const root = roots[family.toLowerCase()];
  if (!root) return null;

  let xml;
  try { xml = await fs.readFile(path.join(root, 'AppxManifest.xml'), 'utf8'); } catch { return null; }
  const logo = logoFromManifest(xml, appId);
  if (!logo) return null;

  const logoAbs = path.join(root, logo.replace(/\//g, '\\'));
  const dir = path.dirname(logoAbs);
  const base = path.basename(logoAbs, path.extname(logoAbs));
  let files;
  try { files = await fs.readdir(dir); } catch { return null; }
  const pick = pickIconAsset(files, base);
  if (!pick) return null;

  try {
    const buf = await fs.readFile(path.join(dir, pick));
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch { return null; }
}

module.exports = { indexUwpApps, uwpIcon, familyOf, logoFromManifest, pickIconAsset };
