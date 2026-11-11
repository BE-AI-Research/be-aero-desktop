const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileService, freeName, within } = require('../src/main/files');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-files-'));
  const trashed = [];
  const store = { data: { files: { poolDir: path.join(dir, 'Pool') } }, get(k) { return this.data[k]; } };
  const svc = new FileService({
    getPath: (n) => (n === 'home' ? dir : path.join(dir, `no-${n}`)), store,
    shell: { trashItem: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }); }, openPath: async () => '', showItemInFolder: () => {} },
    nativeImage: { createThumbnailFromPath: async () => ({ isEmpty: () => true }), createFromPath: () => ({ isEmpty: () => true }) }
  });
  return { dir, svc, trashed, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('files: names never collide, and nothing goes inside itself', async () => {
  const { dir, done } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'report.pdf'), 'x');
    fs.writeFileSync(path.join(dir, 'report (2).pdf'), 'x');
    assert.strictEqual(await freeName(dir, 'report.pdf'), 'report (3).pdf');
    assert.strictEqual(await freeName(dir, 'new.txt'), 'new.txt');
    assert.ok(within(dir, path.join(dir, 'a', 'b')) && within(dir, dir) && !within(path.join(dir, 'a'), dir));
  } finally { done(); }
});

test('files: list, copy (no overwrite), move, rename rules, trash, the pool', async () => {
  const { dir, svc, trashed, done } = setup();
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'dest'));
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'hello');
    fs.writeFileSync(path.join(dir, 'dest', 'a.txt'), 'already here');
    fs.writeFileSync(path.join(dir, '.hidden'), '');
    const l = await svc.list(dir);
    assert.deepStrictEqual(l.entries.map((e) => [e.name, e.dir, e.hidden]).sort(), [['.hidden', false, true], ['dest', true, false], ['src', true, false]]);
    assert.strictEqual(l.parent, path.dirname(dir));
    const [copied] = await svc.transfer([path.join(dir, 'src', 'a.txt')], path.join(dir, 'dest'));
    assert.strictEqual(path.basename(copied), 'a (2).txt', 'copy did not overwrite');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'dest', 'a.txt'), 'utf8'), 'already here');
    await assert.rejects(svc.transfer([path.join(dir, 'src')], path.join(dir, 'src', 'inner')), /inside itself/);
    const [moved] = await svc.transfer([path.join(dir, 'src', 'a.txt')], dir, { move: true });
    assert.ok(fs.existsSync(moved) && !fs.existsSync(path.join(dir, 'src', 'a.txt')), 'moved');
    await assert.rejects(svc.rename(moved, 'bad/name.txt'), /not allowed/);
    await assert.rejects(svc.rename(moved, 'dest'), /already exists/);
    const renamed = await svc.rename(moved, 'b.txt');
    assert.strictEqual(path.basename(renamed), 'b.txt');
    await svc.trash([renamed]);
    assert.deepStrictEqual(trashed, [renamed], 'deleted through the trash, not unlinked');
    const folder = await svc.mkdir(dir, 'dest');
    assert.strictEqual(path.basename(folder), 'dest (2)');
    const pool = await svc.ensurePool();
    assert.ok(fs.existsSync(path.join(pool, 'About the File Pool.txt')));
    assert.ok((await svc.list(pool)).inPool);
    const places = await svc.places();
    assert.strictEqual(places[0].kind, 'pool');
    assert.ok(places.some((p) => p.id === 'home'));
    const prev = await svc.preview(path.join(pool, 'About the File Pool.txt'));
    assert.strictEqual(prev.kind, 'text');
    assert.match(prev.text, /File Pool/);
  } finally { done(); }
});

test('files: typed addresses - ~, environment variables, quotes, file URLs, bare drives', () => {
  const { expandPath } = require('../src/main/files');
  assert.strictEqual(expandPath('~'), os.homedir());
  assert.strictEqual(expandPath('~/Documents'), path.join(os.homedir(), 'Documents'));
  process.env.AERO_TEST_DIR = path.join(os.tmpdir(), 'aero-x');
  assert.strictEqual(expandPath('$AERO_TEST_DIR/sub'), path.join(os.tmpdir(), 'aero-x', 'sub'));
  assert.strictEqual(expandPath('${AERO_TEST_DIR}'), path.join(os.tmpdir(), 'aero-x'));
  if (process.platform === 'win32') {
    assert.strictEqual(expandPath('%AERO_TEST_DIR%\\sub'), path.join(os.tmpdir(), 'aero-x', 'sub'));
    assert.strictEqual(expandPath('"C:\\Windows"'), 'C:\\Windows');
    assert.strictEqual(expandPath('file:///C:/Users'), 'C:\\Users');
    assert.strictEqual(expandPath('D:'), 'D:\\');
  } else {
    assert.strictEqual(expandPath('file:///tmp'), '/tmp');
  }
  assert.strictEqual(expandPath(''), os.homedir());
});

test('files: a typed address that is missing or a file says so', async () => {
  const { dir, svc, done } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
    await assert.rejects(svc.list(path.join(dir, 'nope')), /was not found/);
    await assert.rejects(svc.list(path.join(dir, 'f.txt')), /is a file, not a folder/);
  } finally { done(); }
});

test('smb: addresses, net view and gio parsing, friendly errors', () => {
  const { parseAddress, parseNetView, parseGioMounts, friendly } = require('../src/main/smb');
  assert.deepStrictEqual(parseAddress('smb://alice@nas/media/films'), { server: 'nas', share: 'media', rest: 'films' });
  assert.deepStrictEqual(parseAddress('//nas/media'), { server: 'nas', share: 'media', rest: '' });
  assert.deepStrictEqual(parseAddress('smb://nas'), { server: 'nas', share: '', rest: '' });
  assert.strictEqual(parseAddress('C:/Users'), null);
  const view = 'Shared resources at \\Mainframe\r\n\r\nShare name  Type  Used as  Comment\r\n\r\n-------------------------------------------\r\nDATABASE    Disk  M:\r\nprinter     Print\r\nThe command completed successfully.\r\n';
  assert.deepStrictEqual(parseNetView(view), ['DATABASE']);
  assert.deepStrictEqual(parseGioMounts('Drive(0): disk\nMount(0): media on nas -> smb://nas/media/\n'), [{ server: 'nas', share: 'media', uri: 'smb://nas/media' }]);
  assert.match(friendly('System error 1326 has occurred'), /not accepted/);
  assert.match(friendly('The network path was not found'), /not found/);
});
