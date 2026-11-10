const test = require('node:test');
const assert = require('node:assert');
const { parseWmctrl, parseGdbusB64, entryForWindow } = require('../src/main/tasks-linux');
const { parseProcNetDev, diskUsage } = require('../src/main/telemetry');

test('parseWmctrl reads id, pid, class and title', () => {
  const text = '0x03600007  0 4242   navigator.Firefox-esr  debian Mozilla Firefox\n' +
    '0x04000003  1 5151   gnome-terminal-server.Gnome-terminal  debian ~\n' +
    'garbage line\n';
  const w = parseWmctrl(text);
  assert.strictEqual(w.length, 2);
  assert.deepStrictEqual(w[0], { id: 0x03600007, desktop: 0, pid: 4242, wmClass: 'navigator.Firefox-esr', title: 'Mozilla Firefox' });
  assert.strictEqual(w[1].title, '~');
});

test('parseGdbusB64 decodes the helper tuple', () => {
  const payload = Buffer.from(JSON.stringify([{ id: 7, title: "it's \"quoted\"" }])).toString('base64');
  assert.deepStrictEqual(parseGdbusB64(`('${payload}',)\n`), [{ id: 7, title: "it's \"quoted\"" }]);
  assert.strictEqual(parseGdbusB64('Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod'), null);
  assert.strictEqual(parseGdbusB64(''), null);
});

test('entryForWindow resolves by app id, StartupWMClass, class and process', () => {
  const entries = [
    { id: 'firefox-esr', name: 'Firefox ESR', file: '/usr/share/applications/firefox-esr.desktop', base: 'firefox-esr', wmClass: '' },
    { id: 'org.gnome.Terminal', name: 'Terminal', file: '/usr/share/applications/org.gnome.Terminal.desktop', base: 'gnome-terminal', wmClass: 'Gnome-terminal' },
    { id: 'code', name: 'VS Code', file: '/usr/share/applications/code.desktop', base: 'code', wmClass: '' }
  ];
  assert.strictEqual(entryForWindow({ app: 'org.gnome.Terminal.desktop' }, entries, []).name, 'Terminal');
  assert.strictEqual(entryForWindow({ wmClass: 'gnome-terminal-server.Gnome-terminal' }, entries, []).name, 'Terminal');
  assert.strictEqual(entryForWindow({ wmClass: 'navigator.Firefox-esr' }, entries, []).name, 'Firefox ESR');
  assert.strictEqual(entryForWindow({ wmClass: 'weird.Thing', pid: 9 }, entries,
    [{ pid: 9, comm: 'code', argv0: 'code', flatpak: null, snap: null }]).name, 'VS Code');
  assert.strictEqual(entryForWindow({ wmClass: 'unknown.Unknown', pid: 1 }, entries, []), null);
});

test('parseProcNetDev sums every interface but loopback', () => {
  const text = 'Inter-|   Receive                                                |  Transmit\n' +
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n' +
    '    lo: 999999 100 0 0 0 0 0 0 999999 100 0 0 0 0 0 0\n' +
    'enp3s0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n' +
    ' wlan0: 500 5 0 0 0 0 0 0 700 7 0 0 0 0 0 0\n';
  assert.deepStrictEqual(parseProcNetDev(text), { rx: 1500, tx: 2700 });
  assert.strictEqual(parseProcNetDev('nothing here'), null);
});

test('diskUsage reads the root filesystem off Windows', { skip: process.platform === 'win32' }, () => {
  const d = diskUsage('C:');
  assert.ok(d && d.totalGB > 0);
  assert.strictEqual(d.drive, '/');
});
