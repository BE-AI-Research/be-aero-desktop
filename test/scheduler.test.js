const test = require('node:test');
const assert = require('node:assert');
const sched = require('../src/main/ai/scheduler');

// Local-time helper: '2026-11-09T09:00' -> ms
const at = (s) => new Date(s).getTime();
const NOW = at('2026-11-09T10:00:00');   // a Monday

test('when forms parse (BE-Code vocabulary) and give the right next times', () => {
  const next = (w, created = NOW) => sched.upcoming(w, created, 3, NOW);
  assert.deepStrictEqual(next('in 20m'), [NOW + 20 * 60000]);
  assert.deepStrictEqual(next('at 09:00'), [at('2026-11-10T09:00')], 'past clock time today -> tomorrow');
  assert.deepStrictEqual(next('at 2026-12-01 09:00'), [at('2026-12-01T09:00')]);
  assert.deepStrictEqual(next('every 30m'), [NOW + 30 * 60000, NOW + 60 * 60000, NOW + 90 * 60000]);
  assert.deepStrictEqual(next('daily 09:00'), [at('2026-11-10T09:00'), at('2026-11-11T09:00'), at('2026-11-12T09:00')]);
  assert.deepStrictEqual(next('weekdays 08:30'), [at('2026-11-10T08:30'), at('2026-11-11T08:30'), at('2026-11-12T08:30')]);
  assert.deepStrictEqual(next('mon,thu 14:30'), [at('2026-11-09T14:30'), at('2026-11-12T14:30'), at('2026-11-16T14:30')]);
  assert.deepStrictEqual(next('0 */4 * * *'), [at('2026-11-09T12:00'), at('2026-11-09T16:00'), at('2026-11-09T20:00')]);
  assert.deepStrictEqual(next('sat,sun 10:00'), [at('2026-11-14T10:00'), at('2026-11-15T10:00'), at('2026-11-21T10:00')]);
});

test('forgiving input: what models and people actually type', () => {
  const same = (a, b) => assert.deepStrictEqual(sched.upcoming(a, NOW, 2, NOW), sched.upcoming(b, NOW, 2, NOW), `${a} == ${b}`);
  same('every 30 minutes', 'every 30m');
  same('every 2 hours', 'every 2h');
  same('every 1h 30m', 'every 1h30m');
  same('daily at 9am', 'daily 09:00');
  same('every day at 9:00', 'daily 09:00');
  same('every weekday at 8:30 am', 'weekdays 08:30');
  same('every Monday and Thursday at 2:30pm', 'mon,thu 14:30');
  same('weekends 10:00', 'sat,sun 10:00');
  same('in 1 hour', 'in 1h');
  assert.deepStrictEqual(sched.upcoming('tomorrow at 7am', NOW, 1, NOW), [at('2026-11-10T07:00')]);
  assert.deepStrictEqual(sched.upcoming('2026-11-20T18:00', NOW, 1, NOW), [at('2026-11-20T18:00')]);
});

test('bad input is refused with a helpful message', () => {
  assert.throws(() => sched.parseWhen('sometimes', NOW), /not a time I know; use one of: in 20m/);
  assert.throws(() => sched.parseWhen('every banana', NOW), /bad duration/);
  assert.throws(() => sched.parseWhen('daily 25:00', NOW), /bad time/);
  assert.throws(() => sched.parseWhen('61 * * * *', NOW), /cron: minute|outside/);
  const v = (t) => sched.validateTask({ name: 'n', prompt: 'p', createdAt: NOW, ...t }, { now: NOW });
  assert.match(v({ when: 'every 1m' }), /more often than every 5 minutes/);
  assert.match(v({ when: '* * * * *' }), /more often than every 5 minutes/);
  assert.match(v({ when: 'at 2026-11-01 09:00' }), /already passed/);
  assert.strictEqual(v({ when: 'every 5m' }), null);
  assert.match(v({ when: '' }), /when required/);
});

