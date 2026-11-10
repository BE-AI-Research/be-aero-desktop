// Scheduled tasks: prompts the assistant runs without the user present.
//
// The model is BE-Code's (internal/schedule), which has run unattended jobs
// for a long time:
//   - A task's time is ONE readable `when` string: "in 20m", "at 09:00",
//     "at 2026-12-01 09:00", "every 30m", "daily 09:00", "weekdays 08:30",
//     "mon,thu 14:30", or a five-field cron expression. Small models write
//     these far more reliably than a nested schedule object.
//   - A one-off is due at its time until it has run; a recurring task is due
//     at the first time after its last run (or creation) - so a time missed
//     while the computer slept or the app was closed runs once, not never
//     and not many times.
//   - State is active | paused | done. A run records its outcome; failures
//     are counted and the task is paused after PAUSE_AFTER_FAILURES in a row.
//   - The loop sleeps until the next due time but never longer than a
//     minute, re-arming from the clock on every wake (suspend-safe).
//   - Runs go one at a time (a local model is not overloaded) with a
//     runtime cap, and are re-checked when they start.
// Pure parsing and timing are exported for tests.

const MAX_SLEEP_MS = 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ACTIVE = 20;
const PAUSE_AFTER_FAILURES = 3;
const DEFAULT_MAX_RUNTIME_MIN = 30;

const FORMS_HELP = 'use one of: in 20m · at 09:00 · at 2026-12-01 09:00 · every 30m · daily 09:00 · weekdays 09:00 · mon,thu 14:30 · a five-field cron expression';
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_ALIASES = { sunday: 'sun', monday: 'mon', tuesday: 'tue', tues: 'tue', wednesday: 'wed', thursday: 'thu', thur: 'thu', thurs: 'thu', friday: 'fri', saturday: 'sat' };

// ------------------------------------------------------------------ parsing
// "20m", "2h", "1h30m", "90s", "1d" -> ms
function parseDuration(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!/^(\d+(\.\d+)?(d|h|m|s|ms))+$/.test(t)) return null;
  let ms = 0;
  for (const [, n, u] of t.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)) {
    ms += Number(n) * { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 }[u];
  }
  return ms > 0 ? ms : null;
}

// "09:00", "9:30", "9am", "9:30pm", "21.15" -> { h, m }
function clockTime(s) {
  const t = String(s || '').trim().toLowerCase().replace(/\s+/g, '');
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/.exec(t);
  if (!m || (!m[2] && !m[3])) return null;
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
  }
  if (h > 23 || mi > 59) return null;
  return { h, m: mi };
}

// Forgiving rewrites of what models and people actually type, onto the
// canonical forms: "every 30 minutes" -> "every 30m", "daily at 9am" ->
// "daily 09:00", "every monday at 9" -> "mon 09:00", "weekends 10:00".
function normalizeWhen(s) {
  let t = String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  t = t.replace(/(\d+)\s*(milliseconds?|ms)\b/g, '$1ms')
    .replace(/(\d+(?:\.\d+)?)\s*(seconds?|secs?)\b/g, '$1s')
    .replace(/(\d+(?:\.\d+)?)\s*(minutes?|mins?)\b/g, '$1m')
    .replace(/(\d+(?:\.\d+)?)\s*(hours?|hrs?)\b/g, '$1h')
    .replace(/(\d+(?:\.\d+)?)\s*(days?)\b/g, '$1d')
    .replace(/(\d(?:ms|d|h|m|s))\s+(?=\d+(?:\.\d+)?(?:ms|d|h|m|s)\b)/g, '$1');   // "1h 30m" -> "1h30m"
  t = t.replace(/\bevery (hour|minute)\b/, (_m, u) => `every 1${u[0]}`);
  t = t.replace(/^(every day|each day)\b/, 'daily');
  t = t.replace(/^(every weekday|on weekdays)\b/, 'weekdays');
  t = t.replace(/^(every weekend|on weekends|weekends)\b/, 'sat,sun');
  for (const [long, short] of Object.entries(DAY_ALIASES)) t = t.replace(new RegExp(`\\b${long}s?\\b`, 'g'), short);
  t = t.replace(/^(?:every|on|each) ((?:sun|mon|tue|wed|thu|fri|sat)(?:\s*(?:,|and)\s*(?:sun|mon|tue|wed|thu|fri|sat))*)\b/, '$1');
  t = t.replace(/^((?:sun|mon|tue|wed|thu|fri|sat)(?:\s*(?:,|and)\s*(?:sun|mon|tue|wed|thu|fri|sat))*)/, (m) => m.replace(/\s*(?:,|and)\s*/g, ','));
  t = t.replace(/^(daily|weekdays|(?:sun|mon|tue|wed|thu|fri|sat)(?:,(?:sun|mon|tue|wed|thu|fri|sat))*) at /, '$1 ');
  t = t.replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/g, (_m, h, mi, ap) => `${h}:${mi || '00'}${ap}`);
  // "tomorrow 9:00" / "tomorrow at 9" -> at <date> <time>
  return t;
}

