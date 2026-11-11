// AI communications bus: assistants on paired devices send each other
// tasks, requests, questions, replies and events over the mesh.
//
// Messages are stored one JSON file each (BE-Code's inbox idea): inbox/ for
// what arrived, outbox/ for what is still being delivered - so nothing is
// lost while a device is offline or the app restarts. Undelivered messages
// are retried when the device comes online and every minute until they
// expire (24 h by default).
//
// The RECEIVING device decides what happens, under its own settings:
//   query   - answered read-only; the answer goes back as a reply
//   request - runs under this device's permission setting (never the
//             sender's); the result goes back as a reply
//   task    - scheduled here (it shows in the task list, marked with the
//             sender); "when" in the message, else it runs once shortly
//   event   - recorded, with a notification
//   reply   - completes a bus_ask that is waiting for it
// The mesh checks the receiving device's "AI requests" permission for the
// sender before anything is stored. Messages are size-limited, senders are
// rate-limited, and a hop count stops assistants bouncing work between
// themselves forever.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const KINDS = ['task', 'request', 'query', 'reply', 'event'];
const MAX_BODY = 64 * 1024;
const MAX_HOPS = 3;
const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 30;
const RETRY_MS = 60 * 1000;

const newId = () => `m${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;

class AiBus {
  // { dir, getMesh(), deviceName(), handle(msg) -> Promise<{ answer?, error?, scheduled? }>, notify(title, body), log }
  constructor({ dir, getMesh, deviceName, handle, notify = () => {}, log = () => {} }) {
    this.dir = dir;
    this.getMesh = getMesh;
    this.deviceName = deviceName;
    this.handleMessage = handle;
    this.notify = notify;
    this.log = log;
    this.inboxDir = path.join(dir, 'inbox');
    this.outboxDir = path.join(dir, 'outbox');
    fs.mkdirSync(this.inboxDir, { recursive: true });
    fs.mkdirSync(this.outboxDir, { recursive: true });
    this.waiters = new Map();     // message id -> resolve(reply)
    this.recent = new Map();      // sender device -> [timestamps]
    this.timer = null;
  }

  mesh() {
    const m = this.getMesh();
    if (!m) throw new Error('Device connections are off (Settings > Devices).');
    return m;
  }

  // Online and known paired devices: { id, name, online }
  devices() {
    const m = this.getMesh();
    if (!m) return [];
    return [...m.peers.values()].map((p) => ({ id: p.id, name: p.label || p.name, online: m.conns.has(p.id), aiBus: !!(p.perms && p.perms.aiBus) }));
  }

  // A device by name (case-insensitive) or ID prefix.
  resolve(device) {
    const q = String(device || '').trim().toLowerCase();
    if (!q) throw new Error('Say which device (list_devices shows them).');
    const all = this.devices();
    const hit = all.find((d) => d.name.toLowerCase() === q) || all.find((d) => d.id.toLowerCase().startsWith(q.replace(/[^a-z2-7-]/g, '')))
      || all.find((d) => d.name.toLowerCase().includes(q));
    if (!hit) throw new Error(`No paired device called "${device}". Paired: ${all.map((d) => d.name).join(', ') || 'none'}.`);
    return hit;
  }

  async write(dir, msg) {
    const file = path.join(dir, `${msg.id}.json`);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(msg));
    await fsp.rename(tmp, file);
  }

  async readAll(dir) {
    let names = [];
    try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const n of names) { try { out.push(JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'))); } catch { /* half-written */ } }
    return out.sort((a, b) => a.created - b.created);
  }

  // ---- sending
  async send(device, { kind, subject = '', body = '', when, replyTo, hops = 0, ttlMs = DEFAULT_TTL_MS }) {
    if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
    const text = String(body || '');
    if (Buffer.byteLength(text) > MAX_BODY) throw new Error(`message too long (max ${MAX_BODY / 1024} KB)`);
    if (hops >= MAX_HOPS && kind !== 'reply') throw new Error('This request has already passed between too many assistants; answer it here instead.');
    const to = this.resolve(device);
    const m = this.mesh();
    const msg = {
      id: newId(), kind, subject: String(subject || '').slice(0, 200), body: text,
      from: { device: m.identity.id, name: this.deviceName() }, to: { device: to.id, name: to.name },
      ...(when ? { when: String(when).slice(0, 80) } : {}), ...(replyTo ? { replyTo: String(replyTo) } : {}),
      hops, created: Date.now(), expires: Date.now() + ttlMs
    };
    await this.write(this.outboxDir, msg);
    const delivered = await this.deliver(msg);
    return { id: msg.id, to: to.name, delivered, ...(delivered ? {} : { note: `${to.name} is offline; it will be delivered when it is back (until ${new Date(msg.expires).toLocaleString()}).` }) };
  }

  async deliver(msg) {
    const m = this.getMesh();
    if (!m || !m.conns.has(msg.to.device)) return false;
    try {
      await m.request(msg.to.device, 'bus.deliver', { msg }, 20000);
      await fsp.rm(path.join(this.outboxDir, `${msg.id}.json`), { force: true });
      return true;
    } catch (err) {
      // Refused for good (no permission, too big): stop retrying and say so.
      if (/has not allowed|too long|too many|disabled/i.test(err.message)) {
        await fsp.rm(path.join(this.outboxDir, `${msg.id}.json`), { force: true });
        this.notify(`AI message to ${msg.to.name} not delivered`, err.message);
        const w = this.waiters.get(msg.id);
        if (w) { this.waiters.delete(msg.id); w({ error: err.message }); }
      }
      return false;
    }
  }

  async retry() {
    for (const msg of await this.readAll(this.outboxDir)) {
      if (Date.now() > msg.expires) {
        await fsp.rm(path.join(this.outboxDir, `${msg.id}.json`), { force: true });
        this.notify(`AI message to ${msg.to.name} expired`, msg.subject || msg.body.slice(0, 120));
        continue;
      }
      await this.deliver(msg);
    }
  }

  // Send a question and wait for the reply.
  async ask(device, question, { timeoutMs = 120000, hops = 0, subject } = {}) {
    const res = await this.send(device, { kind: 'query', subject: subject || String(question).slice(0, 80), body: question, hops });
    if (!res.delivered) return { ...res, answer: null };
    const reply = await new Promise((resolve) => {
      this.waiters.set(res.id, resolve);
      setTimeout(() => { if (this.waiters.delete(res.id)) resolve(null); }, timeoutMs);
    });
    if (!reply) return { ...res, answer: null, note: `No answer from ${res.to} yet; it will arrive in bus_inbox.` };
    if (reply.error) return { ...res, error: reply.error };
    return { ...res, answer: reply.body };
  }

  // ---- receiving
  rateOk(device) {
    const now = Date.now();
    const list = (this.recent.get(device) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (list.length >= RATE_MAX) return false;
    list.push(now);
    this.recent.set(device, list);
    return true;
  }

  async receive(msg, from) {
    if (!msg || typeof msg !== 'object' || !KINDS.includes(msg.kind)) throw new Error('not a bus message');
    if (Buffer.byteLength(String(msg.body || '')) > MAX_BODY) throw new Error('message too long');
    if (!this.rateOk(from.id)) throw new Error('too many messages from that device; try again later');
    // Trust the mesh for who sent it, not the message.
    const clean = {
      id: String(msg.id || newId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || newId(),
      kind: msg.kind, subject: String(msg.subject || '').slice(0, 200), body: String(msg.body || ''),
      from: { device: from.id, name: from.name }, ...(msg.when ? { when: String(msg.when).slice(0, 80) } : {}),
      ...(msg.replyTo ? { replyTo: String(msg.replyTo).slice(0, 40) } : {}),
      hops: Math.max(0, Number(msg.hops) || 0), created: Number(msg.created) || Date.now(), received: Date.now(), status: 'new'
    };
    if (fs.existsSync(path.join(this.inboxDir, `${clean.id}.json`))) return { ok: true, duplicate: true };
    await this.write(this.inboxDir, clean);
    setImmediate(() => this.process(clean).catch((err) => this.log(`bus: ${err.message}`)));
    return { ok: true };
  }

  async setStatus(msg, status, extra = {}) {
    Object.assign(msg, { status }, extra);
    await this.write(this.inboxDir, msg).catch(() => {});
  }

  async process(msg) {
    if (msg.kind === 'reply') {
      const w = this.waiters.get(msg.replyTo);
      if (w) { this.waiters.delete(msg.replyTo); w(msg); await this.setStatus(msg, 'read'); return; }
      this.notify(`Answer from ${msg.from.name}'s assistant`, msg.body.slice(0, 200));
      return;
    }
    if (msg.kind === 'event') { this.notify(`${msg.from.name}: ${msg.subject || 'event'}`, msg.body.slice(0, 200)); return; }
    this.notify(`${msg.from.name}'s assistant ${msg.kind === 'query' ? 'asks' : msg.kind === 'task' ? 'sent a task' : 'asks for'}: ${msg.subject || msg.body.slice(0, 60)}`, msg.body.slice(0, 200));
    await this.setStatus(msg, 'working');
    let result;
    try { result = await this.handleMessage(msg); } catch (err) { result = { error: err.message }; }
    await this.setStatus(msg, result && result.error ? 'failed' : 'done', { result: result && (result.answer || result.error || result.scheduled) });
    if (msg.kind === 'task' && result && result.scheduled && !result.answer) {
      await this.send(msg.from.device, { kind: 'reply', replyTo: msg.id, subject: `Re: ${msg.subject}`, body: result.scheduled, hops: msg.hops + 1 }).catch(() => {});
      return;
    }
    const body = result && result.error ? `Could not do that here: ${result.error}` : String((result && result.answer) || '(no answer)');
    await this.send(msg.from.device, { kind: 'reply', replyTo: msg.id, subject: `Re: ${msg.subject}`, body: body.slice(0, MAX_BODY - 100), hops: msg.hops + 1 }).catch((err) => this.log(`bus reply: ${err.message}`));
  }

  async inbox(limit = 20) {
    const all = await this.readAll(this.inboxDir);
    return all.slice(-Math.max(1, Math.min(100, limit))).reverse()
      .map((m) => ({ id: m.id, kind: m.kind, from: m.from.name, subject: m.subject, body: m.body.slice(0, 2000), when: new Date(m.received || m.created).toLocaleString(), status: m.status, ...(m.replyTo ? { replyTo: m.replyTo } : {}) }));
  }

  attach(mesh) {
    mesh.handle('bus.deliver', 'aiBus', async (a, from) => this.receive(a && a.msg, from));
    mesh.on('online', () => setTimeout(() => this.retry().catch(() => {}), 1500));
    if (!this.timer) this.timer = setInterval(() => this.retry().catch(() => {}), RETRY_MS);
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}

module.exports = { AiBus, KINDS, MAX_HOPS };
