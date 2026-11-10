// UAC shield for the dock (Windows).
//
// Two things the dock can know about User Account Control:
//   - Whether an elevation prompt is open: consent.exe runs for exactly as
//     long as a prompt is up. On the default settings the prompt itself is on
//     the secure desktop, where no app (the dock included) can draw; when
//     Windows holds a prompt back (a background program asked), consent.exe
//     has a visible window on the normal desktop that can be brought forward.
//   - The prompt level: the same two policy values the Windows UAC slider
//     writes. Reading them needs no rights; changing them is a machine-wide
//     security setting, so it runs elevated (one UAC prompt) and is checked
//     back afterwards.
const { execFile } = require('child_process');

const KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';

// The Windows slider's four positions.
const LEVELS = Object.freeze({
  always: { label: 'Always notify', admin: 2, secure: 1 },
  default: { label: 'Notify when apps make changes (Windows default)', admin: 5, secure: 1 },
  nodim: { label: "Notify when apps make changes, don't dim the desktop", admin: 5, secure: 0 },
  never: { label: 'Never notify (not recommended)', admin: 0, secure: 0 }
});

// `reg query` output -> { EnableLUA, ConsentPromptBehaviorAdmin, PromptOnSecureDesktop }
function parseRegQuery(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s+(EnableLUA|ConsentPromptBehaviorAdmin|PromptOnSecureDesktop)\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    if (m) out[m[1]] = parseInt(m[2], 16);
  }
  return out;
}

// Policy values -> 'always' | 'default' | 'nodim' | 'never' | 'off' | 'custom' | 'unknown'
function levelOf(v) {
  if (!v || v.ConsentPromptBehaviorAdmin === undefined) return 'unknown';
  if (v.EnableLUA === 0) return 'off';
  const secure = v.PromptOnSecureDesktop === undefined ? 1 : v.PromptOnSecureDesktop;
  for (const [id, L] of Object.entries(LEVELS)) {
    if (L.admin === v.ConsentPromptBehaviorAdmin && L.secure === secure) return id;
  }
  return 'custom';
}

function labelOf(level) {
  if (LEVELS[level]) return LEVELS[level].label;
  if (level === 'off') return 'UAC is turned off';
  if (level === 'custom') return 'Custom (set by policy or by hand)';
  return 'Unknown';
}

function run(file, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || '') }));
  });
}

async function readValues() {
  const r = await run('reg', ['query', KEY]);
  return parseRegQuery(r.stdout);
}

// The elevated command that applies one level: both values, nothing else.
function levelCommand(level) {
  const L = LEVELS[level];
  if (!L) return null;
  return `reg add ${KEY} /v ConsentPromptBehaviorAdmin /t REG_DWORD /d ${L.admin} /f && reg add ${KEY} /v PromptOnSecureDesktop /t REG_DWORD /d ${L.secure} /f`;
}

class UacMonitor {
  // { taskWindows, onChange(state), interval? }
  constructor({ taskWindows, onChange, interval = 1500 }) {
    this.tw = taskWindows;
    this.onChange = onChange || (() => {});
    this.interval = interval;
    this.open = false;
    this.waitingHwnd = 0;
    this.values = {};
    this.level = 'unknown';
    this.busy = false;
    this.timer = null;
    this.levelTimer = null;
  }

  state() {
    return { supported: true, open: this.open, waiting: !!this.waitingHwnd, level: this.level, levelLabel: labelOf(this.level), busy: this.busy };
  }

  start() {
    if (this.timer) return;
    this.refreshLevel();
    this.timer = setInterval(() => this.poll(), this.interval);
    // The level can change elsewhere (the Windows slider, policy).
    this.levelTimer = setInterval(() => this.refreshLevel(), 60000);
  }

  stop() {
    clearInterval(this.timer); clearInterval(this.levelTimer);
    this.timer = null; this.levelTimer = null;
  }

  async refreshLevel() {
    try {
      this.values = await readValues();
      const lv = levelOf(this.values);
      if (lv !== this.level) { this.level = lv; this.onChange(this.state()); }
    } catch { /* keep the last known */ }
    return this.level;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const line = await this.tw.send('uac');
      if (!line) return;
      let r;
      try { r = JSON.parse(line); } catch { return; }
      const open = Number(r.count) > 0;
      const hwnd = open ? Number(r.hwnd) || 0 : 0;
      if (open !== this.open || hwnd !== this.waitingHwnd) {
        const closed = this.open && !open;
        this.open = open;
        this.waitingHwnd = hwnd;
        this.onChange(this.state());
        // A prompt just answered may have been the level change.
        if (closed) this.refreshLevel();
      }
    } finally { this.polling = false; }
  }

  // A prompt Windows is holding back: activating its window shows it.
  bringForward() {
    if (!this.waitingHwnd) return Promise.resolve(false);
    return this.tw.action('activate', this.waitingHwnd);
  }

  // -> { ok, level } or { error, cancelled? }
  async setLevel(level) {
    const cmd = levelCommand(level);
    if (!cmd) return { error: 'unknown level' };
    if (this.busy) return { error: 'a change is already waiting for approval' };
    this.busy = true;
    this.onChange(this.state());
    try {
      // 1223 = ERROR_CANCELLED: No on the prompt.
      const ps = `try { $p = Start-Process -FilePath cmd.exe -ArgumentList '/c ${cmd}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode } catch { exit 1223 }`;
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 180000);
      const now = await this.refreshLevel();
      if (now === level) return { ok: true, level };
      if (r.code === 1223) return { error: 'The change was not approved.', cancelled: true };
      return { error: `Windows did not apply the change (exit ${r.code}).` };
    } finally {
      this.busy = false;
      this.onChange(this.state());
    }
  }
}

module.exports = { UacMonitor, LEVELS, parseRegQuery, levelOf, labelOf, levelCommand, KEY };
