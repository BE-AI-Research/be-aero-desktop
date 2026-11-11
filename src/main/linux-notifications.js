// Linux: mirror every desktop notification into the notification center.
//
// Notifications travel over the session bus. Most apps call
// org.freedesktop.Notifications.Notify; GNOME apps (GNotification) call
// org.gtk.Notifications.AddNotification on GNOME Shell; Flatpak apps go
// through the portal, which then makes one of those two calls. A process
// running as the user may monitor that user's own session bus, so watching
// both calls sees everything - read-only, nothing is intercepted or changed.
//
// Monitor: `busctl --user monitor --json=short` (systemd) when present, else
// `dbus-monitor --session` (dbus). Restarted with backoff if it exits.
const { spawn, execFileSync } = require('child_process');

const FDO = 'org.freedesktop.Notifications';
const GTK = 'org.gtk.Notifications';
const DEDUPE_MS = 3000;

function which(bin) {
  try { return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

// A variant / dict value from busctl's JSON: {type, data} or the bare value.
const unwrap = (v) => (v && typeof v === 'object' && 'data' in v && 'type' in v ? unwrap(v.data) : v);

// GNotification bodies arrive as a{sv}; busctl prints a dict either as an
// object or as [[key, value], ...].
function dictGet(dict, key) {
  const d = unwrap(dict);
  if (!d) return undefined;
  if (Array.isArray(d)) { const e = d.find((x) => Array.isArray(x) && x[0] === key); return e ? unwrap(e[1]) : undefined; }
  if (typeof d === 'object') return unwrap(d[key]);
  return undefined;
}

// One busctl JSON message -> { app, title, body } or null.
function fromBusctl(msg) {
  if (!msg || msg.type !== 'method_call') return null;
  const data = msg.payload && Array.isArray(msg.payload.data) ? msg.payload.data : null;
  if (!data) return null;
  if (msg.interface === FDO && msg.member === 'Notify') {
    // (app_name, replaces_id, app_icon, summary, body, actions, hints, timeout)
    return { app: String(unwrap(data[0]) || ''), title: String(unwrap(data[3]) || ''), body: String(unwrap(data[4]) || '') };
  }
  if (msg.interface === GTK && msg.member === 'AddNotification') {
    // (app_id, notification_id, a{sv} with title / body)
    return { app: String(unwrap(data[0]) || ''), title: String(dictGet(data[2], 'title') || ''), body: String(dictGet(data[2], 'body') || '') };
  }
  return null;
}

// dbus-monitor's text output, fed line by line. Collects the top-level
// arguments of a Notify / AddNotification call and emits when the next
// message header (or flush) ends it.
class DbusMonitorParser {
  constructor(onNotification) {
    this.emit = onNotification;
    this.cur = null;          // { kind: 'fdo'|'gtk', strings: [], dict: {}, pendingKey }
    this.partial = null;      // a string argument spanning lines
  }

  feed(line) {
    if (this.partial !== null) {
      // Continuation of a multi-line string: ends at a line ending in ".
      if (/"\s*$/.test(line) && !/\\"\s*$/.test(line)) { this.take(this.partial + '\n' + line.replace(/"\s*$/, '')); this.partial = null; }
      else this.partial += '\n' + line;
      return;
    }
    const head = line.match(/^(method call|method return|signal|error)\b.*?interface=([^;\s]+);\s*member=([^\s;]+)/);
    if (head || /^(method call|method return|signal|error)\b/.test(line)) {
      this.flush();
      if (head && head[1] === 'method call') {
        if (head[2] === FDO && head[3] === 'Notify') this.cur = { kind: 'fdo', strings: [], dict: {}, pendingKey: null };
        else if (head[2] === GTK && head[3] === 'AddNotification') this.cur = { kind: 'gtk', strings: [], dict: {}, pendingKey: null };
      }
      return;
    }
    if (!this.cur) return;
    const m = line.match(/^(\s*)(?:variant\s+)?string "(.*)$/);
    if (!m) return;
    const rest = m[2];
    if (/"\s*$/.test(rest) && !/\\"\s*$/.test(rest)) this.take(rest.replace(/"\s*$/, ''), m[1].length, /variant/.test(line));
    else { this.partial = rest; this.partialIndent = m[1].length; }
  }

  take(text, indent = this.partialIndent || 3, isVariant = false) {
    const c = this.cur;
    if (!c) return;
    const value = text.replace(/\\"/g, '"');
    if (indent <= 3) { c.strings.push(value); return; }
    // Inside a dict entry: key, then its variant value.
    if (!isVariant && c.pendingKey === null) c.pendingKey = value;
    else { if (c.pendingKey !== null) c.dict[c.pendingKey] = value; c.pendingKey = null; }
  }

  flush() {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    if (c.kind === 'fdo') {
      // Top-level strings in order: app_name, app_icon, summary, body.
      const [app = '', , title = '', body = ''] = c.strings;
      this.emit({ app, title, body });
    } else {
      this.emit({ app: c.strings[0] || '', title: c.dict.title || '', body: c.dict.body || '' });
    }
  }
}

class LinuxNotificationWatcher {
  // { onNotification({ app, title, body }), ownNames: [regex], log }
  constructor({ onNotification, ownNames = [/be-?aero/i, /^electron$/i], log = () => {} }) {
    this.onNotification = onNotification;
    this.ownNames = ownNames;
    this.log = log;
    this.proc = null;
    this.stopped = true;
    this.restarts = [];
    this.recent = new Map();
    this.tool = null;
  }

  available() {
    if (process.platform !== 'linux') return null;
    if (which('busctl')) return 'busctl';
    if (which('dbus-monitor')) return 'dbus-monitor';
    return null;
  }

  deliver(n) {
    if (!n || (!n.title && !n.body)) return;
    if (this.ownNames.some((re) => re.test(n.app || ''))) return;   // our own toasts
    const key = `${n.app}|${n.title}|${n.body}`;
    const now = Date.now();
    for (const [k, t] of this.recent) if (now - t > DEDUPE_MS) this.recent.delete(k);
    if (this.recent.has(key)) return;                                 // replaces_id refreshes, double hops
    this.recent.set(key, now);
    this.onNotification(n);
  }

  start() {
    if (this.proc) return true;
    this.tool = this.available();
    if (!this.tool) { this.log('no busctl or dbus-monitor: system notifications are not captured'); return false; }
    this.stopped = false;
    this.spawn();
    return true;
  }

  spawn() {
    let proc;
    let buf = '';
    let onLine;
    if (this.tool === 'busctl') {
      proc = spawn('busctl', ['--user', 'monitor', '--json=short', FDO, GTK], { stdio: ['ignore', 'pipe', 'pipe'] });
      onLine = (line) => { if (!line.startsWith('{')) return; let j; try { j = JSON.parse(line); } catch { return; } this.deliver(fromBusctl(j)); };
    } else {
      const parser = new DbusMonitorParser((n) => this.deliver(n));
      proc = spawn('dbus-monitor', ['--session', `type='method_call',interface='${FDO}',member='Notify'`, `type='method_call',interface='${GTK}',member='AddNotification'`], { stdio: ['ignore', 'pipe', 'pipe'] });
      onLine = (line) => parser.feed(line);
      proc.stdout.on('end', () => parser.flush());
      // dbus-monitor prints a call only when the next message arrives; flush
      // after a quiet moment so a lone notification is not held back.
      let t = null;
      const base = onLine;
      onLine = (line) => { base(line); clearTimeout(t); t = setTimeout(() => parser.flush(), 400); };
    }
    this.proc = proc;
    let errText = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine(line); }
    });
    proc.stderr.on('data', (d) => { errText = (errText + d).slice(-400); });
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      this.log(`${this.tool} exited (${code})${errText ? `: ${errText.trim()}` : ''}`);
      // busctl that cannot monitor (old systemd, bus policy): try dbus-monitor.
      if (this.tool === 'busctl' && which('dbus-monitor') && this.restarts.length === 0) { this.tool = 'dbus-monitor'; }
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 10 * 60000);
      if (this.restarts.length >= 5) { this.log('giving up on system notification capture after repeated exits'); this.stopped = true; return; }
      this.restarts.push(now);
      setTimeout(() => { if (!this.stopped) this.spawn(); }, 2000 * this.restarts.length);
    });
    proc.on('error', () => { /* exit follows */ });
  }

  stop() {
    this.stopped = true;
    if (this.proc) { try { this.proc.kill(); } catch { /* gone */ } this.proc = null; }
  }

  status() {
    return { platform: process.platform, running: !!this.proc, tool: this.tool };
  }
}

module.exports = { LinuxNotificationWatcher, DbusMonitorParser, fromBusctl };
