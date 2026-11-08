// Launch-at-startup registration, Windows.
//
// The naive approach - register once when the user flips the toggle - rots:
// the exe moves (dev build -> installed build, renames, reinstalls to another
// drive) and the old HKCU Run entry keeps pointing at a path that no longer
// exists, so nothing starts and the toggle still looks "on". This module
// reconciles instead: every boot it re-asserts the correct entry when the
// setting is enabled and deletes every entry of ours that is stale - wrong
// path, dead path, or an old identity ("com.aerowidgets.app", the pre-rename
// AppUserModelID, which is exactly the corpse found on the dev machine).
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

// Registry value names this app has ever written under, plus the exe file
// names it has ever shipped as. Anything else in the Run key is not ours and
// is never touched.
const OUR_NAMES = /^(com\.aerowidgets\.app|com\.beaero\.desktop|be-aero desktop|aero widgets)$/i;
const OUR_EXES = /\\(aero widgets|be-aero desktop)\.exe"?$/i;

// `reg query HKCU\...\Run` output -> [{ name, data }]. Lines look like:
//     ValueName    REG_SZ    "C:\path\app.exe" --args
function parseRunEntries(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
    if (m) out.push({ name: m[1].trim(), data: m[2].trim() });
  }
  return out;
}

// The exe path inside a Run value's data (quoted or bare, args ignored).
function exePathFromData(data) {
  const quoted = /^"([^"]+)"/.exec(String(data || '').trim());
  if (quoted) return quoted[1];
  const bare = /^(.*?\.exe)(\s|$)/i.exec(String(data || '').trim());
  return bare ? bare[1] : String(data || '').trim();
}

// Does this Run entry belong to this app (any era of it)?
function isOurs(entry) {
  return OUR_NAMES.test(entry.name) || OUR_EXES.test(exePathFromData(entry.data));
}

// Decide what to do with one of our entries. 'keep' only when startup is
// enabled and the entry points at the exe that is actually running now.
function classifyEntry(entry, { execPath, enabled }) {
  if (!isOurs(entry)) return 'ignore';
  if (!enabled) return 'delete';
  const same = exePathFromData(entry.data).toLowerCase() === String(execPath || '').toLowerCase();
  return same ? 'keep' : 'delete';
}

// Linux: the XDG autostart convention - a .desktop file under
// ~/.config/autostart. Rewritten (not just created) every boot so a moved
// install heals itself the same way the Windows entry does.
function linuxDesktopEntry(execPath) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=BE-Aero Desktop',
    'Comment=Desktop widget sidebar: clock, weather, telemetry, dock, web widgets',
    // The Ozone platform must be chosen on the command line: under a
    // Wayland session the app is unusable as a native Wayland client.
    `Exec="${execPath}" --ozone-platform=x11`,
    'Icon=be-aero-desktop',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n');
}

function reconcileLinuxAutostart({ app, store, fs: fsImpl, home }) {
  const fs = fsImpl || require('fs');
  const path = require('path');
  const dir = path.join(home || require('os').homedir(), '.config', 'autostart');
  const file = path.join(dir, 'be-aero-desktop.desktop');
  try {
    if (store.get('launchAtStartup')) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, linuxDesktopEntry(process.execPath), 'utf8');
    } else {
      fs.rmSync(file, { force: true });
    }
  } catch (err) {
    console.warn('autostart entry failed:', err.message);
  }
}

// Full reconcile. Electron's setLoginItemSettings writes/removes its own
// value; the sweep afterwards catches every entry it would not know about.
function reconcileStartupRegistration({ app, store, exec }) {
  if (!app.isPackaged) return; // dev would register electron.exe
  if (process.platform === 'linux') return reconcileLinuxAutostart({ app, store });
  if (process.platform !== 'win32') return;
  const enabled = !!store.get('launchAtStartup');
  const run = exec || require('child_process').exec;

  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });

  run(`reg query "${RUN_KEY}"`, { windowsHide: true }, (err, stdout) => {
    if (err) return; // no Run key / no access: nothing to clean
    for (const entry of parseRunEntries(stdout)) {
      if (classifyEntry(entry, { execPath: process.execPath, enabled }) === 'delete') {
        run(`reg delete "${RUN_KEY}" /v "${entry.name.replace(/"/g, '')}" /f`,
          { windowsHide: true }, () => {});
      }
    }
  });
}

module.exports = {
  parseRunEntries, exePathFromData, isOurs, classifyEntry,
  linuxDesktopEntry, reconcileLinuxAutostart, reconcileStartupRegistration, RUN_KEY
};