// The stored form: normalized, with 24-hour HH:MM times ("weekdays 08:30").
function canonicalWhen(when) {
  const n = normalizeWhen(when);
  return n.replace(/\b(\d{1,2})(?::(\d{2}))?(am|pm)\b/g, (m) => {
    const hm = clockTime(m);
    return hm ? `${String(hm.h).padStart(2, '0')}:${String(hm.m).padStart(2, '0')}` : m;
  }).replace(/\b(daily|weekdays|(?:sun|mon|tue|wed|thu|fri|sat)(?:,(?:sun|mon|tue|wed|thu|fri|sat))*|at) (\d):(\d{2})\b/g, '$1 0$2:$3');
}

// Day list "mon,thu" / "mon-fri" -> cron dow field, or null.
function dayList(s) {
  const out = [];
  for (const part of s.split(',')) {
    const r = part.split('-');
    const idx = r.map((d) => DAY_NAMES.indexOf(d));
    if (idx.some((i) => i < 0) || r.length > 2) return null;
    out.push(r.length === 2 ? `${idx[0]}-${idx[1]}` : String(idx[0]));
  }
  return out.join(',');
}

// Five-field cron: minute hour day-of-month month day-of-week.
function cronField(s, lo, hi) {
  const set = new Set();
  for (const part of s.split(',')) {
    let rng = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) throw new Error(`bad step in "${part}"`);
      rng = part.slice(0, slash);
    }
    let a = lo;
    let b = hi;
    if (rng !== '*') {
      if (rng.includes('-')) {
        const [x, y] = rng.split('-').map(Number);
        if (!Number.isInteger(x) || !Number.isInteger(y) || x > y) throw new Error(`bad range "${rng}"`);
        a = x; b = y;
      } else {
        const n = Number(rng);
        if (!Number.isInteger(n)) throw new Error(`bad value "${rng}"`);
        a = n; b = step === 1 ? n : hi;
      }
    }
    if (a < lo || b > hi) throw new Error(`"${part}" is outside ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

function parseCron(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`a cron expression has five fields, got ${f.length}`);
  const names = (x) => x.replace(/\b(sun|mon|tue|wed|thu|fri|sat)\b/g, (d) => String(DAY_NAMES.indexOf(d)));
  const e = {
    min: cronField(f[0], 0, 59), hour: cronField(f[1], 0, 23), dom: cronField(f[2], 1, 31),
    mon: cronField(f[3], 1, 12), dow: cronField(names(f[4]), 0, 7),
    domStar: f[2] === '*', dowStar: f[4] === '*'
  };
  if (e.dow.has(7)) e.dow.add(0);
  return e;
}

function cronDayMatches(e, d) {
  if (!e.mon.has(d.getMonth() + 1)) return false;
  const dom = e.dom.has(d.getDate());
  const dow = e.dow.has(d.getDay());
  return !e.domStar && !e.dowStar ? (dom || dow) : (dom && dow);
}

// First matching minute strictly after `after` (local time).
function cronNext(e, after) {
  const a = new Date(after);
  const day = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const hours = [...e.hour].sort((x, y) => x - y);
  const mins = [...e.min].sort((x, y) => x - y);
  for (let i = 0; i < 5 * 366; i++) {
    const d = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i);
    if (!cronDayMatches(e, d)) continue;
    for (const h of hours) {
      for (const m of mins) {
        const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
        if (t > after) return t;
      }
    }
  }
  return null;
}

// `when` -> spec. created anchors relative forms ("in 20m", "every 30m",
// "at 09:00"), so re-parsing a stored task with its own createdAt gives the
// same times. Throws with a helpful message.
function parseWhen(when, created) {
  const src = normalizeWhen(when);
  const f = src.split(' ').filter(Boolean);
  if (!f.length) throw new Error(`no time given; ${FORMS_HELP}`);
  const base = { src };
  if (f[0] === 'in' || f[0] === 'every') {
    if (f.length !== 2) throw new Error(`use: ${f[0]} <duration>, e.g. ${f[0]} 30m`);
    const d = parseDuration(f[1]);
    if (!d) throw new Error(`bad duration "${f[1]}" (examples: 20m, 2h, 1h30m)`);
    return f[0] === 'in' ? { ...base, kind: 'at', due: created + d } : { ...base, kind: 'every', every: d, anchor: created };
  }
  if (f[0] === 'at' || f[0] === 'on' || f[0] === 'tomorrow' || (f[0] === 'today' && f.length > 1)) {
    let rest = f.slice(f[0] === 'at' || f[0] === 'on' ? 1 : 0);
    if (rest[0] === 'at') rest = rest.slice(1);
    let date = null;
    if (rest[0] === 'tomorrow' || rest[0] === 'today') {
      const c = new Date(created);
      date = new Date(c.getFullYear(), c.getMonth(), c.getDate() + (rest[0] === 'tomorrow' ? 1 : 0));
      rest = rest.slice(1);
      if (rest[0] === 'at') rest = rest.slice(1);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(rest[0] || '')) {
      const [y, mo, d] = rest[0].split('-').map(Number);
      date = new Date(y, mo - 1, d);
      if (date.getMonth() !== mo - 1) throw new Error(`bad date "${rest[0]}" (use YYYY-MM-DD)`);
      rest = rest.slice(1);
      if (rest[0] === 'at') rest = rest.slice(1);
    } else if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/.test(rest[0] || '')) {    // ISO date-time
      const t = Date.parse(rest[0].toUpperCase());
      if (!Number.isFinite(t)) throw new Error(`bad date-time "${rest[0]}"`);
      return { ...base, kind: 'at', due: t };
    }
    if (rest.length !== 1) throw new Error('use: at HH:MM or at YYYY-MM-DD HH:MM');
    const hm = clockTime(rest[0]);
    if (!hm) throw new Error(`bad time "${rest[0]}" (use HH:MM, e.g. 09:00 or 9:30pm)`);
    if (date) return { ...base, kind: 'at', due: new Date(date.getFullYear(), date.getMonth(), date.getDate(), hm.h, hm.m).getTime() };
    const c = new Date(created);
    let t = new Date(c.getFullYear(), c.getMonth(), c.getDate(), hm.h, hm.m).getTime();
    if (t <= created) t = new Date(c.getFullYear(), c.getMonth(), c.getDate() + 1, hm.h, hm.m).getTime();
    return { ...base, kind: 'at', due: t };
  }
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/.test(f[0])) return parseWhen(`at ${f[0]}`, created);
  if (f[0] === 'daily' || f[0] === 'weekdays') {
    if (f.length !== 2) throw new Error(`use: ${f[0]} HH:MM`);
    const hm = clockTime(f[1]);
    if (!hm) throw new Error(`bad time "${f[1]}" (use HH:MM)`);
    return { ...base, kind: 'cron', cron: parseCron(`${hm.m} ${hm.h} * * ${f[0] === 'weekdays' ? '1-5' : '*'}`) };
  }
  const days = dayList(f[0]);
  if (days) {
    if (f.length !== 2) throw new Error(`use: ${f[0]} HH:MM`);
    const hm = clockTime(f[1]);
    if (!hm) throw new Error(`bad time "${f[1]}" (use HH:MM)`);
    return { ...base, kind: 'cron', cron: parseCron(`${hm.m} ${hm.h} * * ${days}`) };
  }
  if (f.length === 5) {
    try { return { ...base, kind: 'cron', cron: parseCron(f.join(' ')) }; } catch (err) { throw new Error(`cron: ${err.message}`); }
  }
  throw new Error(`"${String(when).trim()}" is not a time I know; ${FORMS_HELP}`);
}

const recurring = (spec) => spec.kind === 'every' || spec.kind === 'cron';

// First due time strictly after `after`.
function specNext(spec, after) {
  if (spec.kind === 'at') return spec.due > after ? spec.due : null;
  if (spec.kind === 'every') {
    if (after < spec.anchor) return spec.anchor + spec.every;
    return spec.anchor + (Math.floor((after - spec.anchor) / spec.every) + 1) * spec.every;
  }
  return cronNext(spec.cron, after);
}

function shortestGap(spec, from) {
  if (!recurring(spec)) return 0;
  if (spec.kind === 'every') return spec.every;
  let gap = 0;
  let prev = specNext(spec, from);
  for (let i = 0; prev && i < 60; i++) {
    const n = specNext(spec, prev);
    if (!n) break;
    if (!gap || n - prev < gap) gap = n - prev;
    prev = n;
  }
  return gap;
}

// When the task should next fire; null if never. A missed recurring time
// comes back as a time in the past: due now, once.
function nextDue(task) {
  if (!task || task.state !== 'active') return null;
  let spec;
  try { spec = parseWhen(task.when, task.createdAt); } catch { return null; }
  if (!recurring(spec)) return task.lastRun ? null : spec.due;
  return specNext(spec, task.lastRun || task.createdAt);
}

// Upcoming fire times for previews ("next: Mon 09:00, Tue 09:00, ...").
function upcoming(when, created, n = 3, now = Date.now()) {
  const spec = parseWhen(when, created);
  const out = [];
  let t = recurring(spec) ? specNext(spec, now) : spec.due;
  while (t && out.length < n) { out.push(t); if (!recurring(spec)) break; t = specNext(spec, t); }
  return out;
}

// ------------------------------------------------------------- migration
// Tasks saved before the `when` model: { schedule: { type, at, every, time, days } }.
function whenFromLegacy(s) {
  if (!s || typeof s !== 'object') return null;
  const pad = (n) => String(n).padStart(2, '0');
  if (s.type === 'once') {
    const d = new Date(s.at);
    if (!Number.isFinite(d.getTime())) return null;
    return `at ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (s.type === 'interval') return `every ${Math.max(5, Number(s.every) || 60)}m`;
  const hm = clockTime(s.time);
  if (!hm) return null;
  const time = `${pad(hm.h)}:${pad(hm.m)}`;
  if (s.type === 'daily') return `daily ${time}`;
  if (s.type === 'weekly') {
    const days = (Array.isArray(s.days) && s.days.length ? s.days : [1, 2, 3, 4, 5]).map(Number).sort();
    if (days.join() === '1,2,3,4,5') return `weekdays ${time}`;
    if (days.length === 7) return `daily ${time}`;
    return `${days.map((d) => DAY_NAMES[d]).join(',')} ${time}`;
  }
  return null;
}

