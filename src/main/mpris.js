// MPRIS over D-Bus without playerctl. Every media player on a Linux desktop
// (Spotify, Firefox, Chrome, VLC, Rhythmbox...) publishes
// org.mpris.MediaPlayer2.* on the session bus. We talk to it with `gdbus`
// (ships with GLib, so every GNOME desktop has it) or, failing that, with
// systemd's `busctl --json`. Parsers are pure and exported for tests.
const { execFile } = require('child_process');

const PREFIX = 'org.mpris.MediaPlayer2.';
const PATH = '/org/mpris/MediaPlayer2';
const IFACE = 'org.mpris.MediaPlayer2.Player';

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

// ---------------------------------------------------------------- gdbus text
// GVariant text strings: single-quoted unless they contain a single quote.
const STR = `(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`;

function unescapeGv(s) {
  return String(s || '').replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, e) => {
    if (e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v' }[e] || e;
  });
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function gvString(text, key) {
  const m = new RegExp(`'${escapeRe(key)}': <(?:objectpath )?${STR}>`).exec(text);
  return m ? unescapeGv(m[1] !== undefined ? m[1] : m[2]) : null;
}
function gvNumber(text, key) {
  const m = new RegExp(`'${escapeRe(key)}': <(?:u?int(?:16|32|64) |byte |double )?(-?[0-9][0-9.eE+-]*)>`).exec(text);
  return m ? Number(m[1]) : null;
}
function gvBool(text, key) {
  const m = new RegExp(`'${escapeRe(key)}': <(true|false)>`).exec(text);
  return m ? m[1] === 'true' : null;
}
function gvStrings(text, key) {
  const m = new RegExp(`'${escapeRe(key)}': <(?:@as )?\\[((?:\\s*${STR}\\s*,?)*)\\]>`).exec(text);
  if (!m) { const one = gvString(text, key); return one ? [one] : []; }
  const out = [];
  const re = new RegExp(STR, 'g');
  let x;
  while ((x = re.exec(m[1]))) out.push(unescapeGv(x[1] !== undefined ? x[1] : x[2]));
  return out;
}

// gdbus ListNames output -> MPRIS bus names.
function parseNamesGdbus(text) {
  const out = [];
  const re = /'(org\.mpris\.MediaPlayer2\.[^']+)'/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1]);
  return out;
}

// gdbus GetAll(org.mpris.MediaPlayer2.Player) output -> normalized props.
function parsePropsGdbus(text) {
  const t = String(text || '');
  if (!/PlaybackStatus/.test(t)) return null;
  return {
    status: gvString(t, 'PlaybackStatus') || '',
    position: gvNumber(t, 'Position'),
    rate: gvNumber(t, 'Rate'),
    canSeek: gvBool(t, 'CanSeek'),
    canNext: gvBool(t, 'CanGoNext'),
    canPrev: gvBool(t, 'CanGoPrevious'),
    canPlay: gvBool(t, 'CanPlay'),
    canPause: gvBool(t, 'CanPause'),
    title: gvString(t, 'xesam:title') || '',
    artists: gvStrings(t, 'xesam:artist'),
    album: gvString(t, 'xesam:album') || '',
    length: gvNumber(t, 'mpris:length'),
    artUrl: gvString(t, 'mpris:artUrl') || '',
    trackId: gvString(t, 'mpris:trackid') || ''
  };
}

// ---------------------------------------------------------------- busctl json
function parseNamesBusctl(text) {
  try {
    const j = JSON.parse(text);
    const list = Array.isArray(j.data) ? (Array.isArray(j.data[0]) ? j.data[0] : j.data) : [];
    return list.filter((n) => typeof n === 'string' && n.startsWith(PREFIX));
  } catch { return []; }
}

function parsePropsBusctl(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const props = Array.isArray(j.data) ? j.data[0] : j.data;
  if (!props || typeof props !== 'object' || !props.PlaybackStatus) return null;
  const v = (o) => (o && typeof o === 'object' && 'data' in o ? o.data : o);
  const md = v(props.Metadata) || {};
  const artists = v(md['xesam:artist']);
  return {
    status: String(v(props.PlaybackStatus) || ''),
    position: v(props.Position) == null ? null : Number(v(props.Position)),
    rate: v(props.Rate) == null ? null : Number(v(props.Rate)),
    canSeek: v(props.CanSeek) == null ? null : !!v(props.CanSeek),
    canNext: v(props.CanGoNext) == null ? null : !!v(props.CanGoNext),
    canPrev: v(props.CanGoPrevious) == null ? null : !!v(props.CanGoPrevious),
    canPlay: v(props.CanPlay) == null ? null : !!v(props.CanPlay),
    canPause: v(props.CanPause) == null ? null : !!v(props.CanPause),
    title: String(v(md['xesam:title']) || ''),
    artists: Array.isArray(artists) ? artists.map(String) : (artists ? [String(artists)] : []),
    album: String(v(md['xesam:album']) || ''),
    length: v(md['mpris:length']) == null ? null : Number(v(md['mpris:length'])),
    artUrl: String(v(md['mpris:artUrl']) || ''),
    trackId: String(v(md['mpris:trackid']) || '')
  };
}

