const test = require('node:test');
const assert = require('node:assert');
const { parseXbel, resolveUserAssist, ROT13, recordLaunch, RecentService } = require('../src/main/recent');

test('recent: Linux recently-used.xbel is read newest-visit first', () => {
  const xbel = '<?xml version="1.0"?><xbel><bookmark href="file:///home/s/a%20b.txt" added="2026-11-01T10:00:00Z" modified="2026-11-02T10:00:00Z" visited="2026-11-03T10:00:00Z"></bookmark><bookmark href="https://example.com" modified="2026-11-05T00:00:00Z"></bookmark><bookmark href="file:///home/s/c.pdf" modified="2026-11-04T09:00:00Z"></bookmark></xbel>';
  const rows = parseXbel(xbel);
  assert.deepStrictEqual(rows.map((r) => r.path), ['/home/s/a b.txt', '/home/s/c.pdf'], 'files only, decoded');
  assert.strictEqual(rows[0].time, Date.parse('2026-11-03T10:00:00Z'), 'visited wins over modified');
});

test('recent: UserAssist names (ROT13, known-folder GUIDs)', () => {
  assert.strictEqual(ROT13('{1NP14R77-02R7-4R5Q-O744-2RO1NR5198O7}\\abgrcnq.rkr'), '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\notepad.exe');
  if (process.platform === 'win32') {
    assert.match(resolveUserAssist('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\notepad.exe'), /System32\\notepad\.exe$/i);
  }
  assert.strictEqual(resolveUserAssist('Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'), 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App');
});

test('recent: launches are remembered newest first, without duplicates, as an array', async () => {
  let data = { search: {} };
  const store = { get: (k) => data[k], set: (patch) => { data = { ...data, search: { ...data.search, ...patch.search } }; } };
  recordLaunch(store, 'C:/apps/a.exe');
  await new Promise((r) => setTimeout(r, 5));
  recordLaunch(store, 'C:/apps/b.exe');
  await new Promise((r) => setTimeout(r, 5));
  recordLaunch(store, 'C:/apps/a.exe');
  assert.ok(Array.isArray(data.search.launchHistory));
  assert.deepStrictEqual(data.search.launchHistory.map((h) => h.p), ['C:/apps/a.exe', 'C:/apps/b.exe']);
  const s = new RecentService({ store, shell: {}, indexEntries: () => [{ kind: 'app', name: 'App A', path: 'C:/apps/a.exe' }] });
  s.files = () => [];
  if (process.platform !== 'win32') {
    const { apps } = await s.recent();
    assert.deepStrictEqual(apps.map((a) => a.name), ['App A', 'b'], 'index names, else the file name');
  }
  assert.strictEqual(s.nameFor('shell:AppsFolder\\www.threads.com-865DBF95_91be99j6fgpq0!App', []), 'threads.com');
});