// Any stored shape -> the current one (idempotent).
function normalizeTask(t) {
  if (!t || typeof t !== 'object') return t;
  const out = { ...t };
  if (!out.when && out.schedule) out.when = whenFromLegacy(out.schedule) || '';
  delete out.schedule;
  if (!out.state) out.state = out.enabled === false ? 'paused' : 'active';
  if (out.state === 'active' && out.enabled === false) out.state = 'paused';
  delete out.enabled;
  if (out.lastStatus && !out.lastOutcome) out.lastOutcome = out.lastStatus === 'done' ? 'ok' : out.lastStatus;
  delete out.lastStatus;
  if (out.lastOutcome === 'running') out.lastOutcome = 'interrupted';   // the app closed mid-run
  out.failures = Number(out.failures) || 0;
  out.createdAt = Number(out.createdAt) || Date.now();
  out.createdBy = out.createdBy || 'person';
  return out;
}

function validateTask(t, { now = Date.now(), activeCount = 0 } = {}) {
  if (!t || typeof t !== 'object') return 'task must be an object';
  if (!t.name || typeof t.name !== 'string' || !t.name.trim()) return 'name required';
  if (!t.prompt || typeof t.prompt !== 'string' || !t.prompt.trim()) return 'prompt required';
  if (!t.when || typeof t.when !== 'string') return `when required; ${FORMS_HELP}`;
  let spec;
  try { spec = parseWhen(t.when, t.createdAt || now); } catch (err) { return err.message; }
  if (recurring(spec) && shortestGap(spec, now) < MIN_INTERVAL_MS) return 'runs more often than every 5 minutes; choose a longer interval';
  if (!recurring(spec) && spec.due < now - 60000 && !t.lastRun) return 'that time has already passed';
  if (t.permission && !['inherit', 'allow', 'deny'].includes(t.permission)) return 'permission must be inherit | allow | deny';
  if (t.conversationMode && !['shared', 'new'].includes(t.conversationMode)) return 'conversationMode must be shared | new';
  if (t.state === 'active' && activeCount >= MAX_ACTIVE) return `at most ${MAX_ACTIVE} active tasks`;
  return null;
}

