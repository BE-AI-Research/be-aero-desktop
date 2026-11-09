// Task queue: prompts that run on a schedule without the user present.
//
// Schedules: once (at an ISO date-time), interval (every N minutes), daily
// (at HH:MM), weekly (at HH:MM on chosen weekdays). Pure scheduling math is
// exported for tests; the TaskScheduler class only ticks and delegates the
// actual run to the AI service.
const TICK_MS = 30 * 1000;
const CATCH_UP_MS = 60 * 60 * 1000;   // a daily/weekly slot missed by less than this still runs

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

function atTimeOn(dayStart, hm) {
  const d = new Date(dayStart);
  d.setHours(hm.h, hm.mi, 0, 0);
  return d.getTime();
}

// Next moment the task should run, or null when it never will again.
function nextRunFor(task, now, lastRun) {
  const s = task.schedule || {};
  const last = Number(lastRun) || 0;
  if (s.type === 'once') {
    const at = Date.parse(s.at);
    if (!Number.isFinite(at) || last >= at) return null;
    return at;                                  // overdue "once" runs as soon as it can
  }
  if (s.type === 'interval') {
    const every = Math.max(1, Number(s.every) || 60) * 60 * 1000;
    const base = last || Number(task.createdAt) || now;
    return base + every;                         // first run one interval after creation
  }
  if (s.type === 'daily' || s.type === 'weekly') {
    const hm = parseHHMM(s.time);
    if (!hm) return null;
    const days = s.type === 'weekly' ? (Array.isArray(s.days) && s.days.length ? s.days.map(Number) : [1, 2, 3, 4, 5]) : null;
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    for (let i = -1; i <= 8; i++) {
      const dayStart = new Date(today); dayStart.setDate(today.getDate() + i);
      if (days && !days.includes(dayStart.getDay())) continue;
      const slot = atTimeOn(dayStart, hm);
      if (last >= slot) continue;                      // already ran this slot
      if (slot <= now) {
        if (now - slot <= CATCH_UP_MS) return slot;      // missed by a little: run now
        continue;                                        // missed by a lot: skip the slot
      }
      return slot;
    }
    return null;
  }
  return null;
}

function describeSchedule(task) {
  const s = task.schedule || {};
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (s.type === 'once') return `once at ${new Date(s.at).toLocaleString()}`;
  if (s.type === 'interval') return `every ${Number(s.every) || 60} min`;
  if (s.type === 'daily') return `daily at ${s.time}`;
  if (s.type === 'weekly') return `${(s.days || [1, 2, 3, 4, 5]).map((d) => names[d]).join(', ')} at ${s.time}`;
  return 'unscheduled';
}

function validateTask(t) {
  if (!t || typeof t !== 'object') return 'task must be an object';
  if (!t.name || typeof t.name !== 'string') return 'name required';
  if (!t.prompt || typeof t.prompt !== 'string') return 'prompt required';
  const s = t.schedule || {};
  if (s.type === 'once') { if (!Number.isFinite(Date.parse(s.at))) return 'once needs a valid date-time (at)'; }
  else if (s.type === 'interval') { if (!(Number(s.every) >= 1)) return 'interval needs every >= 1 (minutes)'; }
  else if (s.type === 'daily') { if (!parseHHMM(s.time)) return 'daily needs time HH:MM'; }
  else if (s.type === 'weekly') { if (!parseHHMM(s.time)) return 'weekly needs time HH:MM'; }
  else return 'schedule.type must be once | interval | daily | weekly';
  if (t.permission && !['inherit', 'allow', 'deny'].includes(t.permission)) return 'permission must be inherit | allow | deny';
  if (t.conversationMode && !['shared', 'new'].includes(t.conversationMode)) return 'conversationMode must be shared | new';
  return null;
}

class TaskScheduler {
  // { getTasks(): [], saveTasks(list), run(task, info): Promise<{error?, conversationId?}>, now?: () => ms, onChange?: (list) => void }
  constructor(deps) {
    this.d = deps;
    this.now = deps.now || (() => Date.now());
    this.running = new Set();
    this.timer = null;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    setTimeout(() => this.tick().catch(() => {}), 5000);  // soon after startup (catch-up)
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list() {
    const now = this.now();
    return this.d.getTasks().map((t) => ({
      ...t,
      summary: describeSchedule(t),
      nextRun: t.enabled === false ? null : nextRunFor(t, now, t.lastRun),
      running: this.running.has(t.id)
    }));
  }

  upsert(task) {
    const err = validateTask(task);
    if (err) throw new Error(err);
    const tasks = this.d.getTasks().slice();
    const id = task.id || 't' + Math.random().toString(36).slice(2, 10);
    const i = tasks.findIndex((t) => t.id === id);
    const prev = i >= 0 ? tasks[i] : {};
    const next = {
      ...prev, ...task, id,
      enabled: task.enabled !== false,
      permission: task.permission || prev.permission || 'inherit',
      conversationMode: task.conversationMode || prev.conversationMode || 'shared',
      createdAt: prev.createdAt || this.now()
    };
    // A changed schedule starts fresh.
    if (i >= 0 && JSON.stringify(prev.schedule) !== JSON.stringify(next.schedule)) { next.lastRun = 0; next.lastStatus = null; }
    if (i >= 0) tasks[i] = next; else tasks.push(next);
    this.d.saveTasks(tasks);
    this.changed();
    return next;
  }

  remove(id) {
    this.d.saveTasks(this.d.getTasks().filter((t) => t.id !== id));
    this.changed();
  }

  patch(id, fields) {
    const tasks = this.d.getTasks().map((t) => (t.id === id ? { ...t, ...fields } : t));
    this.d.saveTasks(tasks);
    this.changed();
    return tasks.find((t) => t.id === id) || null;
  }

  changed() {
    if (this.d.onChange) this.d.onChange(this.list());
  }

  async tick() {
    const now = this.now();
    for (const task of this.d.getTasks()) {
      if (task.enabled === false || this.running.has(task.id)) continue;
      const due = nextRunFor(task, now, task.lastRun);
      if (due !== null && due <= now) await this.runTask(task.id, { scheduled: true });
    }
  }

  async runTask(id, { scheduled = false } = {}) {
    const task = this.d.getTasks().find((t) => t.id === id);
    if (!task || this.running.has(id)) return { error: task ? 'already running' : 'no such task' };
    this.running.add(id);
    const startedAt = this.now();
    this.patch(id, { lastRun: startedAt, lastStatus: 'running' });
    let result;
    try {
      result = await this.d.run(task, { scheduled });
    } catch (err) {
      result = { error: err && err.message || String(err) };
    } finally {
      this.running.delete(id);
    }
    const fields = { lastStatus: result && result.error ? `error: ${result.error}` : 'done', lastFinished: this.now() };
    if (task.schedule && task.schedule.type === 'once') fields.enabled = false;   // one-shot
    if (result && result.conversationId) fields.conversationId = result.conversationId;
    this.patch(id, fields);
    return result;
  }
}

module.exports = { TaskScheduler, nextRunFor, describeSchedule, validateTask, parseHHMM, TICK_MS, CATCH_UP_MS };