// "org.mpris.MediaPlayer2.firefox.instance_1_84" -> "firefox"
function playerLabel(name) {
  return String(name || '').slice(PREFIX.length).split('.')[0] || 'player';
}

// The player to show: playing beats paused beats the one shown last.
function pickPlayer(players, lastName) {
  if (!players.length) return null;
  const rank = (p) => (p.props.status === 'Playing' ? 0 : p.props.status === 'Paused' ? 1 : 2);
  return [...players].sort((a, b) => (rank(a) - rank(b)) || ((b.name === lastName) - (a.name === lastName)))[0];
}

// Normalized props -> the widget's info shape (seconds).
function toInfo(name, p, now = Date.now()) {
  const st = String(p.status || '').toLowerCase();
  return {
    status: st === 'playing' ? 'playing' : st === 'paused' ? 'paused' : st === 'stopped' ? 'stopped' : 'none',
    title: p.title || '', artist: (p.artists || []).join(', '), album: p.album || '',
    app: playerLabel(name),
    position: p.position != null ? p.position / 1e6 : 0,
    duration: p.length != null ? p.length / 1e6 : 0,
    rate: p.rate > 0 ? p.rate : 1,
    canSeek: p.canSeek !== false && p.length > 0,
    canNext: p.canNext !== false, canPrev: p.canPrev !== false,
    canPlay: p.canPlay !== false, canPause: p.canPause !== false,
    artUrl: p.artUrl || '',
    sampledAt: now
  };
}

class Mpris {
  constructor({ runner = run } = {}) {
    this.run = runner;
    this.tool = undefined;    // 'gdbus' | 'busctl' | null, found on first use
    this.last = null;         // { name, trackId, position }
  }

  async detect() {
    if (this.tool !== undefined) return this.tool;
    if (await this.run('gdbus', ['--version'])) this.tool = 'gdbus';
    else if (await this.run('busctl', ['--version'])) this.tool = 'busctl';
    else this.tool = null;
    return this.tool;
  }

  async names() {
    const tool = await this.detect();
    if (tool === 'gdbus') {
      return parseNamesGdbus(await this.run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus',
        '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.ListNames']));
    }
    if (tool === 'busctl') {
      return parseNamesBusctl(await this.run('busctl', ['--user', '--json=short', 'call', 'org.freedesktop.DBus',
        '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames']));
    }
    return [];
  }

  async props(name) {
    if (this.tool === 'gdbus') {
      return parsePropsGdbus(await this.run('gdbus', ['call', '--session', '--dest', name, '--object-path', PATH,
        '--method', 'org.freedesktop.DBus.Properties.GetAll', IFACE]));
    }
    return parsePropsBusctl(await this.run('busctl', ['--user', '--json=short', 'call', name, PATH,
      'org.freedesktop.DBus.Properties', 'GetAll', 's', IFACE]));
  }

  // -> info for the widget, or null when no tool exists.
  async info() {
    if (!(await this.detect())) return null;
    const names = await this.names();
    const players = (await Promise.all(names.map(async (name) => ({ name, props: await this.props(name) }))))
      .filter((p) => p.props);
    const p = pickPlayer(players, this.last && this.last.name);
    if (!p) { this.last = null; return { status: 'none' }; }
    const info = toInfo(p.name, p.props);
    this.last = { name: p.name, trackId: p.props.trackId, position: info.position };
    return info;
  }

  async call(method, gdbusArgs = [], busctlSig = '', busctlArgs = []) {
    if (!this.last || !(await this.detect())) return false;
    const name = this.last.name;
    if (this.tool === 'gdbus') {
      return (await this.run('gdbus', ['call', '--session', '--dest', name, '--object-path', PATH, '--method', `${IFACE}.${method}`, ...gdbusArgs])) !== null;
    }
    return (await this.run('busctl', ['--user', 'call', name, PATH, IFACE, method, ...(busctlSig ? [busctlSig, ...busctlArgs] : [])])) !== null;
  }

  action(name) {
    const method = { play: 'Play', pause: 'Pause', toggle: 'PlayPause', next: 'Next', prev: 'Previous', stop: 'Stop' }[name];
    return method ? this.call(method) : Promise.resolve(false);
  }

  // Absolute seek: SetPosition needs the track id; without one, a relative Seek.
  seek(seconds) {
    if (!this.last) return Promise.resolve(false);
    const us = Math.round(Number(seconds) * 1e6);
    if (this.last.trackId) {
      return this.call('SetPosition', [`objectpath '${this.last.trackId.replace(/'/g, '')}'`, `int64 ${us}`], 'ox', [this.last.trackId, String(us)]);
    }
    const delta = us - Math.round((this.last.position || 0) * 1e6);
    return this.call('Seek', [`int64 ${delta}`], 'x', [String(delta)]);
  }
}

module.exports = { Mpris, parseNamesGdbus, parsePropsGdbus, parseNamesBusctl, parsePropsBusctl, pickPlayer, toInfo, playerLabel, unescapeGv };