// Human summary for lists.
function describeWhen(when) {
  const w = canonicalWhen(when);
  return w || 'unscheduled';
}

// Outcome of one run -> short text; "ok" resets the failure count.
function outcomeOf(result, { timedOut = false } = {}) {
  if (timedOut) return 'timed out';
  if (!result) return 'error: no result';
  if (result.error) return `error: ${String(result.error).split('\n')[0].slice(0, 120)}`;
  if (result.stopped) return 'cancelled';
  if (result.refusal) return 'refused by the model';
  if (result.truncated) return 'stopped at the tool-step limit';
  return 'ok';
}

// ---------------------------------------------------------------- runner
class TaskScheduler {
  // deps: { getTasks(): [], saveTasks(list), run(task, { scheduled, signal }): Promise<result>,
  //         now?: () => ms, onChange?: (list) => void, notify?: (title, body) => void, maxRuntimeMin?: () => n }
  constructor(deps) {
    this.d = deps;
    this.now = deps.now || (() => Date.now());
    this.queue = [];              // task ids waiting to run, in order
    this.queued = new Set();
    this.running = null;          // { id, controller }
    this.timer = null;
    this.stopped = true;
  }

  tasks() { return (this.d.getTasks() || []).map(normalizeTask); }

  save(list) { this.d.saveTasks(list); }

