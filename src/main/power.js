// Power actions for the dock's power menu: lock, switch user, log off,
// sleep, restart, shut down. Only these six verbs exist; the renderer cannot name a
// command. Each platform maps them to its own tools, and the runner is
// injectable so tests never touch the machine.
const { execFile } = require('child_process');

const ACTIONS = ['lock', 'switchuser', 'logout', 'sleep', 'restart', 'shutdown'];

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

module.exports = { ACTIONS, commandsFor, runPower };