test('nextDue: a missed recurring time is due now, once; one-offs run once', () => {
  const task = (when, extra) => ({ id: 't', when, state: 'active', createdAt: at('2026-11-07T08:00'), ...extra });
  // Created Saturday 08:00, daily 09:00, never run: the first slot (Saturday 09:00) was missed -> due now, once.
  assert.strictEqual(sched.nextDue(task('daily 09:00')), at('2026-11-07T09:00'));
  // It ran Sunday at 09:00, then the computer was off until Monday 10:00: Monday 09:00 is due now.
  assert.strictEqual(sched.nextDue(task('daily 09:00', { lastRun: at('2026-11-08T09:00') })), at('2026-11-09T09:00'));
  // After running at 10:00 today, the next is tomorrow - missed slots are not replayed.
  assert.strictEqual(sched.nextDue(task('daily 09:00', { lastRun: NOW })), at('2026-11-10T09:00'));
  assert.strictEqual(sched.nextDue(task('at 2026-11-08 12:00')), at('2026-11-08T12:00'), 'overdue one-off is due');
  assert.strictEqual(sched.nextDue(task('at 2026-11-08 12:00', { lastRun: NOW })), null, 'one-off ran');
  assert.strictEqual(sched.nextDue(task('daily 09:00', { state: 'paused' })), null);
  assert.strictEqual(sched.nextDue(task('nonsense')), null);
});

test('legacy schedule objects migrate to when strings', () => {
  assert.strictEqual(sched.whenFromLegacy({ type: 'daily', time: '9:05' }), 'daily 09:05');
  assert.strictEqual(sched.whenFromLegacy({ type: 'weekly', time: '08:00', days: [1, 2, 3, 4, 5] }), 'weekdays 08:00');
  assert.strictEqual(sched.whenFromLegacy({ type: 'weekly', time: '08:00', days: [1, 4] }), 'mon,thu 08:00');
  assert.strictEqual(sched.whenFromLegacy({ type: 'interval', every: 2 }), 'every 5m', 'raised to the minimum');
  assert.strictEqual(sched.whenFromLegacy({ type: 'once', at: '2026-12-01T09:00:00' }), 'at 2026-12-01 09:00');
  const t = sched.normalizeTask({ id: 'a', name: 'x', prompt: 'y', schedule: { type: 'daily', time: '09:00' }, enabled: false, lastStatus: 'running' });
  assert.deepStrictEqual([t.when, t.state, t.lastOutcome, 'schedule' in t, 'enabled' in t], ['daily 09:00', 'paused', 'interrupted', false, false]);
});

function rig(tasks, { now = NOW, run } = {}) {
  let store = tasks;
  let clock = now;
  const runs = [];
  const notes = [];
  const s = new sched.TaskScheduler({
    getTasks: () => store,
    saveTasks: (l) => { store = l; },
    now: () => clock,
    notify: (title, body) => notes.push(title + ': ' + body),
    run: run || (async (task) => { runs.push(task.name); return { conversationId: 'c-' + task.id }; })
  });
  return { s, runs, notes, get store() { return store; }, tick: (ms) => { clock += ms; }, get now() { return clock; } };
}

test('runner: due tasks run once, in order; outcome, failures and one-off completion are recorded', async () => {
  const r = rig([
    { id: 'a', name: 'daily', prompt: 'p', when: 'daily 09:00', state: 'active', createdAt: at('2026-11-08T08:00'), lastRun: at('2026-11-08T09:00') },
    { id: 'b', name: 'once', prompt: 'p', when: 'at 2026-11-09 09:30', state: 'active', createdAt: at('2026-11-08T08:00') },
    { id: 'c', name: 'later', prompt: 'p', when: 'daily 23:00', state: 'active', createdAt: at('2026-11-09T09:00') }
  ]);
  r.s.stopped = false;
  r.s.pass();
  await new Promise((res) => setTimeout(res, 20));
  assert.deepStrictEqual(r.runs, ['daily', 'once']);
  const by = (id) => r.store.find((t) => t.id === id);
  assert.strictEqual(by('a').lastOutcome, 'ok');
  assert.strictEqual(by('a').conversationId, 'c-a');
  assert.strictEqual(by('b').state, 'done');
  r.s.pass();
  await new Promise((res) => setTimeout(res, 20));
  assert.strictEqual(r.runs.length, 2, 'nothing runs twice');
  r.s.stop();
});

