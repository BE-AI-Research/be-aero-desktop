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
