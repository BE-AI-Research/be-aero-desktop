const test = require('node:test');
const assert = require('node:assert');
const { buildDock, clickTarget, togglePinned, isPinned, appNameFromExe } = require('../src/shared/dock');

const win = (exe, title, min = false, hwnd = 1) => ({ hwnd, title, pid: 1, exe, min });
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NOTEPAD = 'C:\\Windows\\notepad.exe';
const EXPLORER = 'C:\\Windows\\Explorer.EXE';

test('appNameFromExe produces names people recognise', () => {
  assert.strictEqual(appNameFromExe(CHROME), 'Chrome');
  assert.strictEqual(appNameFromExe(EXPLORER), 'File Explorer');
  assert.strictEqual(appNameFromExe(NOTEPAD), 'Notepad');
  assert.strictEqual(appNameFromExe('C:\\x\\MyCoolApp.exe'), 'My Cool App');
  assert.strictEqual(appNameFromExe(null), 'App');
});

test('buildDock groups windows by application like a taskbar', () => {
  const tiles = buildDock([
    win(CHROME, 'Tab 1', false, 1),
    win(NOTEPAD, 'notes.txt', false, 2),
    win(CHROME, 'Tab 2', true, 3)
  ], []);
  assert.strictEqual(tiles.length, 2);
  const chrome = tiles.find((t) => t.name === 'Chrome');
  assert.strictEqual(chrome.windows.length, 2);
  assert.ok(chrome.running);
  assert.ok(!chrome.pinned);
});

test('pinned apps come first, running or not', () => {
  const tiles = buildDock(
    [win(CHROME, 'Tab', false, 1)],
    [{ exe: NOTEPAD, name: 'Notepad' }, { exe: CHROME, name: 'Chrome' }]
  );
  assert.deepStrictEqual(tiles.map((t) => [t.name, t.pinned, t.running]), [
    ['Notepad', true, false],      // pinned, not running: still a tile (click launches)
    ['Chrome', true, true],        // pinned and running, with its windows attached
  ]);
  assert.strictEqual(tiles[1].windows.length, 1);
});

test('exe matching is case-insensitive (NTFS)', () => {
  const tiles = buildDock(
    [win('C:\\WINDOWS\\NOTEPAD.EXE', 'a', false, 1)],
    [{ exe: NOTEPAD, name: 'Notepad' }]
  );
  assert.strictEqual(tiles.length, 1);
  assert.ok(tiles[0].running, 'pin and window should merge into one tile');
});

test('clickTarget cycles through an app\u2019s windows on repeated clicks', () => {
  const tile = { windows: [win(CHROME, 'A', false, 1), win(CHROME, 'B', false, 2), win(CHROME, 'C', false, 3)] };
  assert.strictEqual(clickTarget(tile, 0).title, 'A');
  assert.strictEqual(clickTarget(tile, 1).title, 'B');
  assert.strictEqual(clickTarget(tile, 3).title, 'A');   // wraps
  assert.strictEqual(clickTarget({ windows: [] }, 0), null);
  assert.strictEqual(clickTarget(null, 0), null);
});

test('togglePinned pins, unpins, and caps the list', () => {
  let pinned = togglePinned([], CHROME, 'Chrome');
  assert.ok(isPinned(pinned, CHROME));
  assert.ok(isPinned(pinned, CHROME.toUpperCase()), 'case-insensitive');
  pinned = togglePinned(pinned, CHROME);
  assert.ok(!isPinned(pinned, CHROME));
  // cap at 24
  let many = [];
  for (let i = 0; i < 30; i++) many = togglePinned(many, `C:\\apps\\app${i}.exe`);
  assert.ok(many.length <= 24);
  // junk input never throws or mutates
  assert.deepStrictEqual(togglePinned(many, null), many);
});


test('a trampoline pin adopts the Store process with the same base name', () => {
  // Win11: the pin points at the launcher, the real process runs elsewhere.
  const storeNotepad = 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_1\\Notepad\\Notepad.exe';
  const tiles = buildDock(
    [win(storeNotepad, 'notes.txt', false, 9)],
    [{ exe: 'C:/Windows/notepad.exe', name: 'Notepad' }]
  );
  assert.strictEqual(tiles.length, 1, 'pin and process must merge into one tile');
  assert.ok(tiles[0].pinned);
  assert.ok(tiles[0].running);
  assert.strictEqual(tiles[0].windows[0].title, 'notes.txt');
});
