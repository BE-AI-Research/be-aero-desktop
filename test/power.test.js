const test = require('node:test');
const assert = require('node:assert');
const { ACTIONS, commandsFor, runPower, parsePowercfg } = require('../src/main/power');

test('every action has a command on Windows, Linux and macOS', () => {
  for (const p of ['win32', 'linux', 'darwin']) {
    for (const a of ACTIONS) {
      if (p === 'darwin' && a === 'hibernate') continue;      // macOS has no plain hibernate command
      const list = commandsFor(a, p, { XDG_SESSION_ID: '3' });
      assert.ok(Array.isArray(list) && list.length >= 1, `${p}/${a}`);
    }
  }
  assert.deepStrictEqual(commandsFor('shutdown', 'win32')[0], ['shutdown.exe', ['/s', '/t', '0']]);
  assert.deepStrictEqual(commandsFor('restart', 'linux')[0], ['systemctl', ['reboot']]);
  assert.deepStrictEqual(commandsFor('switchuser', 'win32').map((c) => c[0]), ['tsdiscon.exe', 'rundll32.exe'], 'falls back to the lock screen');
  assert.deepStrictEqual(commandsFor('logout', 'win32')[0], ['shutdown.exe', ['/l']]);
  assert.ok(ACTIONS.includes('switchuser') && ACTIONS.includes('hibernate') && ACTIONS.length === 7);
  assert.deepStrictEqual(commandsFor('hibernate', 'win32')[0], ['shutdown.exe', ['/h']]);
  assert.deepStrictEqual(commandsFor('hibernate', 'linux')[0], ['systemctl', ['hibernate']]);
});

test('unknown actions never reach a command runner', async () => {
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, args]); return { ok: true }; };
  for (const bad of ['format', 'shutdown /s && del', '', 'rm']) {
    const r = await runPower(bad, { run, platform: 'win32' });
    assert.strictEqual(r.ok, false);
  }
  assert.strictEqual(calls.length, 0);
});

test('Linux tries session tools in order until one works', async () => {
  const calls = [];
  const run = async (cmd) => { calls.push(cmd); return cmd === 'xfce4-session-logout' ? { ok: true } : { ok: false, error: `${cmd}: not found` }; };
  const r = await runPower('logout', { run, platform: 'linux', env: { XDG_SESSION_ID: '7' } });
  assert.deepStrictEqual(r, { ok: true, command: 'xfce4-session-logout' });
  assert.deepStrictEqual(calls, ['gnome-session-quit', 'qdbus', 'xfce4-session-logout']);
  const fail = await runPower('sleep', { run: async () => ({ ok: false, error: 'Access denied' }), platform: 'linux', env: {} });
  assert.deepStrictEqual(fail, { ok: false, error: 'Access denied' });
});

test('unsupported platform says so', async () => {
  const r = await runPower('lock', { run: async () => ({ ok: true }), platform: 'aix' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not available/);
});

test('hibernate availability is read from powercfg /a', () => {
  const off = [
    'The following sleep states are available on this system:', '    Standby (S3)', '',
    'The following sleep states are not available on this system:', '    Hibernate', '\tHibernation has not been enabled.'
  ].join('\n');
  const on = [
    'The following sleep states are available on this system:', '    Standby (S3)', '    Hibernate', '    Fast Startup', '',
    'The following sleep states are not available on this system:', '    Standby (S1)'
  ].join('\n');
  assert.strictEqual(parsePowercfg(off).ok, false);
  assert.match(parsePowercfg(off).why, /powercfg \/hibernate on/);
  assert.strictEqual(parsePowercfg(on).ok, true);
});
