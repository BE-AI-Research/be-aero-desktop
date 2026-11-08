const test = require('node:test');
const assert = require('node:assert');
const { parseRunEntries, exePathFromData, isOurs, classifyEntry } = require('../src/main/startup');

// Fixture paths use forward slashes converted at the boundary - backslashes
// are built with String.raw to survive every tooling layer.
const BS = (s) => s.replace(/\//g, '\\');

const REG_OUT = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  '    OneDrive    REG_SZ    "C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background',
  '    com.aerowidgets.app    REG_SZ    ' + BS('D:/_Dev/Aero-11/release/win-unpacked/Aero Widgets.exe'),
  '    com.beaero.desktop    REG_SZ    "' + BS('C:/Program Files/BE-Aero Desktop/BE-Aero Desktop.exe') + '"',
  '    Discord    REG_EXPAND_SZ    "C:\\Users\\x\\AppData\\Local\\Discord\\Update.exe" --processStart Discord.exe',
  ''
].join('\r\n');

test('parseRunEntries reads names and data from reg query output', () => {
  const entries = parseRunEntries(REG_OUT);
  assert.strictEqual(entries.length, 4);
  assert.strictEqual(entries[0].name, 'OneDrive');
  assert.strictEqual(entries[3].name, 'Discord'); // REG_EXPAND_SZ parsed too
});

test('exePathFromData handles quoted, bare and argumented values', () => {
  assert.strictEqual(exePathFromData('"C:\\a b\\x.exe" --flag'), 'C:\\a b\\x.exe');
  assert.strictEqual(exePathFromData(BS('D:/dir/Aero Widgets.exe')), BS('D:/dir/Aero Widgets.exe'));
  assert.strictEqual(exePathFromData('"C:\\x\\y.exe"'), 'C:\\x\\y.exe');
});

test('isOurs matches our names and exe names, never other apps', () => {
  const entries = parseRunEntries(REG_OUT);
  assert.ok(!isOurs(entries[0]), 'OneDrive is not ours');
  assert.ok(isOurs(entries[1]), 'old appId entry is ours');
  assert.ok(isOurs(entries[2]), 'current entry is ours');
  assert.ok(!isOurs(entries[3]), 'Discord is not ours');
});

test('classifyEntry keeps only the enabled, current-path entry', () => {
  const execPath = BS('C:/Program Files/BE-Aero Desktop/BE-Aero Desktop.exe');
  const entries = parseRunEntries(REG_OUT);
  const opts = { execPath, enabled: true };
  assert.strictEqual(classifyEntry(entries[0], opts), 'ignore');  // OneDrive untouched
  assert.strictEqual(classifyEntry(entries[1], opts), 'delete');  // stale dev path
  assert.strictEqual(classifyEntry(entries[2], opts), 'keep');    // correct
  assert.strictEqual(classifyEntry(entries[3], opts), 'ignore');  // Discord untouched

  // Setting off: every entry of ours goes, other apps still untouched.
  const off = { execPath, enabled: false };
  assert.strictEqual(classifyEntry(entries[1], off), 'delete');
  assert.strictEqual(classifyEntry(entries[2], off), 'delete');
  assert.strictEqual(classifyEntry(entries[0], off), 'ignore');
});

test('classifyEntry treats a case-differing path as current', () => {
  const entry = { name: 'com.beaero.desktop', data: '"' + BS('c:/program files/be-aero desktop/be-aero desktop.exe') + '"' };
  assert.strictEqual(
    classifyEntry(entry, { execPath: BS('C:/Program Files/BE-Aero Desktop/BE-Aero Desktop.exe'), enabled: true }),
    'keep');
});
