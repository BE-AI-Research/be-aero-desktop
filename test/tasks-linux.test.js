const test = require('node:test');
const assert = require('node:assert');
const { execBase, containerId, matchProcesses, parseDesktopFile } = require('../src/main/tasks-linux');

test('execBase finds the real command through wrappers and field codes', () => {
  assert.strictEqual(execBase('/usr/bin/firefox %u'), 'firefox');
  assert.strictEqual(execBase('env GDK_BACKEND=x11 gnome-calculator'), 'gnome-calculator');
  assert.strictEqual(execBase('"/opt/My App/myapp" --flag %F'), 'myapp');
  assert.strictEqual(execBase('/usr/bin/flatpak run org.gnome.Maps'), null, 'flatpak matches via cgroup');
  assert.strictEqual(execBase(''), null);
});

test('containerId reads flatpak and snap cgroups', () => {
  assert.deepStrictEqual(containerId('0::/user.slice/app-flatpak-org.mozilla.firefox-1234.scope'), { flatpak: 'org.mozilla.firefox' });
  assert.deepStrictEqual(containerId('0::/user.slice/snap.spotify.spotify.scope'), { snap: 'spotify' });
  assert.strictEqual(containerId('0::/user.slice/session.scope'), null);
});

test('matchProcesses pairs processes with desktop entries', () => {
  const entries = [
    { name: 'Firefox', file: '/usr/share/applications/firefox.desktop', base: 'firefox', flatpakId: null, snapName: null },
    { name: 'Maps', file: '/var/lib/flatpak/exports/share/applications/org.gnome.Maps.desktop', base: null, flatpakId: 'org.gnome.Maps', snapName: null },
    { name: 'Editor', file: '/usr/share/applications/org.gnome.TextEditor.desktop', base: 'gnome-text-editor', flatpakId: null, snapName: null }
  ];
  const procs = [
    { pid: 10, comm: 'firefox', argv0: 'firefox', flatpak: null, snap: null },
    { pid: 11, comm: 'gnome-maps', argv0: 'gnome-maps', flatpak: 'org.gnome.Maps', snap: null },
    { pid: 12, comm: 'gnome-text-edit', argv0: 'gnome-text-editor', flatpak: null, snap: null }, // comm truncated at 15
    { pid: 13, comm: 'systemd', argv0: 'systemd', flatpak: null, snap: null }
  ];
  const out = matchProcesses(procs, entries);
  assert.deepStrictEqual(out.map((w) => [w.pid, w.title]), [[10, 'Firefox'], [11, 'Maps'], [12, 'Editor']]);
  assert.ok(out.every((w) => w.exe.endsWith('.desktop')), 'tiles group by the desktop file');
  assert.ok(!out.some((w) => w.pid === 13), 'non-application processes stay out');
});

test('matchProcesses never claims a flatpak process for a plain entry', () => {
  const entries = [{ name: 'Firefox (system)', file: '/usr/share/applications/firefox.desktop', base: 'firefox', flatpakId: null, snapName: null }];
  const procs = [{ pid: 20, comm: 'firefox', argv0: 'firefox', flatpak: 'org.mozilla.firefox', snap: null }];
  assert.deepStrictEqual(matchProcesses(procs, entries), [], 'containerized process belongs to its own entry');
});

test('parseDesktopFile respects NoDisplay and extracts the essentials', () => {
  const e = parseDesktopFile('/usr/share/applications/firefox.desktop',
    '[Desktop Entry]\nType=Application\nName=Firefox\nExec=/usr/bin/firefox %u\nIcon=firefox\n');
  assert.strictEqual(e.name, 'Firefox');
  assert.strictEqual(e.base, 'firefox');
  assert.strictEqual(e.icon, 'firefox');
  assert.strictEqual(parseDesktopFile('/a/b.desktop', '[Desktop Entry]\nName=X\nExec=x\nNoDisplay=true\n'), null);
  const fp = parseDesktopFile('/var/lib/flatpak/exports/share/applications/org.gnome.Maps.desktop',
    '[Desktop Entry]\nName=Maps\nExec=/usr/bin/flatpak run --command=gnome-maps org.gnome.Maps\n');
  assert.strictEqual(fp.flatpakId, 'org.gnome.Maps');
});
