// Chrome / Edge web apps on the dock: a window's shortened app id finds the
// app's Start Menu shortcut; the browser install the window runs in wins.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { PwaShortcuts, keyOfWindow, keyOfApp } = require('../src/main/pwa');

const GITHUB = 'mjoklplbddabcmpepnokjaffbmgbkkgg';

test('a window id (first 10 + last 16 letters) and the full app id share a key', () => {
  assert.strictEqual(keyOfWindow('Chrome._crx_mjoklplbddpnokjaffbmgbkkgg'), keyOfApp(GITHUB));
  assert.strictEqual(keyOfWindow('Chrome._crx_mjoklplbddpnokjaffbmgbkkgg.UserData.Profile1'), keyOfApp(GITHUB));
  assert.strictEqual(keyOfWindow('Chrome'), null);
  assert.strictEqual(keyOfWindow('Microsoft.WindowsTerminal_8wekyb3d8bbwe!App'), null);
});

test('the shortcut for the same browser install, with the plain name, is chosen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-pwa-'));
  const chrome = path.join(dir, 'Chrome Apps'); const chromium = path.join(dir, 'Chromium Apps');
  fs.mkdirSync(chrome); fs.mkdirSync(chromium);
  const links = {
    [path.join(chromium, 'GitHub.lnk')]: { target: 'C:\\Chromium\\Application\\chrome_proxy.exe', args: `--profile-directory=Default --app-id=${GITHUB}` },
    [path.join(chrome, 'GitHub (1).lnk')]: { target: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome_proxy.exe', args: `--app-id=${GITHUB}` },
    [path.join(chrome, 'GitHub.lnk')]: { target: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome_proxy.exe', args: `--profile-directory=Default --app-id=${GITHUB}`, icon: 'x.ico' },
    [path.join(chrome, 'Notes.lnk')]: { target: 'C:\\Windows\\notepad.exe', args: '' }
  };
  for (const p of Object.keys(links)) fs.writeFileSync(p, '');
  const p = new PwaShortcuts({ readShortcut: (f) => links[f], dirs: [dir] });
  p.scan();
  const app = p.lookup('Chrome._crx_mjoklplbddpnokjaffbmgbkkgg', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.strictEqual(app.lnk, path.join(chrome, 'GitHub.lnk'));
  assert.strictEqual(app.name, 'GitHub');
  assert.strictEqual(p.lookup('Chrome._crx_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'chrome.exe'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
