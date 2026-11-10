const test = require('node:test');
const assert = require('node:assert');
const { Mpris, parseNamesGdbus, parsePropsGdbus, parseNamesBusctl, parsePropsBusctl, pickPlayer, toInfo, playerLabel } = require('../src/main/mpris');

// Shapes as gdbus prints them (Firefox, Spotify, Chrome).
const NAMES = "(['org.freedesktop.DBus', ':1.7', 'org.gnome.Shell', 'org.mpris.MediaPlayer2.spotify', 'org.mpris.MediaPlayer2.firefox.instance_1_84', ':1.120'],)\n";
const SPOTIFY = "({'CanPlay': <true>, 'CanPause': <true>, 'CanSeek': <true>, 'CanControl': <true>, 'CanGoNext': <true>, 'CanGoPrevious': <true>, " +
  "'Metadata': <{'mpris:trackid': <'spotify:track:4uLU6hMCjMI75M1A2tKUQC'>, 'mpris:length': <uint64 213000000>, 'mpris:artUrl': <'https://i.scdn.co/image/ab67616d0000b273'>, " +
  "'xesam:album': <\"Don't Stop Me Now\">, 'xesam:artist': <['Queen', 'Freddie Mercury']>, 'xesam:title': <'Don\\'t Stop Me Now'>, 'xesam:trackNumber': <12>}>, " +
  "'PlaybackStatus': <'Playing'>, 'Position': <int64 42500000>, 'Rate': <1.0>, 'Volume': <0.75>},)\n";
const FIREFOX = "({'CanGoNext': <false>, 'CanGoPrevious': <false>, 'CanPlay': <true>, 'CanPause': <true>, 'CanSeek': <true>, " +
  "'Metadata': <{'mpris:trackid': <objectpath '/org/mpris/MediaPlayer2/firefox'>, 'xesam:title': <'Caf\\u00e9 Lo-fi \\u2014 Live'>, 'xesam:artist': <@as ['Some Channel']>, 'mpris:length': <int64 3600000000>}>, " +
  "'PlaybackStatus': <'Paused'>, 'Position': <int64 1200000000>, 'Rate': <1.0>},)\n";

test('gdbus: MPRIS names are found among all bus names', () => {
  assert.deepStrictEqual(parseNamesGdbus(NAMES), ['org.mpris.MediaPlayer2.spotify', 'org.mpris.MediaPlayer2.firefox.instance_1_84']);
  assert.deepStrictEqual(parseNamesGdbus(''), []);
});

test('gdbus: player properties parse, including quotes, arrays and unicode', () => {
  const s = parsePropsGdbus(SPOTIFY);
  assert.strictEqual(s.status, 'Playing');
  assert.strictEqual(s.title, "Don't Stop Me Now");
  assert.strictEqual(s.album, "Don't Stop Me Now");
  assert.deepStrictEqual(s.artists, ['Queen', 'Freddie Mercury']);
  assert.strictEqual(s.length, 213000000);
  assert.strictEqual(s.position, 42500000);
  assert.strictEqual(s.rate, 1);
  assert.strictEqual(s.canSeek, true);
  assert.strictEqual(s.trackId, 'spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  const f = parsePropsGdbus(FIREFOX);
  assert.strictEqual(f.title, 'Café Lo-fi — Live');
  assert.deepStrictEqual(f.artists, ['Some Channel']);
  assert.strictEqual(f.trackId, '/org/mpris/MediaPlayer2/firefox');
  assert.strictEqual(f.canNext, false);
  assert.strictEqual(parsePropsGdbus('Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown'), null);
});

test('busctl --json shapes parse to the same props', () => {
  assert.deepStrictEqual(parseNamesBusctl('{"type":"as","data":[["org.freedesktop.DBus","org.mpris.MediaPlayer2.vlc"]]}'), ['org.mpris.MediaPlayer2.vlc']);
  const j = { type: 'a{sv}', data: [{
    PlaybackStatus: { type: 's', data: 'Playing' }, Position: { type: 'x', data: 5000000 }, Rate: { type: 'd', data: 1 },
    CanSeek: { type: 'b', data: true }, CanGoNext: { type: 'b', data: true },
    Metadata: { type: 'a{sv}', data: { 'xesam:title': { type: 's', data: 'Song' }, 'xesam:artist': { type: 'as', data: ['A'] }, 'mpris:length': { type: 'x', data: 180000000 }, 'mpris:trackid': { type: 'o', data: '/org/videolan/vlc/playlist/3' } } }
  }] };
  const p = parsePropsBusctl(JSON.stringify(j));
  assert.strictEqual(p.title, 'Song');
  assert.deepStrictEqual(p.artists, ['A']);
  assert.strictEqual(p.position, 5000000);
  assert.strictEqual(p.trackId, '/org/videolan/vlc/playlist/3');
  assert.strictEqual(parsePropsBusctl('not json'), null);
});

test('the playing player wins; info is in seconds with a sample time', () => {
  const players = [
    { name: 'org.mpris.MediaPlayer2.firefox.instance_1_84', props: parsePropsGdbus(FIREFOX) },
    { name: 'org.mpris.MediaPlayer2.spotify', props: parsePropsGdbus(SPOTIFY) }
  ];
  const p = pickPlayer(players, null);
  assert.strictEqual(p.name, 'org.mpris.MediaPlayer2.spotify');
  const info = toInfo(p.name, p.props, 1000);
  assert.deepStrictEqual([info.status, info.app, info.position, info.duration, info.artist, info.sampledAt], ['playing', 'spotify', 42.5, 213, 'Queen, Freddie Mercury', 1000]);
  assert.strictEqual(playerLabel('org.mpris.MediaPlayer2.firefox.instance_1_84'), 'firefox');
});

test('Mpris drives gdbus: info, controls and absolute seek through SetPosition', async () => {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === '--version') return cmd === 'gdbus' ? 'gdbus 2.74.6\n' : null;
    if (args.includes('org.freedesktop.DBus.ListNames')) return NAMES;
    if (args.includes('org.freedesktop.DBus.Properties.GetAll')) return args.includes('org.mpris.MediaPlayer2.spotify') ? SPOTIFY : FIREFOX;
    return '()\n';
  };
  const m = new Mpris({ runner });
  const info = await m.info();
  assert.strictEqual(info.title, "Don't Stop Me Now");
  assert.strictEqual(await m.action('toggle'), true);
  assert.ok(calls.some((c) => c.includes('--dest org.mpris.MediaPlayer2.spotify') && c.endsWith('org.mpris.MediaPlayer2.Player.PlayPause')));
  assert.strictEqual(await m.seek(90), true);
  const seek = calls.find((c) => c.includes('SetPosition'));
  assert.ok(seek.includes("objectpath 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'") && seek.endsWith('int64 90000000'), seek);
  assert.strictEqual(await m.action('dance'), false);
});

test('no D-Bus tool at all: info() says so (null), nothing else runs', async () => {
  const m = new Mpris({ runner: async () => null });
  assert.strictEqual(await m.info(), null);
  assert.strictEqual(await m.seek(10), false);
});
