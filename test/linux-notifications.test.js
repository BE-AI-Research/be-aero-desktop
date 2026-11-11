const test = require('node:test');
const assert = require('node:assert');
const { DbusMonitorParser, fromBusctl, LinuxNotificationWatcher } = require('../src/main/linux-notifications');

const DBUS_MONITOR = `signal time=1794350000.1 sender=org.freedesktop.DBus -> destination=:1.200 serial=2 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameAcquired
   string ":1.200"
method call time=1794350001.2 sender=:1.88 -> destination=:1.36 serial=7 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify
   string "Thunderbird"
   uint32 0
   string "thunderbird"
   string "New mail from Sam"
   string "Lunch at noon?
See you there"
   array [
      string "default"
      string "Open"
   ]
   array [
      dict entry(
         string "urgency"
         variant             byte 1
      )
      dict entry(
         string "desktop-entry"
         variant             string "thunderbird"
      )
   ]
   int32 -1
method call time=1794350002.3 sender=:1.40 -> destination=:1.10 serial=9 path=/org/gtk/Notifications; interface=org.gtk.Notifications; member=AddNotification
   string "org.gnome.Software"
   string "updates-available"
   array [
      dict entry(
         string "title"
         variant             string "Software Updates Available"
      )
      dict entry(
         string "body"
         variant             string "Important OS and application updates are ready to be installed"
      )
   ]
`;

test('dbus-monitor output: Notify (with a multi-line body and nested strings) and GNOME AddNotification', () => {
  const got = [];
  const p = new DbusMonitorParser((n) => got.push(n));
  for (const line of DBUS_MONITOR.split('\n')) p.feed(line);
  p.flush();
  assert.deepStrictEqual(got, [
    { app: 'Thunderbird', title: 'New mail from Sam', body: 'Lunch at noon?\nSee you there' },
    { app: 'org.gnome.Software', title: 'Software Updates Available', body: 'Important OS and application updates are ready to be installed' }
  ]);
});

test('busctl JSON: Notify and AddNotification, dicts as objects or pairs', () => {
  assert.deepStrictEqual(fromBusctl({ type: 'method_call', interface: 'org.freedesktop.Notifications', member: 'Notify',
    payload: { type: 'susssasa{sv}i', data: ['Slack', 0, '', 'Sam', 'Ready for lunch?', [], {}, -1] } }),
  { app: 'Slack', title: 'Sam', body: 'Ready for lunch?' });
  assert.deepStrictEqual(fromBusctl({ type: 'method_call', interface: 'org.gtk.Notifications', member: 'AddNotification',
    payload: { type: 'ssa{sv}', data: ['org.gnome.Calendar', 'x', { title: { type: 's', data: 'Standup' }, body: { type: 's', data: 'in 5 minutes' } }] } }),
  { app: 'org.gnome.Calendar', title: 'Standup', body: 'in 5 minutes' });
  assert.deepStrictEqual(fromBusctl({ type: 'method_call', interface: 'org.gtk.Notifications', member: 'AddNotification',
    payload: { data: ['app', 'y', [['title', { type: 's', data: 'T' }], ['body', { type: 's', data: 'B' }]]] } }),
  { app: 'app', title: 'T', body: 'B' });
  assert.strictEqual(fromBusctl({ type: 'method_return', payload: { data: [3] } }), null);
  assert.strictEqual(fromBusctl({ type: 'signal', interface: 'org.freedesktop.Notifications', member: 'NotificationClosed', payload: { data: [3, 1] } }), null);
});

test('watcher: our own toasts are skipped and quick repeats are folded', () => {
  const got = [];
  const w = new LinuxNotificationWatcher({ onNotification: (n) => got.push(n) });
  w.deliver({ app: 'BE-Aero Desktop', title: 'Task finished', body: '' });
  w.deliver({ app: 'Slack', title: 'Sam', body: 'hi' });
  w.deliver({ app: 'Slack', title: 'Sam', body: 'hi' });
  w.deliver({ app: 'Slack', title: '', body: '' });
  assert.deepStrictEqual(got, [{ app: 'Slack', title: 'Sam', body: 'hi' }]);
});