test('runner: three failures in a row pause the task and notify; success resets the count', async () => {
  let fail = true;
  const r = rig([{ id: 'x', name: 'flaky', prompt: 'p', when: 'every 30m', state: 'active', createdAt: NOW - 31 * 60000 }],
    { run: async () => (fail ? { error: 'server down' } : { conversationId: 'c' }) });
  for (let i = 0; i < 2; i++) { await r.s.execute('x', { scheduled: true }); r.tick(30 * 60000); }
  assert.strictEqual(r.store[0].failures, 2);
  assert.strictEqual(r.store[0].state, 'active');
  fail = false;
  await r.s.execute('x', { scheduled: true });
  assert.strictEqual(r.store[0].failures, 0, 'success resets');
  fail = true;
  for (let i = 0; i < 3; i++) { r.tick(30 * 60000); await r.s.execute('x', { scheduled: true }); }
  assert.strictEqual(r.store[0].state, 'paused');
  assert.match(r.store[0].lastOutcome, /^error: server down/);
  assert.match(r.notes[0], /paused: It failed 3 times in a row/);
  // A paused task does not run from the schedule, but "run now" still works.
  assert.deepStrictEqual(await r.s.execute('x', { scheduled: true }), { skipped: true });
  fail = false;
  const manual = await r.s.runTask('x');
  assert.strictEqual(manual.conversationId, 'c');
  // Resuming starts from now: missed times are not replayed.
  r.s.setState('x', 'active');
  assert.ok(sched.nextDue(r.store[0]) > r.now);
});

test('runner: the runtime cap aborts a run and records "timed out"; edits re-check at start', async () => {
  const r = rig([{ id: 'slow', name: 'slow', prompt: 'p', when: 'every 30m', state: 'active', createdAt: NOW - 31 * 60000 }],
    { run: (task, { signal }) => new Promise((res) => signal.addEventListener('abort', () => res({ stopped: true }))) });
  r.s.d.maxRuntimeMin = () => 0.001;   // 60 ms
  await r.s.execute('slow', { scheduled: true });
  assert.strictEqual(r.store[0].lastOutcome, 'timed out');
  assert.strictEqual(r.store[0].failures, 1);
  r.s.setState('slow', 'paused');
  assert.deepStrictEqual(await r.s.execute('slow', { scheduled: true }), { skipped: true }, 'paused after queueing: not run');
});

test('upsert: validates, re-anchors a changed when, caps active tasks, marks the creator', () => {
  const r = rig([]);
  const t = r.s.upsert({ name: 'n', prompt: 'p', when: 'every 2h' }, { createdBy: 'agent' });
  assert.strictEqual(t.createdBy, 'agent');
  assert.strictEqual(t.state, 'active');
  assert.throws(() => r.s.upsert({ name: 'n', prompt: 'p', when: 'every 1m' }), /5 minutes/);
  r.tick(10 * 60000);
  const u = r.s.upsert({ id: t.id, when: 'every 3h' });
  assert.strictEqual(u.createdAt, r.now, 'changed when re-anchors');
  const legacy = r.s.upsert({ name: 'old', prompt: 'p', schedule: { type: 'daily', time: '07:00' } });
  assert.strictEqual(legacy.when, 'daily 07:00');
  for (let i = 0; i < sched.MAX_ACTIVE - 2; i++) r.s.upsert({ name: 'f' + i, prompt: 'p', when: 'daily 08:00' });
  assert.throws(() => r.s.upsert({ name: 'one too many', prompt: 'p', when: 'daily 08:00' }), /at most 20 active/);
  r.s.stop();
});

test('stored when is canonical', () => {
  assert.strictEqual(sched.canonicalWhen('every weekday at 8:30 am'), 'weekdays 08:30');
  assert.strictEqual(sched.canonicalWhen('Daily at 9pm'), 'daily 21:00');
  assert.strictEqual(sched.canonicalWhen('every Monday and Thursday at 2:30pm'), 'mon,thu 14:30');
  assert.strictEqual(sched.canonicalWhen('every 30 minutes'), 'every 30m');
  assert.strictEqual(sched.canonicalWhen('at 7:05'), 'at 07:05');
});