  start() {
    this.stopped = false;
    // Bring stored tasks onto the current model once.
    const raw = this.d.getTasks() || [];
    const norm = raw.map(normalizeTask);
    if (JSON.stringify(raw) !== JSON.stringify(norm)) this.save(norm);
    this.arm(5000);   // soon after startup: anything missed while away runs once
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  // Sleep until the next due time, capped at a minute; every wake re-reads
  // the clock, so a suspend or clock jump runs a skipped time at most once.
  arm(ms) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.pass(); }, Math.max(250, Math.min(MAX_SLEEP_MS, ms)));
  }

  pass() {
    if (this.stopped) return;
    const now = this.now();
    let nearest = Infinity;
    for (const t of this.tasks()) {
      const due = nextDue(t);
      if (due == null) continue;
      if (due <= now) this.enqueue(t.id);
      else nearest = Math.min(nearest, due);
    }
    this.arm(nearest === Infinity ? MAX_SLEEP_MS : nearest - now);
  }

  enqueue(id) {
    if (this.queued.has(id) || (this.running && this.running.id === id)) return false;
    this.queued.add(id);
    this.queue.push(id);
    this.drain();
    return true;
  }

  async drain() {
    if (this.running || !this.queue.length) return;
    const id = this.queue.shift();
    this.queued.delete(id);
    await this.execute(id, { scheduled: true });
    this.drain();
  }

  list() {
    return this.tasks().map((t) => {
      let next = null;
      let error = null;
      try { next = nextDue(t); } catch (err) { error = err.message; }
      if (t.when) { try { parseWhen(t.when, t.createdAt); } catch (err) { error = err.message; } }
      return {
        ...t,
        enabled: t.state === 'active',
        summary: describeWhen(t.when),
        nextRun: next,
        lastStatus: t.lastOutcome || null,
        running: !!(this.running && this.running.id === t.id),
        queued: this.queued.has(t.id),
        whenError: error
      };
    });
  }

  // Create (no id) or update. A changed `when` starts fresh (new anchor).
  upsert(input, { createdBy = 'person' } = {}) {
    const tasks = this.tasks();
    const id = input.id || 't' + Math.random().toString(36).slice(2, 10);
    const i = tasks.findIndex((t) => t.id === id);
    if (input.id && i < 0) throw new Error(`no task ${input.id}`);
    const prev = i >= 0 ? tasks[i] : null;
    let when = input.when;
    if (!when && input.schedule) when = whenFromLegacy(input.schedule);   // older callers
    const now = this.now();
    const next = normalizeTask({
      ...(prev || {}),
      ...input,
      id,
      when: when != null ? canonicalWhen(String(when).trim()) : (prev && prev.when),
      state: input.state || (prev ? (prev.state === 'done' ? 'active' : prev.state) : 'active'),
      permission: input.permission || (prev && prev.permission) || 'inherit',
      conversationMode: input.conversationMode || (prev && prev.conversationMode) || 'shared',
      createdBy: prev ? prev.createdBy : createdBy,
      createdAt: prev ? prev.createdAt : now
    });
    delete next.schedule;
    if (prev && normalizeWhen(prev.when) !== normalizeWhen(next.when)) {
      next.createdAt = now;           // re-anchor relative forms
      next.lastRun = 0;
      next.failures = 0;
      next.lastOutcome = null;
      if (next.state === 'done') next.state = 'active';
    }
    const activeCount = tasks.filter((t) => t.state === 'active' && t.id !== id).length;
    const err = validateTask(next, { now, activeCount });
    if (err) throw new Error(err);
    if (i >= 0) tasks[i] = next; else tasks.push(next);
    this.save(tasks);
    this.changed();
    this.arm(0);
    return next;
  }

  remove(id) {
    if (this.running && this.running.id === id) this.running.controller.abort();
    this.queue = this.queue.filter((x) => x !== id);
    this.queued.delete(id);
    this.save(this.tasks().filter((t) => t.id !== id));
    this.changed();
  }

  // Pause / resume (and the legacy { enabled } toggle). Resuming a task that
  // missed times while paused does not replay them: it starts from now.
  setState(id, state) {
    const tasks = this.tasks();
    const t = tasks.find((x) => x.id === id);
    if (!t) return null;
    if (state === 'active' && t.state !== 'active') {
      const activeCount = tasks.filter((x) => x.state === 'active').length;
      if (activeCount >= MAX_ACTIVE) throw new Error(`at most ${MAX_ACTIVE} active tasks`);
      t.failures = 0;
      let spec = null;
      try { spec = parseWhen(t.when, t.createdAt); } catch { /* reported in list */ }
      if (spec && recurring(spec)) t.lastRun = Math.max(t.lastRun || 0, this.now());
    }
    t.state = state;
    this.save(tasks);
    this.changed();
    this.arm(0);
    return t;
  }

  patch(id, fields) {
    if (fields && 'enabled' in fields && Object.keys(fields).length === 1) return this.setState(id, fields.enabled ? 'active' : 'paused');
    const tasks = this.tasks().map((t) => (t.id === id ? normalizeTask({ ...t, ...fields }) : t));
    this.save(tasks);
    this.changed();
    return tasks.find((t) => t.id === id) || null;
  }

  changed() { if (this.d.onChange) this.d.onChange(this.list()); }

  // A person's "run now": runs even a paused task, ahead of the queue.
  async runTask(id) {
    if (this.running && this.running.id === id) return { error: 'already running' };
    if (!this.tasks().some((t) => t.id === id)) return { error: 'no such task' };
    if (this.running) { this.queue.unshift(id); this.queued.add(id); return { queued: true }; }
    return this.execute(id, { scheduled: false });
  }

  async execute(id, { scheduled }) {
    // Re-check at start: the task may have been edited, paused or deleted
    // since it was queued.
    const task = this.tasks().find((t) => t.id === id);
    if (!task) return { error: 'no such task' };
    if (scheduled) {
      const due = nextDue(task);
      if (task.state !== 'active' || due == null || due > this.now()) return { skipped: true };
    }
    const controller = new AbortController();
    this.running = { id, controller };
    const cfgMin = Number(this.d.maxRuntimeMin ? this.d.maxRuntimeMin() : DEFAULT_MAX_RUNTIME_MIN);
    const maxMin = cfgMin > 0 ? cfgMin : DEFAULT_MAX_RUNTIME_MIN;
    let timedOut = false;
    const cap = setTimeout(() => { timedOut = true; controller.abort(); }, maxMin * 60 * 1000);
    this.patch(id, { lastRun: this.now() });
    let result;
    try {
      result = await this.d.run(task, { scheduled, signal: controller.signal });
    } catch (err) {
      result = { error: err && err.message || String(err) };
    } finally {
      clearTimeout(cap);
      this.running = null;
    }
    this.finish(id, outcomeOf(result, { timedOut }), result);
    this.arm(0);
    return result;
  }

  finish(id, outcome, result) {
    const tasks = this.tasks();
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    t.lastOutcome = outcome;
    t.lastFinished = this.now();
    if (result && result.conversationId) t.conversationId = result.conversationId;
    t.failures = outcome === 'ok' ? 0 : (t.failures || 0) + 1;
    let paused = false;
    let spec = null;
    try { spec = parseWhen(t.when, t.createdAt); } catch { /* keep state */ }
    if (spec && !recurring(spec)) t.state = 'done';
    else if (t.failures >= PAUSE_AFTER_FAILURES && t.state === 'active') { t.state = 'paused'; paused = true; }
    this.save(tasks);
    this.changed();
    if (paused && this.d.notify) this.d.notify(`Task "${t.name}" paused`, `It failed ${t.failures} times in a row (last: ${outcome}). Fix it and resume it in the AI chat's Tasks tab.`);
  }
}

module.exports = {
  TaskScheduler, parseWhen, normalizeWhen, canonicalWhen, parseDuration, clockTime, parseCron, cronNext, specNext, nextDue, upcoming,
  shortestGap, whenFromLegacy, normalizeTask, validateTask, describeWhen, outcomeOf,
  FORMS_HELP, MIN_INTERVAL_MS, MAX_ACTIVE, PAUSE_AFTER_FAILURES, MAX_SLEEP_MS
};