test('linux dock: .desktop files with leading comments are read, and themed icons are found', () => {
  const { parseDesktopFile, buildIconIndex, sizeRank } = require('../src/main/tasks-linux');
  const calc = '#\n# This file is part of the LibreOffice project.\n#\n[Desktop Entry]\nName=LibreOffice Calc\nExec=libreoffice --calc %U\nIcon=libreoffice-calc\nType=Application\n\n[Desktop Action NewDocument]\nName=New Spreadsheet\nIcon=document-new\n';
  const e = parseDesktopFile('/usr/share/applications/libreoffice-calc.desktop', calc);
  assert.ok(e, 'parsed despite the comments');
  assert.strictEqual(e.name, 'LibreOffice Calc');
  assert.strictEqual(e.icon, 'libreoffice-calc', 'the action group\'s Icon= is not taken');
  assert.strictEqual(parseDesktopFile('/x.desktop', '# only a comment\n'), null);

  // A fake icon tree: hicolor PNGs in several sizes, Adwaita SVG under devices/.
  const tree = {
    '/d/icons/hicolor': ['16x16', '128x128', 'scalable'],
    '/d/icons/hicolor/16x16': ['apps'], '/d/icons/hicolor/16x16/apps': ['libreoffice-calc.png'],
    '/d/icons/hicolor/128x128': ['apps'], '/d/icons/hicolor/128x128/apps': ['libreoffice-calc.png', 'gvim.png'],
    '/d/icons/hicolor/scalable': ['apps'], '/d/icons/hicolor/scalable/apps': ['gvim.svg', 'gvim-symbolic.svg'],
    '/d/icons/Adwaita': ['scalable'], '/d/icons/Adwaita/scalable': ['devices'], '/d/icons/Adwaita/scalable/devices': ['input-keyboard.svg']
  };
  const fakeFs = { readdirSync: (p) => { const k = p.replace(/\\/g, '/'); if (!tree[k]) throw new Error('ENOENT'); return tree[k]; } };
  const idx = buildIconIndex(['Adwaita', 'hicolor'], ['/d'], fakeFs);
  const f = (n) => (idx.get(n) || {}).file.replace(/\\/g, '/');
  assert.strictEqual(f('libreoffice-calc'), '/d/icons/hicolor/128x128/apps/libreoffice-calc.png', 'largest PNG wins');
  assert.strictEqual(f('gvim'), '/d/icons/hicolor/scalable/apps/gvim.svg', 'scalable wins');
  assert.strictEqual(f('input-keyboard'), '/d/icons/Adwaita/scalable/devices/input-keyboard.svg', 'any category, any theme');
  assert.ok(!idx.has('gvim-symbolic'), 'symbolic icons skipped');
  assert.ok(sizeRank('scalable') > sizeRank('256x256') && sizeRank('256x256') > sizeRank('512x512') && sizeRank('32x32@2') === 64);
});

test('linux dock: wrapper launchers match by install folder, web apps keep to their own, one tile per app', () => {
  const { matchProcesses } = require('../src/main/tasks-linux');
  const entries = [
    { name: 'Gemini', file: '/home/u/.local/share/applications/chrome-abc-Default.desktop', base: 'google-chrome', binDir: '/opt/google/chrome', webAppId: 'abc' },
    { name: 'Google Chrome', file: '/usr/share/applications/google-chrome.desktop', base: 'google-chrome-stable', binDir: '/opt/google/chrome', webAppId: '' },
    { name: 'Files', file: '/usr/share/applications/org.gnome.Nautilus.desktop', base: 'nautilus', binDir: '', webAppId: '' }
  ];
  const procs = [
    { pid: 900, comm: 'chrome', argv0: 'chrome', dir: '/opt/google/chrome', args: '/opt/google/chrome/chrome' },
    { pid: 905, comm: 'chrome', argv0: 'chrome', dir: '/opt/google/chrome', args: '/opt/google/chrome/chrome --type=renderer' },
    { pid: 950, comm: 'chrome', argv0: 'chrome', dir: '/opt/google/chrome', args: '/opt/google/chrome/chrome --app-id=abc', webApp: true },
    { pid: 990, comm: 'nautilus', argv0: 'nautilus', dir: '/usr/bin', args: '/usr/bin/nautilus' }
  ];
  const out = matchProcesses(procs, entries).map((w) => `${w.title}:${w.pid}:${w.processes}`).sort();
  assert.deepStrictEqual(out, ['Files:990:1', 'Gemini:950:1', 'Google Chrome:900:2']);
});
