// Power actions for the dock's power menu: lock, switch user, log off,
// suspend (sleep), hibernate, restart, shut down. Only these verbs exist; the renderer cannot name a
// command. Each platform maps them to its own tools, and the runner is
// injectable so tests never touch the machine.
const { execFile } = require('child_process');

const ACTIONS = ['lock', 'switchuser', 'logout', 'sleep', 'hibernate', 'restart', 'shutdown'];

// [command, args] per action. Linux tries each candidate in order until one
// succeeds (desktops differ in which session tools they ship).
function commandsFor(action, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return {
      lock: [['rundll32.exe', ['user32.dll,LockWorkStation']]],
      // tsdiscon disconnects to the sign-in screen with the session kept
      // running (Fast User Switching); editions without it get the lock
      // screen, which offers "Switch user".
      switchuser: [['tsdiscon.exe', []], ['rundll32.exe', ['user32.dll,LockWorkStation']]],
      logout: [['shutdown.exe', ['/l']]],
      // SetSuspendState through .NET sleeps (not hibernates) when the OS allows it.
      sleep: [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"]]],
      // Needs hibernation turned on (powercfg /hibernate on); canHibernate() says.
      hibernate: [['shutdown.exe', ['/h']]],
      restart: [['shutdown.exe', ['/r', '/t', '0']]],
      shutdown: [['shutdown.exe', ['/s', '/t', '0']]]
    }[action] || null;
  }
  if (platform === 'linux') {
    const sid = env.XDG_SESSION_ID;
    return {
      lock: [['loginctl', ['lock-session']], ['xdg-screensaver', ['lock']], ['gnome-screensaver-command', ['-l']]],
      switchuser: [['gdmflexiserver', []], ['dm-tool', ['switch-to-greeter']], ['qdbus', ['org.kde.ksmserver', '/KSMServer', 'openSwitchUserDialog']]],
      logout: [
        ['gnome-session-quit', ['--logout', '--no-prompt']],
        ['qdbus', ['org.kde.ksmserver', '/KSMServer', 'logout', '0', '0', '0']],
        ['xfce4-session-logout', ['--logout']],
        ...(sid ? [['loginctl', ['terminate-session', sid]]] : [])
      ],
      sleep: [['systemctl', ['suspend']]],
      hibernate: [['systemctl', ['hibernate']]],
      restart: [['systemctl', ['reboot']]],
      shutdown: [['systemctl', ['poweroff']]]
    }[action] || null;
  }
  if (platform === 'darwin') {
    return {
      lock: [['pmset', ['displaysleepnow']]],
      switchuser: [['/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend']]],
      logout: [['osascript', ['-e', 'tell application "System Events" to log out']]],
      sleep: [['pmset', ['sleepnow']]],
      restart: [['osascript', ['-e', 'tell application "System Events" to restart']]],
      shutdown: [['osascript', ['-e', 'tell application "System Events" to shut down']]]
    }[action] || null;
  }
  return null;
}

const defaultRun = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, _out, stderr) => resolve(err ? { ok: false, error: String(stderr || err.message).trim().split('\n')[0] } : { ok: true }));
});

async function runPower(action, { run = defaultRun, platform = process.platform, env = process.env } = {}) {
  if (!ACTIONS.includes(action)) return { ok: false, error: `unknown power action "${action}"` };
  const list = commandsFor(action, platform, env);
  if (!list) return { ok: false, error: 'Power actions are not available on this platform.' };
  let last = null;
  for (const [cmd, args] of list) {
    last = await run(cmd, args);
    if (last && last.ok) return { ok: true, command: cmd };
  }
  return { ok: false, error: (last && last.error) || 'the command failed' };
}

// Can this machine hibernate right now? -> { ok: bool, why? }
// Windows: powercfg /a lists what is available ("Hibernate" before the
// "not available" section). Linux: logind's CanHibernate ("yes").
async function canHibernate({ platform = process.platform, exec = null } = {}) {
  const run = exec || ((cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, out) => resolve(err && !out ? null : String(out || '')))));
  if (platform === 'win32') {
    const out = await run('powercfg.exe', ['/a']);
    if (out == null) return { ok: false, why: 'Could not ask Windows whether hibernation is on.' };
    return parsePowercfg(out);
  }
  if (platform === 'linux') {
    const out = await run('busctl', ['call', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'CanHibernate']);
    if (out == null) return { ok: true };            // no logind answer: let systemctl try, and say why if it fails
    return /"yes"/.test(out) ? { ok: true } : { ok: false, why: 'Hibernation is not set up on this computer (it needs swap at least as big as memory).' };
  }
  return { ok: false, why: 'Hibernate is not available here.' };
}
function parsePowercfg(out) {
  const text = String(out || '');
  const cut = text.search(/not available|n'est pas disponible|nicht verf/i);
  const available = cut >= 0 ? text.slice(0, cut) : text;
  if (/^\s*Hibernate\s*$/im.test(available) || /^\s*Hibernate\b/im.test(available)) return { ok: true };
  return { ok: false, why: 'Hibernation is turned off. To turn it on: open Terminal as administrator and run  powercfg /hibernate on' };
}

module.exports = { ACTIONS, commandsFor, runPower, canHibernate, parsePowercfg };
