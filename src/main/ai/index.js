// AI service: owns provider configuration (keys encrypted at rest),
// conversations, the permission prompt, the web-frame operation bridge to
// the renderer, the chat widget's pin-on-top override, and the IPC surface
// the chat widget and Spotlight use.
const path = require('path');
const crypto = require('crypto');
const { ipcMain, dialog, safeStorage, shell } = require('electron');
const { Conversations } = require('./conversations');
const { createProvider, normalizeBaseUrl, PRESETS } = require('./providers');
const { runTurn, compactConversation } = require('./agent');
const ctxbuf = require('./context');
const { webSearch, fetchPage } = require('./websearch');
const attachments = require('./attachments');
const { TaskScheduler } = require('./scheduler');
const { Memory } = require('./memory');
const { BrowserController } = require('./browser');
const { nativeImage, webContents } = require('electron');
const fs = require('fs');

const WEB_OP_TIMEOUT_MS = 25000;

class AiService {
  // deps: { userDataDir, store, updateSettings, getWindow, spotlight, tasks, telemetry, plugins, setPinned }
  constructor(deps) {
    this.d = deps;
    this.conversations = new Conversations(path.join(deps.userDataDir, 'ai', 'conversations'));
    this.conversations.defaultLocal = () => (this.d.store.get('devices') || {}).newConversationsLocal === true;
    this.runs = new Map();          // conversationId -> AbortController
    this.queues = new Map();        // conversationId -> [text] waiting for the current turn
    // Task runs in progress (conversation id -> task name). While one runs,
    // chat and AI-bus messages wait in their conversation's queue, so they
    // never compete with the task for the model or the server.
    this.taskRuns = new Map();
    this.pendingWebOps = new Map(); // opId -> { resolve, timer }
    this.pinned = false;
    this.calibrations = new Map();  // provider|model -> chars-per-token learned from usage
    this.runInfo = new Map();       // conversation id -> { ep, model, restart, ... } while a turn runs
    this.memory = new Memory(path.join(deps.userDataDir, 'ai', 'memory.json'));
    this.visuals = new (require('./visuals').Visuals)(path.join(deps.userDataDir, 'ai', 'visuals'));
    // AI widgets: desktop widgets the assistant writes (AI Folder/AI Widgets).
    // Site approvals live in the app's data, out of the assistant's reach.
    this.widgets = new (require('./widgets').AiWidgets)({
      folder: () => require('../files').ensureAiFolder(deps.store),
      approvalsFile: path.join(deps.userDataDir, 'ai', 'widget-approvals.json'),
      approve: (w, hosts) => this.approveWidgetHosts(w, hosts),
      onChange: (list) => { const win = this.d.getWindow(); if (win && !win.isDestroyed()) win.webContents.send('ai:widgets', list); },
      log: (m) => console.log('[widgets]', m)
    });
    this.widgets.load().then(() => this.widgets.watch()).catch((err) => console.log('[widgets]', err.message));
    this.browser = new BrowserController({
      profileDir: path.join(deps.userDataDir, 'ai', 'browser-profile'),
      preferred: () => String(this.config().browser || ''),
      resizeImage: (png) => {
        const img = nativeImage.createFromBuffer(png);
        const w = img.getSize().width;
        const scaled = w > 1024 ? img.resize({ width: 1024 }) : img;
        return { mime: 'image/jpeg', data: scaled.toJPEG(60).toString('base64') };
      }
    });
    this.scheduler = new TaskScheduler({
      getTasks: () => (this.config().tasks || []),
      saveTasks: (tasks) => this.d.updateSettings({ ai: { tasks } }),
      run: (task, info) => this.runTask(task, info),
      notify: (title, body) => this.d.notify(title, body),
      maxRuntimeMin: () => Number(this.config().taskMaxRuntimeMin) || 30,
      // A task synced from another device shows here but runs there.
      owns: (t) => !t.device || !deps.deviceId || t.device === deps.deviceId(),
      onChange: (list) => { const w = this.d.getWindow(); if (w && !w.isDestroyed()) w.webContents.send('ai:tasks', list); }
    });
    this.scheduler.start();
    // AI bus: assistants on paired devices talking (bus.js). Attached to
    // the mesh by main when device connections are on.
    this.busHops = new Map();       // conversation id -> hop count of the bus message it is handling
    // Shared inference servers: which server + model each paired device uses
    // (shared-server.js) - to follow a loaded model and not evict each other.
    const { SharedServers, serverKey } = require('./shared-server');
    this.serverKey = serverKey;
    this.shared = new SharedServers({
      local: () => {
        const out = [];
        for (const which of ['chat', 'task']) {
          const ep = this.endpoint(which);
          if (!ep.preset.local) continue;
          const model = which === 'task' ? this.taskModel(null) : String(this.config().model || ep.preset.model || '');
          const server = serverKey(ep.baseUrl);
          if (server && model && !out.some((m) => m.server === server && m.model === model)) out.push({ server, model });
        }
        return { models: out };
      }
    });
    this.bus = new (require('./bus').AiBus)({
      dir: path.join(deps.userDataDir, 'ai', 'bus'),
      getMesh: () => (deps.getMesh ? deps.getMesh() : null),
      deviceName: () => (deps.deviceName ? deps.deviceName() : require('os').hostname()),
      handle: (msg) => this.handleBusMessage(msg),
      notify: (title, body) => this.d.notify(title, body),
      log: (m) => console.log('[ai-bus]', m)
    });
    this.registerIpc();
  }

  // ---- state sync (state-sync.js): what this device shares, and applying
  // what others share. Conversations and tasks are synced unless Local.
  syncableConversations() {
    return this.conversations.list().filter((c) => !c.local && !/^AI bus · /.test(c.title))
      .map((c) => {
        // Synced as the conversation itself: this device's flags stay out,
        // or applying it elsewhere would change it and bounce it back.
        try { const { local, syncedFrom, ...rest } = this.conversations.get(c.id); return rest; } catch { return null; }
      }).filter(Boolean);
  }

  isLocalConversation(id) {
    try { const c = this.conversations.get(id); return !!c.local || /^AI bus · /.test(c.title); } catch { return false; }
  }

  applySyncedConversation(c, from) {
    if (this.runs.has(c.id)) return;                     // busy here: the next sync brings it
    const { local, syncedFrom, ...rest } = c || {};
    this.conversations.put(rest);
    const w = this.d.getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('ai:list-changed');
  }

  removeSyncedConversation(id) {
    if (this.runs.has(id)) return;
    this.conversations.remove(id);
    const w = this.d.getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('ai:list-changed');
  }

  // Tasks share their definition, never their run state (last run, next
  // run, failures), so a run on one device does not ripple to the others.
  syncableTasks() {
    const me = this.d.deviceId ? this.d.deviceId() : '';
    const keep = ['id', 'name', 'prompt', 'when', 'permission', 'conversationMode', 'model', 'readAloud', 'state', 'createdBy', 'createdAt'];
    return (this.config().tasks || []).filter((t) => !t.local).map((t) => {
      const v = Object.fromEntries(keep.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));
      v.device = t.device || me;
      v.deviceName = t.device && t.device !== me ? (t.deviceName || '') : (this.d.deviceName ? this.d.deviceName() : '');
      return v;
    });
  }

  applySyncedTask(v) {
    const tasks = (this.config().tasks || []).slice();
    const i = tasks.findIndex((t) => t.id === v.id);
    const merged = i >= 0 ? { ...tasks[i], ...v } : { ...v, failures: 0 };
    if (i >= 0) tasks[i] = merged; else tasks.push(merged);
    this.d.updateSettings({ ai: { tasks } });
  }

  removeSyncedTask(id) {
    const tasks = (this.config().tasks || []).filter((t) => t.id !== id);
    this.d.updateSettings({ ai: { tasks } });
  }

  // A task, request or question from another device's assistant. The
  // RECEIVING device's settings apply: questions are read-only; requests
  // use this device's permission setting (ask -> read-only, as for tasks).
  async handleBusMessage(msg) {
    if (!this.enabled()) return { error: 'the assistant is turned off on that device' };
    const from = msg.from.name || 'another device';
    if (msg.kind === 'task' && msg.when) {
      try {
        const t = this.scheduler.upsert({ name: (msg.subject || `Task from ${from}`).slice(0, 80), prompt: msg.body, when: msg.when, permission: 'inherit', conversationMode: 'shared' }, { createdBy: `device:${from}` });
        return { scheduled: `Scheduled "${t.name}" on ${require('os').hostname()} (${t.when}).` };
      } catch (err) { return { error: err.message }; }
    }
    // One running conversation per sending device.
    const title = `AI bus · ${from}`;
    let conv = this.conversations.list().find((c) => c.title === title);
    if (!conv) { conv = this.conversations.create(); this.conversations.rename(conv.id, title); }
    while (this.runs.has(conv.id)) await new Promise((r) => setTimeout(r, 1000));
    const globalMode = this.config().permission || 'ask';
    const permission = msg.kind === 'query' ? 'deny' : (globalMode === 'ask' ? 'deny' : globalMode);
    const what = msg.kind === 'query' ? 'A question' : msg.kind === 'task' ? 'A task' : 'A request';
    const header = `[${what} from the assistant on ${from}${msg.subject ? `: ${msg.subject}` : ''}. Nobody is watching here; your final reply is sent back to that assistant, so make it complete and concise.${msg.kind === 'query' ? ' Answer only: do not change anything.' : ''}]\n`;
    this.busHops.set(conv.id, msg.hops || 0);
    const start = this.conversations.get(conv.id).messages.length;
    const answerSince = (from) => {
      const msgs = this.conversations.get(conv.id).messages.slice(from);
      const last = [...msgs].reverse().find((m) => m.role === 'assistant' && String(m.content || '').trim());
      return last ? String(last.content).trim() : '';
    };
    let result;
    let answer = '';
    try {
      result = await this.send(conv.id, header + msg.body, [], { permission, source: 'bus' });
      if (result && result.error) return { error: result.error };
      answer = answerSince(start);
      // The model finished with tool calls and no words (common with local
      // models): one more step, no tools, to write the answer down.
      if (!answer) {
        const mark = this.conversations.get(conv.id).messages.length;
        await this.send(conv.id, '[Write your answer for the other assistant now, in plain text, from what you found. Do not call tools.]', [], { permission: 'deny', source: 'bus', maxSteps: 1 });
        answer = answerSince(mark);
      }
    } finally { this.busHops.delete(conv.id); }
    return { answer: answer || '(the assistant here could not produce an answer)' };
  }

  // A scheduled task runs in its own conversation with its own permission
  // policy: unattended runs never raise a dialog - "ask" means read-only.
  async runTask(task, { scheduled, signal } = {}) {
    if (!this.enabled()) return { error: 'AI assistant is disabled' };
    let convId = task.conversationMode === 'shared' ? task.conversationId : null;
    if (convId) { try { this.conversations.get(convId); } catch { convId = null; } }
    if (!convId) {
      const c = this.conversations.create();
      this.conversations.rename(c.id, `Task: ${task.name}`);
      convId = c.id;
    }
    // The task's conversation may be busy (someone chatting in it, or the
    // previous run still answering). Wait for it rather than queueing: a
    // queued message would be reported as finished before it ran.
    while (this.runs.has(convId)) {
      if (signal && signal.aborted) return { stopped: true, conversationId: convId };
      await new Promise((r) => setTimeout(r, 1000));
    }
    const globalMode = this.config().permission || 'ask';
    const permission = task.permission && task.permission !== 'inherit'
      ? task.permission : (globalMode === 'ask' ? 'deny' : globalMode);
    const when = task.when ? ` - ${task.when}` : '';
    // Tasks settle: a few lookups, then the answer. Where sources disagree
    // the model reports both instead of re-checking until the step limit.
    const settle = 'Use only the lookups you need. If sources disagree, report what each says instead of checking again. End with the answer.';
    const header = scheduled
      ? `[Scheduled task "${task.name}"${when}. Nobody is watching: finish the job and keep the summary short. ${settle}]\n`
      : `[Task "${task.name}". ${settle}]\n`;
    const taskSteps = Math.max(2, Math.min(100, Number(this.config().taskMaxSteps) || 10));
    // Model: the task's own choice, else the Tasks model in Settings, else
    // the chat model.
    const model = this.taskModel(task);
    const result = await this.send(convId, header + task.prompt, [], { permission, source: scheduled ? 'schedule' : 'task', taskName: task.name, signal, model, endpoint: 'task', maxSteps: taskSteps });
    try {
      const conv = this.conversations.get(convId);
      const last = [...conv.messages].reverse().find((m) => m.role === 'assistant' && m.content);
      this.d.notify(`Task "${task.name}" ${result.error ? 'failed' : 'finished'}`,
        result.error ? String(result.error) : String(last ? last.content : '').replace(/\s+/g, ' ').slice(0, 160));
      // "Read the result aloud": the final reply, through the same voice and
      // speech formatting as chat. Skipped when every reply is already read
      // aloud (Settings > Voice), or it would be said twice.
      const alreadySpoken = !!((this.config().voice || {}).speak);
      if (task.readAloud && !alreadySpoken && !result.error && !result.stopped && last && this.d.speak) {
        this.d.speak(`${task.name}. ${last.content}`);
      }
    } catch { /* best effort */ }
    return { ...result, conversationId: convId };
  }

  // ---------------------------------------------------------- configuration
  config() {
    return this.d.store.get('ai') || {};
  }

  enabled() {
    return this.config().enabled !== false;
  }

  apiKey(field = 'apiKey') {
    const raw = this.config()[field] || '';
    if (!raw) return '';
    if (raw.startsWith('enc:')) {
      try {
        return safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64')) : '';
      } catch { return ''; }
    }
    return raw;
  }

  setApiKey(plain, field = 'apiKey') {
    let stored = plain || '';
    if (stored && safeStorage.isEncryptionAvailable()) {
      stored = 'enc:' + safeStorage.encryptString(stored).toString('base64');
    }
    this.d.updateSettings({ ai: { [field]: stored } });
  }

  // Inference endpoints. 'chat' is Settings > Provider; 'task' is the
  // provider for scheduled tasks ('' there = the chat provider). Both can be
  // in use at once: a model on this PC for chat, a LAN server for tasks.
  endpoint(which = 'chat') {
    const c = this.config();
    if (which === 'task' && c.taskProvider) {
      const preset = PRESETS[c.taskProvider] || PRESETS.custom;
      return { id: 'task', provider: c.taskProvider, preset, baseUrl: normalizeBaseUrl(c.taskProvider, c.taskBaseUrl || preset.baseUrl), keyField: 'taskApiKey' };
    }
    const provider = c.provider || 'anthropic';
    const preset = PRESETS[provider] || PRESETS.custom;
    return { id: 'chat', provider, preset, baseUrl: normalizeBaseUrl(provider, c.baseUrl || preset.baseUrl), keyField: 'apiKey' };
  }

  provider(ep = this.endpoint()) {
    return createProvider({ provider: ep.provider, baseUrl: ep.baseUrl, apiKey: this.apiKey(ep.keyField) });
  }

  preset(ep = this.endpoint()) {
    return ep.preset;
  }

  // One Backend per server URL, kept for the session (it remembers whether
  // the server can report model status). Chat and tasks may use different
  // servers at the same time.
  backend(ep = this.endpoint()) {
    const p = ep.preset;
    if (p.kind === 'anthropic' || !p.local) return null;
    const url = ep.baseUrl;
    if (!url || /^unix:/.test(url)) return null;
    if (!this.backends) this.backends = new Map();
    if (!this.backends.has(url)) this.backends.set(url, { url, b: new (require('./backend').Backend)({ baseUrl: url }), evicted: false, window: 0 });
    return this.backends.get(url);
  }

  // Before each model call: report an eviction once, and a window change.
  async checkBackend(model, emit, ep) {
    const be = this.backend(ep);
    if (!be) return null;
    const st = await be.b.status(model);
    if (!st) return null;
    if (!st.loaded) {
      if (!be.evicted) { be.evicted = true; emit({ type: 'notice', text: `The model ${model} is not loaded on the server (evicted by another model or idle expiry). This reply includes load time and re-reading the conversation.` }); }
    } else {
      be.evicted = false;
      if (be.window && st.window && st.window !== be.window) {
        emit({ type: 'notice', text: `The server's context window for ${model} changed ${be.window.toLocaleString()} -> ${st.window.toLocaleString()} tokens; the conversation budget follows it.` });
      }
      if (st.window) be.window = st.window;
    }
    return st;
  }

  // After a reply or task: how long the model stays loaded (Ollama
  // keep_alive, counted from now). The default unloads it a minute after the
  // last reply, so a shared server's memory is free for other models; a
  // new message in the meantime keeps it loaded. 'keep' leaves the server's
  // own setting alone.
  refreshKeepAlive(model, ep) {
    const be = this.backend(ep);
    if (!be) return;
    const ka = String(this.config().unloadAfter || '1m');
    if (!ka || ka === 'keep') return;
    be.b.keepAlive(model, ka).catch(() => {});
  }

  // A request that has been silent long enough for a stall notice: is
  // another model holding the server while ours waits to load? Then offer to
  // unload it (or, per Settings, do it after a further wait).
  async onStall(convId, stage, emit) {
    const run = this.runInfo.get(convId);
    if (!run) return;
    if (stage === 0) { run.stalled = false; clearTimeout(run.autoTimer); return; }
    if (stage !== 1) return;
    run.stalled = true;
    if (run.blockedShown) return;
    const be = this.backend(run.ep);
    if (!be) return;
    const st = await be.b.status(run.model, { fresh: true });
    if (!st || st.loaded || !st.others || !st.others.length || !run.stalled) return;
    const busy = this.shared.inUse(this.serverKey(run.ep.baseUrl), st.others);
    if (busy.length && busy.length === st.others.length) {
      run.blockedShown = true;
      const who = [...new Set(busy.map((b) => b.device))].join(', ');
      emit({ type: 'notice', text: `${busy.map((b) => b.model).join(', ')} is ${busy.some((b) => b.running) ? 'in use' : 'recently used'} by ${who}'s assistant on this shared server - waiting for it rather than unloading it.` });
      return;
    }
    let mode = this.config().evictBlocking || 'ask';
    if (mode === 'never') return;
    // Nobody is watching a scheduled task to press the button.
    if (run.unattended) mode = 'auto';
    run.blockedShown = true;
    if (mode === 'auto') {
      emit({ type: 'notice', text: `${run.model} is waiting to load behind ${st.others.join(', ')} on the server. If nothing changes in 45 seconds, that model will be unloaded.` });
      run.autoTimer = setTimeout(() => { if (run.stalled && this.runInfo.get(convId) === run) this.evictBlocking(convId).catch(() => {}); }, 45000);
    } else {
      emit({ type: 'blocked', model: run.model, others: st.others });
    }
  }

  // Unload the other models on the server this conversation's request is
  // waiting on, then send the request again.
  async evictBlocking(convId) {
    const run = this.runInfo.get(convId);
    if (!run) return { error: 'nothing is waiting in this conversation' };
    const be = this.backend(run.ep);
    if (!be) return { error: 'this server cannot unload models' };
    const st = await be.b.status(run.model, { fresh: true });
    const emit = (ev) => this.emit(convId, ev);
    if (st && st.loaded) return { ok: true, unloaded: [], note: `${run.model} is loaded now` };
    const allOthers = (st && st.others) || [];
    // Never unload a model one of my other devices is using.
    const busy = new Set(this.shared.inUse(this.serverKey(run.ep.baseUrl), allOthers).map((b) => b.model));
    const others = allOthers.filter((m) => !busy.has(m));
    if (allOthers.length && !others.length) return { ok: false, error: 'that model is in use by one of your other devices; waiting for it instead' };
    if (!others.length) return { ok: false, error: 'no other model is loaded on the server' };
    const done = [];
    for (const m of others) if (await be.b.unload(m)) done.push(m);
    emit({ type: 'notice', text: done.length ? `Unloaded ${done.join(', ')} from the server; loading ${run.model}.` : `The server did not unload ${others.join(', ')}.` });
    if (done.length && run.restart) run.restart();
    return { ok: done.length > 0, unloaded: done };
  }

  // Token budget for one request: the user's number, else a default for
  // the provider kind (local servers get a small one).
  contextBudget(ep = this.endpoint()) {
    const c = this.config();
    const p = ep.preset;
    return ctxbuf.budgetFor(ep.provider, p.kind, c.contextTokens, !!p.local);
  }

  // Remembered per provider + model for the app session: whether native
  // tool calls worked, or the server rejected them (then text calls).
  toolSession(model, ep = this.endpoint()) {
    if (!this.toolSessions) this.toolSessions = new Map();
    const key = `${ep.provider}|${ep.baseUrl}|${model}`;
    if (!this.toolSessions.has(key)) this.toolSessions.set(key, {});
    return this.toolSessions.get(key);
  }

  calibration(model = this.config().model, ep = this.endpoint()) {
    const key = `${ep.provider}|${ep.baseUrl}|${model}`;
    if (!this.calibrations.has(key)) this.calibrations.set(key, new ctxbuf.Calibration());
    return this.calibrations.get(key);
  }

  // Is the configured server answering? Cheap (model list), bounded.
  async probe() {
    const started = Date.now();
    const p = this.preset();
    if (p.needsKey && !this.apiKey()) return { ok: false, error: 'no API key', needsKey: true };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    try {
      const models = await this.provider().listModels({ signal: ac.signal });
      return { ok: true, latencyMs: Date.now() - started, models: (models || []).length, local: !!p.local };
    } catch (err) {
      const prov = this.provider();
      return { ok: false, latencyMs: Date.now() - started, error: prov.describeError ? prov.describeError(err) : String(err && err.message || err), local: !!p.local };
    } finally { clearTimeout(t); }
  }

  // Force a compaction of one conversation now.
  async compact(conversationId) {
    let conv;
    try { conv = this.conversations.get(conversationId); } catch { return { error: 'no such conversation' }; }
    if (this.runs.has(conv.id)) return { error: 'busy - wait for the current turn' };
    const c = this.config();
    const model = c.model || this.preset().model;
    if (!model) return { error: 'no model configured' };
    const controller = new AbortController();
    this.runs.set(conv.id, controller);
    const emit = (ev) => this.emit(conv.id, ev);
    try {
      const before = ctxbuf.estimateTokens(ctxbuf.prepare(conv, { budget: this.contextBudget(), cpt: this.calibration().cpt }).messages, '', this.calibration().cpt);
      const ok = await compactConversation({ provider: this.provider(), model, conversation: conv, ctx: this.toolContext(conv.id), emit, signal: controller.signal });
      const after = ctxbuf.estimateTokens(ctxbuf.prepare(conv, { budget: this.contextBudget(), cpt: this.calibration().cpt }).messages, '', this.calibration().cpt);
      emit({ type: 'notice', text: ok ? `Compacted: about ${before.toLocaleString()} to ${after.toLocaleString()} tokens.` : 'Nothing to compact yet.' });
      emit({ type: 'context', tokens: after, budget: this.contextBudget(), compacted: !!conv.summary });
      emit({ type: 'done', compacted: ok });
      return { ok, before, after };
    } catch (err) {
      emit({ type: 'error', message: err.message });
      emit({ type: 'done', error: err.message });
      return { error: err.message };
    } finally { this.runs.delete(conv.id); }
  }

  // ---- Message actions from the chat bubbles. All refuse while a turn runs.
  // Delete a whole exchange (user message + its reply) or just the reply.
  deleteMessage(conversationId, index, which = 'turn') {
    let conv;
    try { conv = this.conversations.get(conversationId); } catch { return { error: 'no such conversation' }; }
    if (this.runs.has(conv.id)) return { error: 'busy - stop the current reply first' };
    try {
      const r = this.conversations.turnRange(conv.id, index);
      if (which === 'reply') this.conversations.removeRange(conv.id, r.start + 1, r.end);
      else this.conversations.removeRange(conv.id, r.start, r.end);
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  }

  // Ask again from user message `index`: everything after it is dropped and
  // the model answers it afresh. With `text`, the message is edited first
  // (attachments are kept).
  async resendFrom(conversationId, index, text) {
    let conv;
    try { conv = this.conversations.get(conversationId); } catch { return { error: 'no such conversation' }; }
    if (this.runs.has(conv.id)) return { error: 'busy - stop the current reply first' };
    let r;
    try { r = this.conversations.turnRange(conv.id, index); } catch (err) { return { error: err.message }; }
    const original = conv.messages[r.start];
    if (typeof text === 'string') {
      const t = text.trim();
      if (!t && !(original.attachments || []).length) return { error: 'empty message' };
      this.conversations.removeRange(conv.id, r.start, conv.messages.length);
      this.conversations.append(conv.id, { role: 'user', content: t, ...(original.attachments ? { attachments: original.attachments } : {}) });
    } else {
      this.conversations.removeRange(conv.id, r.start + 1, conv.messages.length);
    }
    const fresh = this.conversations.get(conv.id);
    const last = fresh.messages[fresh.messages.length - 1];
    this.emit(conv.id, { type: 'user', content: last.content, attachments: last.attachments || [], title: fresh.title, index: fresh.messages.length - 1, replay: true });
    return this.runConversation(fresh, {});
  }

  // Re-run the pending turn of a conversation whose last turn failed (the
  // server was away); the user's message is already on disk.
  async resume(conversationId) {
    let conv;
    try { conv = this.conversations.get(conversationId); } catch { return { error: 'no such conversation' }; }
    if (this.runs.has(conv.id)) return { error: 'busy' };
    const last = conv.messages[conv.messages.length - 1];
    if (!last || (last.role !== 'user' && last.role !== 'tool')) return { error: 'nothing to resume' };
    return this.runConversation(conv, {});
  }

  status() {
    const c = this.config();
    const preset = PRESETS[c.provider] || PRESETS.custom;
    return {
      enabled: this.enabled(), provider: c.provider || 'anthropic', presetLabel: preset.label,
      baseUrl: c.baseUrl || preset.baseUrl, model: c.model || preset.model,
      hasKey: !!this.apiKey(), needsKey: preset.needsKey, permission: c.permission || 'ask',
      systemPrompt: c.systemPrompt || '', pinned: this.pinned,
      local: !!preset.local, noTools: !!preset.noTools, hint: preset.hint || '',
      contextTokens: Number(c.contextTokens) || 0, contextBudget: this.contextBudget(), compactWithModel: c.compactWithModel !== false,
      taskProvider: c.taskProvider || '', taskBaseUrl: c.taskBaseUrl || '', hasTaskKey: !!this.apiKey('taskApiKey'),
      taskEndpointUrl: this.endpoint('task').baseUrl, chatEndpointUrl: this.endpoint('chat').baseUrl,
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, model: p.model, needsKey: p.needsKey, local: !!p.local, noTools: !!p.noTools, hint: p.hint || '' }))
    };
  }

  // ---------------------------------------------------------- tool context
  toolContext(conversationId) {
    const d = this.d;
    return {
      settings: () => d.store.get(),
      updateSettings: (patch) => d.updateSettings(patch),
      plugins: () => d.plugins(),
      telemetry: () => d.telemetry(),
      search: (q) => (d.spotlight ? d.spotlight.query(q) : { groups: [] }),
      launch: (p) => (d.spotlight ? d.spotlight.open({ path: p }) : Promise.resolve()),
      reindex: () => (d.spotlight ? d.spotlight.reindex() : Promise.resolve()),
      openExternal: (url) => shell.openExternal(url),
      notify: (title, body) => d.notify(title, body),
      windows: {
        list: () => d.tasks.list(),
        action: (name, id) => d.tasks.action(name, id)
      },
      media: d.media,
      speak: d.speak,
      createWebWidget: (url, name) => {
        const id = 'w' + crypto.randomBytes(4).toString('hex');
        const list = [...(d.store.get('webWidgets') || []), { id, url, name: name || new URL(url).hostname }];
        d.updateSettings({ webWidgets: list });
        return id;
      },
      webOp: (id, op, args) => this.webOp(id, op, args),
      webOpen: (url, name) => this.webOpen(url, name),
      browser: (op, args) => this.browserOp(op, args),
      memory: this.memory,
      widgets: {
        create: (args) => this.widgets.create(args),
        update: (id, args) => this.widgets.update(id, args),
        remove: (id) => this.widgets.remove(id, (dir) => require('electron').shell.trashItem(dir)),
        list: () => this.widgets.list()
      },
      visuals: {
        show: (args) => { const rec = this.visuals.save({ ...args, conversationId }); this.visualsChanged(); this.exportVisual(rec.id).catch(() => {}); return rec; },
        close: (id) => { const ok = this.visuals.remove(id); this.visualsChanged(); return ok; },
        list: () => this.visuals.list()
      },
      noTools: !!this.preset().noTools,
      compact: (summary, at) => this.conversations.setSummary(conversationId, summary, at),
      memorySummary: () => (this.config().memoryEnabled === false ? '' : this.memory.summary()),
      webSearch: (q, count) => webSearch(q, { count }),
      fetchPage: (url) => fetchPage(url),
      openWebSearch: (q) => d.openWebSearch(q),
      clipboard: d.clipboard,
      sendKeys: (args) => d.sendKeys(args),
      runCommand: (cmd) => d.runCommand(cmd),
      execCapture: (cmd, timeoutSec) => d.execCapture(cmd, timeoutSec),
      tasks: {
        list: () => this.scheduler.list().map((t) => ({
          id: t.id, name: t.name, when: t.when, prompt: t.prompt, state: t.state, model: this.taskModel(t), modelSource: t.model ? 'task' : this.config().taskModel ? 'tasks setting' : 'chat model', provider: this.endpoint('task').preset.label,
          nextRun: t.nextRun ? new Date(t.nextRun).toLocaleString() : null,
          lastOutcome: t.lastOutcome || null, failures: t.failures || 0, permission: t.permission, error: t.whenError || undefined
        })),
        add: (task) => this.scheduler.upsert(task, { createdBy: 'agent' }),
        remove: (id) => this.scheduler.remove(id),
        setState: (id, state) => this.scheduler.setState(id, state)
      },
      aiFolder: () => require('../files').aiFolder(this.d.store),
      // Work for another device's assistant: no desktop-driving tools unless allowed.
      toolFilter: this.busHops.has(conversationId) && !this.config().busOperateDesktop
        ? (name) => !require('./tools').DESKTOP_TOOLS.has(name) : null,
      // The AI bus, with the hop count of the bus message this conversation
      // is handling (anything sent from here goes one hop further).
      bus: {
        devices: () => this.bus.devices(),
        send: (device, m) => this.bus.send(device, { ...m, hops: (this.busHops.get(conversationId) || 0) + (this.busHops.has(conversationId) ? 1 : 0) }),
        ask: (device, q, o) => this.bus.ask(device, q, {
          ...o, hops: (this.busHops.get(conversationId) || 0) + (this.busHops.has(conversationId) ? 1 : 0),
          // An answer that arrives after we stopped waiting still reaches
          // this conversation (the model sees it next turn; the user now).
          onLate: (reply) => {
            const text = `[Late answer from ${reply.from.name}'s assistant${reply.subject ? ` (${reply.subject.replace(/^Re:\s*/, '')})` : ''}: ${reply.body}]`;
            try { this.conversations.append(conversationId, { role: 'user', content: text }); } catch { /* conversation gone */ }
            this.emit(conversationId, { type: 'notice', text: `Answer from ${reply.from.name}'s assistant: ${reply.body.slice(0, 300)}` });
          }
        }),
        inbox: (n) => this.bus.inbox(n)
      },
      files: {
        // write_file: only inside the AI folder; never overwrites unless asked.
        write: async (rel, content, overwrite) => {
          const { ensureAiFolder, freeName, within } = require('../files');
          const p = require('path');
          const fsp = require('fs/promises');
          const dir = await ensureAiFolder(this.d.store);
          const target = p.resolve(dir, String(rel || '').replace(/^[\\/]+/, ''));
          if (!within(dir, target) || target === dir) return { error: `Files can only be written inside the AI folder (${dir}).` };
          await fsp.mkdir(p.dirname(target), { recursive: true });
          let final = target;
          let exists = false;
          try { await fsp.access(target); exists = true; } catch { /* new */ }
          if (exists && !overwrite) final = p.join(p.dirname(target), await freeName(p.dirname(target), p.basename(target)));
          const text = String(content == null ? '' : content);
          if (text.length > 5 * 1024 * 1024) return { error: 'That is more than 5 MB of text.' };
          await fsp.writeFile(final, text, 'utf8');
          return { ok: true, path: final, bytes: Buffer.byteLength(text), ...(final !== target ? { note: 'A file with that name existed, so this was saved under a new name.' } : {}) };
        },
        read: (p, maxChars) => {
          try {
            const att = attachments.describe(p);
            if (att.kind !== 'text') return { error: `${att.name} is ${att.kind}; attach it to a message to view it` };
            const text = fs.readFileSync(p, 'utf8');
            const cap = Math.max(1000, Math.min(200000, maxChars || 60000));
            return { name: att.name, size: att.size, text: text.length > cap ? text.slice(0, cap) + `\n... (${text.length - cap} more characters)` : text };
          } catch (err) { return { error: err.message }; }
        },
        list: (p) => {
          try {
            const entries = fs.readdirSync(p, { withFileTypes: true }).slice(0, 500).map((e) => {
              let st = null;
              try { st = fs.statSync(require('path').join(p, e.name)); } catch { /* unreadable */ }
              return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: st && !e.isDirectory() ? st.size : undefined, modified: st ? st.mtime.toISOString() : undefined };
            });
            return { path: p, entries };
          } catch (err) { return { error: err.message }; }
        }
      },
      append: (msg) => this.conversations.append(conversationId, msg)
    };
  }

  // A web widget by id, by name, or by site; the only one when unambiguous.
  resolveWidget(hint) {
    const list = (this.d.store.get('webWidgets') || []);
    if (!list.length) return { error: 'there are no web widgets - use web_open(url) to create one' };
    const h = String(hint || '').trim().toLowerCase();
    if (!h) return list.length === 1 ? list[0] : { error: 'several web widgets exist - say which one', widgets: list.map((w) => ({ id: w.id, name: w.name, url: w.url })) };
    const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
    const w = list.find((x) => x.id === hint) || list.find((x) => (x.name || '').toLowerCase() === h)
      || list.find((x) => (x.name || '').toLowerCase().includes(h) || host(x.url).includes(h) || (x.url || '').toLowerCase().includes(h));
    return w || { error: `no web widget matches "${hint}"`, widgets: list.map((x) => ({ id: x.id, name: x.name, url: x.url })) };
  }

  // Open a URL in a widget that already shows that site, or a new widget.
  async webOpen(url, name) {
    if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: 'http(s) URLs only' };
    const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
    const list = this.d.store.get('webWidgets') || [];
    let w = list.find((x) => host(x.url) === host(url));
    if (w) {
      if (w.minimized) this.d.updateSettings({ webWidgets: list.map((x) => (x.id === w.id ? { ...x, minimized: false } : x)) });
      const r = await this.webOp(w.id, 'navigate', { url });
      return { ...r, id: w.id, name: w.name };
    }
    const id = 'w' + crypto.randomBytes(4).toString('hex');
    this.d.updateSettings({ webWidgets: [...list, { id, url, name: name || host(url) }] });
    // The renderer mounts the <webview> asynchronously; poll until it answers.
    const until = Date.now() + 20000;
    let last = null;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 700));
      last = await this.webOp(id, 'read', {});
      if (last && last.ok && (last.text || '').length) break;
    }
    return { ...(last || { ok: true }), id, name: name || host(url), created: true };
  }

  async browserOp(op, args) {
    const b = this.browser;
    try {
      if (op === 'tabs') { const tabs = await b.tabs(); return { ok: true, browser: (b.exe || {}).name || b.info().browser, tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })) }; }
      if (op === 'open') {
        if (!/^https?:\/\//i.test(args.url || '')) return { ok: false, error: 'http(s) URLs only' };
        // The user's own browser and profile, unless the assistant has to
        // act in the page: Chromium refuses DevTools control of the main
        // profile, so clicking and typing need the assistant's profile.
        if ((this.config().browserMode || 'main') === 'main' && !args.interact) {
          // The browser chosen in Settings (its normal profile), else the
          // system default browser.
          const pick = this.config().browser ? require('./browser').listBrowsers().find((x) => x.key === this.config().browser) : null;
          if (pick) require('child_process').spawn(pick.path, [args.url], { detached: true, stdio: 'ignore' }).unref();
          else await shell.openExternal(args.url);
          let page = null;
          try { page = await fetchPage(args.url); } catch { page = null; }
          return {
            ok: true, openedIn: "the user's own browser (main profile)", url: args.url,
            ...(page && !page.error ? { title: page.title, text: page.text } : {}),
            note: 'Opened in the user\'s own browser. You cannot click or type there; if you need to, call browser_open again with interact: true (the assistant browser profile).'
          };
        }
        const tab = await b.open(args.url);
        return { ...(await b.read(tab)), note: 'This browser runs with the BE-Aero profile; the user may need to sign in to sites once.' };
      }
      const tab = await b.resolveTab(args.tab);
      if (tab.error) return { ok: false, ...tab };
      const spec = { index: args.index, selector: args.selector, text: args.text };
      switch (op) {
        case 'read': return b.read(tab);
        case 'elements': return b.elements(tab);
        case 'find': return b.find(tab, args.query);
        case 'screenshot': return b.screenshot(tab);
        case 'navigate': return /^https?:\/\//i.test(args.url || '') ? b.navigate(tab, args.url) : { ok: false, error: 'http(s) URLs only' };
        case 'click': return b.click(tab, spec);
        case 'type': return b.type(tab, spec, args.text, !!args.submit, args.clear !== false);
        case 'select': return b.select(tab, spec, args.value);
        case 'hover': return b.hover(tab, spec);
        case 'scroll': return b.scroll(tab, args.dy);
        case 'wait': return b.wait(tab, args.selector, args.ms);
        case 'back': return b.history(tab, -1);
        case 'forward': return b.history(tab, 1);
        case 'activate': return b.activate(tab);
        case 'close': return b.close(tab);
        case 'eval': return b.eval(tab, args.code);
        default: return { ok: false, error: `unknown browser op ${op}` };
      }
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  // Ask the renderer (which owns the <webview>s) to perform one operation.
  webOp(idOrName, op, args) {
    const win = this.d.getWindow();
    if (!win || win.isDestroyed()) return Promise.resolve({ ok: false, error: 'desktop window unavailable' });
    const w = this.resolveWidget(idOrName);
    if (w.error) return Promise.resolve({ ok: false, ...w });
    const id = w.id;
    if (op === 'screenshot') return this.webScreenshot(id, op, args);
    return this.webOpRaw(id, op, args);
  }

  webOpRaw(id, op, args) {
    const win = this.d.getWindow();
    if (!win || win.isDestroyed()) return Promise.resolve({ ok: false, error: 'desktop window unavailable' });
    const opId = crypto.randomBytes(6).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWebOps.delete(opId);
        resolve({ ok: false, error: `web widget did not respond within ${WEB_OP_TIMEOUT_MS / 1000}s` });
      }, WEB_OP_TIMEOUT_MS);
      this.pendingWebOps.set(opId, { resolve, timer });
      win.webContents.send('ai:web-op', { opId, id, op, args: args || {} });
    });
  }

  // Screenshot of a web widget: the renderer identifies the guest, main
  // captures it (the renderer sandbox cannot encode images).
  async webScreenshot(id, op, args) {
    const meta = await this.webOpRaw(id, op, args);
    if (!meta || !meta.ok || !meta.webContentsId) return meta;
    try {
      const wc = webContents.fromId(meta.webContentsId);
      if (!wc) return { ok: false, error: 'web widget page not found' };
      // capturePage waits for a frame; an unpainted (hidden or offscreen)
      // guest would wait forever, so bound it.
      const img = await Promise.race([
        wc.capturePage(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('the page did not produce a frame within 8s (is the widget visible?)')), 8000))
      ]);
      const w = img.getSize().width;
      const scaled = w > 1024 ? img.resize({ width: 1024 }) : img;
      const { webContentsId: _omit, ...rest } = meta;
      return { ...rest, images: [{ mime: 'image/jpeg', data: scaled.toJPEG(60).toString('base64') }] };
    } catch (err) {
      return { ok: false, error: `screenshot failed: ${err.message}` };
    }
  }

  // ---------------------------------------------------------- permissions
  async permit(call, override) {
    const mode = override || this.config().permission || 'ask';
    if (mode === 'allow') return true;
    if (mode === 'deny') return false;
    const win = this.d.getWindow();
    const summary = JSON.stringify(call.input || {}).slice(0, 300);
    const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'question',
      title: 'AI assistant wants to act',
      message: `Allow the assistant to run "${call.name}"?`,
      detail: summary,
      buttons: ['Allow once', 'Always allow (change in Settings)', 'Deny'],
      defaultId: 0, cancelId: 2, noLink: true
    });
    if (response === 1) this.d.updateSettings({ ai: { permission: 'allow' } });
    return response === 0 || response === 1;
  }

  // ---------------------------------------------------------- running
  // Streamed text arrives in tiny chunks (often 1-4 characters); coalesce
  // them per conversation into one IPC message every ~30 ms. Any other event
  // flushes the pending text first, so order is preserved.
  emit(conversationId, event) {
    const win = this.d.getWindow();
    if (!win || win.isDestroyed()) return;
    if (!this.deltaBuf) this.deltaBuf = new Map();
    if (event.type === 'delta') {
      const b = this.deltaBuf.get(conversationId);
      if (b) { b.text += event.text || ''; return; }
      const nb = { text: event.text || '', timer: setTimeout(() => this.flushDelta(conversationId), 30) };
      this.deltaBuf.set(conversationId, nb);
      return;
    }
    this.flushDelta(conversationId);
    win.webContents.send('ai:event', { conversationId, ...event });
  }

  flushDelta(conversationId) {
    const b = this.deltaBuf && this.deltaBuf.get(conversationId);
    if (!b) return;
    clearTimeout(b.timer);
    this.deltaBuf.delete(conversationId);
    const win = this.d.getWindow();
    if (b.text && win && !win.isDestroyed()) win.webContents.send('ai:event', { conversationId, type: 'delta', text: b.text });
  }

  // The newest `limit` messages for display (optionally those before
  // `before`), starting on a user message so every exchange is whole. Tool
  // screenshots are reduced to a thumbnail-sized first image.
  conversationView(id, limit = 80, before) {
    let c;
    try { c = this.conversations.get(id); } catch { return null; }
    const all = c.messages || [];
    const end = Math.max(0, Math.min(all.length, Number.isInteger(before) ? before : all.length));
    let start = Math.max(0, end - Math.max(10, Math.min(500, Number(limit) || 80)));
    while (start > 0 && all[start].role !== 'user') start--;
    const messages = all.slice(start, end).map((m) => (m.role === 'tool' && m.results
      ? { ...m, results: m.results.map((r) => ({ ...r, content: String(r.content || '').slice(0, 400), images: r.images && r.images[0] ? [r.images[0]] : undefined })) }
      : m));
    return { id: c.id, title: c.title, total: all.length, start, end, messages };
  }

  // Attached files are copied into the AI folder's Uploads, so the
  // conversation keeps working if the original moves, and the assistant has
  // its own copy. Files already in the AI folder, or over 200 MB, are used
  // where they are.
  async ingestUploads(paths) {
    const { ensureAiFolder, freeName, within } = require('../files');
    const fsp = require('fs/promises');
    const p = require('path');
    let dir;
    try { dir = await ensureAiFolder(this.d.store); } catch { return paths; }
    const uploads = p.join(dir, 'Uploads');
    const out = [];
    for (const src of paths) {
      try {
        const st = await fsp.stat(src);
        if (!st.isFile() || within(dir, src) || st.size > 200 * 1024 * 1024) { out.push(src); continue; }
        const target = p.join(uploads, await freeName(uploads, p.basename(src)));
        await fsp.copyFile(src, target);
        out.push(target);
      } catch { out.push(src); }
    }
    return out;
  }

  async send(conversationId, text, atts, opts = {}) {
    if (!this.enabled()) return { error: 'The AI assistant is disabled.' };
    const content = String(text || '').trim();
    const picked = (Array.isArray(atts) ? atts : []).filter((a) => a && typeof a.path === 'string').slice(0, 10).map((a) => a.path);
    const stored = opts.keepAttachmentPaths ? picked : await this.ingestUploads(picked);
    const files = stored.map((pth) => { try { return attachments.describe(pth); } catch { return null; } }).filter(Boolean);
    if (!content && !files.length) return { error: 'empty message' };
    let conv = null;
    if (conversationId) {
      try { conv = this.conversations.get(conversationId); } catch { conv = null; }
    }
    if (!conv) conv = this.conversations.create();
    const isTask = opts.source === 'schedule' || opts.source === 'task';
    const taskBusy = !isTask && this.taskRuns.size > 0;
    if (this.runs.has(conv.id) || taskBusy) {
      const q = this.queues.get(conv.id) || [];
      const item = { text: content, attachments: files, opts: { ...opts, requeue: undefined } };
      // A message taken off the queue that has to wait again keeps its place.
      if (opts.requeue) q.unshift(item); else q.push(item);
      this.queues.set(conv.id, q);
      this.emit(conv.id, { type: 'queue', items: q.map((x) => x.text || `(${(x.attachments || []).length} file${(x.attachments || []).length === 1 ? '' : 's'})`) });
      if (taskBusy && !this.runs.has(conv.id) && !opts.requeue) {
        const names = [...new Set(this.taskRuns.values())].map((n) => `"${n}"`).join(', ');
        this.emit(conv.id, { type: 'notice', text: `Queued: the scheduled task ${names} is running. Your message is sent as soon as it finishes.` });
      }
      return { queued: true, position: q.length, conversationId: conv.id, waitingForTask: taskBusy };
    }

    const c = this.config();
    const ep = this.endpoint(opts.endpoint);
    const preset = ep.preset;
    const forTasks = ep.id === 'task' ? ' (scheduled tasks)' : '';
    if (preset.needsKey && !this.apiKey(ep.keyField)) {
      return { error: `${preset.label}${forTasks} needs an API key - add one in Settings > AI assistant.`, conversationId: conv.id };
    }
    if (ep.id === 'task' && !ep.baseUrl && preset.kind !== 'anthropic') {
      return { error: `${preset.label} (scheduled tasks) needs a server address - add one in Settings > AI assistant.`, conversationId: conv.id };
    }
    const model = opts.model || (ep.id === 'task' ? preset.model : (c.model || preset.model));
    if (!model) return { error: `Choose a model${ep.id === 'task' ? ' for scheduled tasks' : ''} in Settings > AI assistant.`, conversationId: conv.id };

    this.conversations.append(conv.id, { role: 'user', content, ...(files.length ? { attachments: files } : {}) });
    this.emit(conv.id, { type: 'user', content, attachments: files, title: conv.title, index: this.conversations.get(conv.id).messages.length - 1 });
    return this.runConversation(conv, opts);
  }

  // One agent turn over the conversation as it stands on disk (the user's
  // message already appended). Shared by send() and resume().
  // The model a scheduled task runs on (see runTask).
  taskModel(task) {
    const c = this.config();
    const ep = this.endpoint('task');
    const fallback = ep.id === 'task' ? ep.preset.model : (c.model || ep.preset.model);
    return String((task && task.model) || c.taskModel || fallback || '').trim();
  }

  async runConversation(conv, opts = {}) {
    const c = this.config();
    const ep = this.endpoint(opts.endpoint);
    const preset = ep.preset;
    let model = String(opts.model || c.model || preset.model || '').trim();
    const emitEarly = (ev) => this.emit(conv.id, ev);
    const server = preset.local ? this.serverKey(ep.baseUrl) : '';
    // A server shared with my other devices: when my model is not loaded but
    // one of theirs is, use theirs for this turn instead of swapping.
    if (server && c.followSharedModel !== false) {
      try {
        const be = this.backend(ep);
        const st = be ? await be.b.status(model, { fresh: true }) : null;
        if (st && !st.loaded && st.others && st.others.length) {
          const pick = this.shared.choose(server, model, st.others);
          if (pick) {
            emitEarly({ type: 'notice', text: `Using ${pick.model} - it is already loaded on the shared server for ${pick.device} - instead of swapping it out for ${model}.` });
            model = pick.model;
          }
        }
      } catch { /* status unavailable: carry on with our model */ }
    }
    if (server) this.shared.announce(server, model, true);
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.runs.set(conv.id, controller);
    if (opts.source === 'schedule' || opts.source === 'task') this.taskRuns.set(conv.id, String(opts.taskName || 'task'));
    const emit = (ev) => this.emit(conv.id, ev);
    const run = { ep, model, restart: null, stalled: false, blockedShown: false, autoTimer: null, unattended: opts.source === 'schedule' || opts.source === 'task' };
    this.runInfo.set(conv.id, run);
    try {
      const provider = this.provider(ep);
      const result = await runTurn({
        provider, model, conversation: conv, ctx: this.toolContext(conv.id),
        permit: (call) => this.permit(call, opts.permission), emit, signal: controller.signal,
        maxSteps: Math.max(1, Math.min(500, Number(opts.maxSteps) || Number(c.maxSteps) || 12)),
        context: {
          toolMode: c.toolCalls || 'auto',
          session: this.toolSession(model, ep),
          budget: this.contextBudget(ep), calibration: this.calibration(model, ep), compactWithModel: c.compactWithModel !== false,
          checkBackend: () => this.checkBackend(model, emit, ep),
          registerStep: (fn) => { run.restart = fn; },
          onStall: (stage) => { this.onStall(conv.id, stage, emit).catch(() => {}); }
        }
      });
      // Finished (or stopped): the model unloads after the configured idle
      // time. Not after an error - that could load a model that failed.
      if (result && !result.error) this.refreshKeepAlive(model, ep);
      // A server that went away mid-task: the renderer polls and resumes.
      if (result && result.error && result.retryable) emit({ type: 'offline', message: result.error, local: !!preset.local });
      emit({ type: 'done', ...result });
      return { conversationId: conv.id, ...result };
    } catch (err) {
      emit({ type: 'error', message: err.message });
      emit({ type: 'done', error: err.message });
      return { conversationId: conv.id, error: err.message };
    } finally {
      clearTimeout(run.autoTimer);
      if (server) this.shared.announce(server, model, false);
      this.runInfo.delete(conv.id);
      this.runs.delete(conv.id);
      // Next queued message becomes the next turn, in order.
      const q = this.queues.get(conv.id);
      if (q && q.length) {
        const next = q.shift();
        this.emit(conv.id, { type: 'queue', items: q.map((x) => x.text || '(files)') });
        setImmediate(() => this.send(conv.id, next.text, next.attachments, { ...(next.opts || {}), requeue: true }));
      }
      // The last task run finished: messages that waited for it go now.
      if (this.taskRuns.delete(conv.id) && !this.taskRuns.size) this.releaseQueued();
    }
  }

  // Start the next waiting message in every idle conversation.
  releaseQueued() {
    for (const [id, q] of this.queues) {
      if (!q || !q.length || this.runs.has(id)) continue;
      const next = q.shift();
      this.emit(id, { type: 'queue', items: q.map((x) => x.text || '(files)') });
      setImmediate(() => this.send(id, next.text, next.attachments, { ...(next.opts || {}), requeue: true }));
    }
  }

  queue(conversationId) {
    return (this.queues.get(conversationId) || []).slice();
  }

  unqueue(conversationId, index) {
    const q = this.queues.get(conversationId);
    if (!q || index < 0 || index >= q.length) return false;
    q.splice(index, 1);
    this.emit(conversationId, { type: 'queue', items: q.slice() });
    return true;
  }

  stop(conversationId) {
    // Stop means stop: the current turn and everything waiting behind it.
    if (this.queues.has(conversationId)) {
      this.queues.delete(conversationId);
      this.emit(conversationId, { type: 'queue', items: [] });
    }
    const c = this.runs.get(conversationId);
    if (c) c.abort();
    return !!c;
  }

  // Entry point from the search bar / Spotlight: the widget takes the
  // question into its current conversation (the renderer decides which).
  askFromSearch(text) {
    if (!this.enabled()) return false;
    const win = this.d.getWindow();
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      win.webContents.send('ai:ask', String(text || ''));
    }
    return true;
  }

  // Chat widget pin: keep the sidebar above other windows while an agentic
  // task runs. A transient override - the saved alwaysOnTop setting is not
  // touched; the window code consults isPinned() when it decides to sink.
  setPinned(on) {
    this.pinned = !!on;
    this.d.setPinned(this.pinned);
    return this.pinned;
  }

  isPinned() { return this.pinned; }

  // A visual as a standalone page in the AI folder (Visuals/<title>.html),
  // kept current: the same file is rewritten when the visual changes. The
  // page is the one the widget shows (same CSP: no network but CDN scripts).
  async exportVisual(id) {
    const v = this.visuals.get(id);
    if (!v) return null;
    const page = this.visuals.page(id);
    if (!page) return null;
    const { ensureAiFolder, freeName } = require('../files');
    const p = require('path');
    const fsp = require('fs/promises');
    const base = await ensureAiFolder(this.d.store);
    const dir = p.join(base, 'AI Artifacts');
    // Before 1.3.0 this folder was "Visuals": move it over once.
    try { await fsp.access(dir); } catch {
      try { await fsp.rename(p.join(base, 'Visuals'), dir); } catch { /* there was none */ }
      for (const v of this.visuals.list()) {
        if (v.exportedAs && p.dirname(v.exportedAs) === p.join(base, 'Visuals')) { const r = this.visuals.get(v.id); r.exportedAs = p.join(dir, p.basename(v.exportedAs)); }
      }
      this.visuals.saveIndex();
    }
    await fsp.mkdir(dir, { recursive: true });
    let file = v.exportedAs && p.dirname(v.exportedAs) === dir ? v.exportedAs : null;
    if (!file) {
      const safe = String(v.title || 'Visual').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Visual';
      file = p.join(dir, await freeName(dir, `${safe}.html`));
      v.exportedAs = file;
      this.visuals.saveIndex();
    }
    const html = String(page).replace(/<head>/i, `<head><meta charset="utf-8"><title>${String(v.title || 'Visual').replace(/[<&]/g, '')}</title>`);
    await fsp.writeFile(file, html, 'utf8');
    return file;
  }

  // A widget wants to reach sites: ask the user (native dialog).
  async approveWidgetHosts(w, hosts) {
    const { dialog } = require('electron');
    const win = this.d.getWindow();
    const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'AI widget', message: `Allow the widget "${w.title}" to reach these sites?`,
      detail: `${hosts.map((h) => `  ${h}`).join('\n')}\n\nThe assistant made this widget. Without approval it still shows, but cannot load anything from these sites. You can revoke this in Settings > AI assistant > AI widgets.`
    });
    return r.response === 0;
  }

  visualsChanged() {
    const win = this.d.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('ai:visuals', this.visuals.list().filter((v) => v.where === 'desktop'));
  }

  // ---------------------------------------------------------- IPC
  registerIpc() {
    ipcMain.handle('ai:status', () => this.status());
    ipcMain.handle('ai:set-key', (_e, key) => { this.setApiKey(String(key || '')); return this.status(); });
    ipcMain.handle('ai:set-task-key', (_e, key) => { this.setApiKey(String(key || ''), 'taskApiKey'); return this.status(); });
    ipcMain.handle('ai:models', async (_e, which) => {
      const p = this.provider(this.endpoint(which === 'task' ? 'task' : 'chat'));
      try { return { models: await p.listModels() }; } catch (err) {
        return { error: p.describeError ? p.describeError(err) : err.message };
      }
    });
    ipcMain.handle('ai:conversations', () => this.conversations.list());
    ipcMain.handle('ai:conversation', (_e, id) => { try { return this.conversations.get(id); } catch { return null; } });
    ipcMain.handle('ai:conversation-view', (_e, id, limit, before) => this.conversationView(String(id || ''), Number(limit) || 80, before == null ? undefined : Number(before)));
    ipcMain.handle('ai:new', () => this.conversations.create());
    ipcMain.handle('ai:rename', (_e, id, title) => this.conversations.rename(id, title));
    ipcMain.handle('ai:delete', (_e, id) => { this.stop(id); this.conversations.remove(id); return true; });
    ipcMain.handle('ai:send', (_e, id, text, atts) => this.send(id, text, atts));
    ipcMain.handle('ai:tasks', () => {
      const me = this.d.deviceId ? this.d.deviceId() : '';
      return this.scheduler.list().map((t) => (t.device && t.device !== me ? { ...t, elsewhere: t.deviceName || 'another device' } : t));
    });
    // Local / Synced: a conversation that stays on this device, or not.
    ipcMain.handle('ai:conv-local', (_e, id, local) => { try { this.conversations.setLocal(String(id), !!local); this.d.stateChanged && this.d.stateChanged(); return true; } catch { return false; } });
    ipcMain.handle('ai:conv-menu', (_e, id) => new Promise((resolve) => {
      let c = null;
      try { c = this.conversations.get(String(id)); } catch { resolve(null); return; }
      const { Menu } = require('electron');
      let chosen = null;
      const bus = /^AI bus · /.test(c.title);
      const dev = this.d.store.get('devices') || {};
      if (!dev.enabled || !(dev.sync || {}).conversations) {
        Menu.buildFromTemplate([{ label: 'Conversation sync is off (Settings > Devices)', enabled: false }])
          .popup({ window: this.d.getWindow(), callback: () => setImmediate(() => resolve(null)) });
        return;
      }
      Menu.buildFromTemplate([
        { label: c.local || bus ? 'Local - on this device only' : 'Synced to your devices', enabled: false },
        { type: 'separator' },
        { label: 'Sync to my devices', type: 'radio', checked: !c.local && !bus, enabled: !bus, click: () => { chosen = 'synced'; } },
        { label: 'Keep on this device only', type: 'radio', checked: !!c.local || bus, enabled: !bus, click: () => { chosen = 'local'; } }
      ]).popup({ window: this.d.getWindow(), callback: () => setImmediate(() => resolve(chosen)) });
    }));
    ipcMain.handle('ai:task-save', (_e, task) => { try { return this.scheduler.upsert(task); } catch (err) { return { error: err.message }; } });
    ipcMain.handle('ai:task-delete', (_e, id) => { this.scheduler.remove(String(id)); return true; });
    ipcMain.handle('ai:task-toggle', (_e, id, enabled) => this.scheduler.patch(String(id), { enabled: !!enabled }));
    ipcMain.handle('ai:task-run', (_e, id) => { this.scheduler.runTask(String(id)); return true; });
    ipcMain.handle('ai:task-preview', (_e, when) => {
      const { upcoming, validateTask, normalizeWhen } = require('./scheduler');
      try {
        const now = Date.now();
        const times = upcoming(String(when || ''), now, 3, now);
        const err = validateTask({ name: 'x', prompt: 'x', when: String(when || ''), createdAt: now }, { now });
        return { ok: !err, error: err || null, times, normalized: normalizeWhen(when) };
      } catch (err) { return { ok: false, error: err.message, times: [] }; }
    });
    ipcMain.handle('ai:memory', () => this.memory.list());
    ipcMain.handle('ai:memory-forget', (_e, id) => this.memory.forget(String(id)));
    ipcMain.handle('ai:memory-clear', () => { this.memory.clear(); return true; });
    ipcMain.handle('ai:memory-add', (_e, text) => { try { return this.memory.remember(String(text || '')); } catch (err) { return { error: err.message }; } });
    ipcMain.handle('ai:browser-info', () => this.browser.info());
    ipcMain.handle('ai:pick-files', async () => {
      const win = this.d.getWindow();
      const { canceled, filePaths } = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
        title: 'Attach files to your message',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Images, documents and text', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'json', 'csv', 'log', 'js', 'ts', 'py', 'html', 'css', 'xml', 'yaml', 'yml'] },
          { name: 'All files', extensions: ['*'] }
        ]
      });
      if (canceled) return [];
      return filePaths.map((p) => { try { return attachments.describe(p); } catch { return null; } }).filter(Boolean);
    });
    ipcMain.handle('ai:stop', (_e, id) => this.stop(id));
    ipcMain.handle('ai:browsers', () => { try { return require('./browser').listBrowsers().map(({ key, name, cdp }) => ({ key, name, cdp })); } catch { return []; } });
    ipcMain.handle('ai:evict-blocking', (_e, id) => this.evictBlocking(String(id || '')));
    ipcMain.handle('ai:queue', (_e, id) => this.queue(id));
    ipcMain.handle('ai:unqueue', (_e, id, index) => this.unqueue(id, Number(index)));
    ipcMain.handle('ai:pin', (_e, on) => this.setPinned(on));
    ipcMain.handle('ai:probe', () => this.probe());
    ipcMain.handle('ai:widgets', () => this.widgets.list());
    ipcMain.handle('ai:widget-bridge', async (_e, id, op, args) => {
      try {
        if (op === 'load') return { result: await this.widgets.getState(String(id)) };
        if (op === 'save') return { result: await this.widgets.setState(String(id), args) };
        if (op === 'fetch') return { result: await this.widgets.fetch(String(id), args || {}) };
        return { error: 'unknown request' };
      } catch (err) { return { error: err.message }; }
    });
    ipcMain.handle('ai:widget-remove', (_e, id) => this.widgets.remove(String(id), (dir) => require('electron').shell.trashItem(dir)));
    ipcMain.handle('ai:widget-folder', (_e, id) => { const w = this.widgets.get(String(id)); if (w) require('electron').shell.openPath(w.dir); return !!w; });
    ipcMain.handle('ai:widget-approve', async (_e, id) => { const w = this.widgets.get(String(id)); if (!w) return null; await this.widgets.askHosts(w); this.widgets.onChange(this.widgets.list()); return this.widgets.list().find((x) => x.id === w.id); });
    ipcMain.handle('ai:widget-revoke', (_e, id) => { this.widgets.revoke(String(id)); return true; });
    ipcMain.handle('ai:visuals', () => this.visuals.list().filter((v) => v.where === 'desktop'));
    ipcMain.handle('ai:visual-delete', (_e, id) => { const ok = this.visuals.remove(String(id || '')); this.visualsChanged(); return ok; });
    ipcMain.handle('ai:visual-where', async (_e, id, where) => {
      const v = this.visuals.get(String(id || ''));
      if (!v) return false;
      v.where = where === 'desktop' ? 'desktop' : 'chat';
      v.updatedAt = Date.now();
      this.visuals.saveIndex();
      this.visualsChanged();
      // Closing a desktop visual keeps it for later: a page in AI Folder/Visuals.
      let saved = null;
      if (v.where === 'chat') { try { saved = await this.exportVisual(v.id); } catch { saved = null; } }
      return { ok: true, saved };
    });
    ipcMain.handle('ai:delete-message', (_e, id, index, which) => this.deleteMessage(String(id || ''), Number(index), which === 'reply' ? 'reply' : 'turn'));
    ipcMain.handle('ai:resend', (_e, id, index, text) => this.resendFrom(String(id || ''), Number(index), typeof text === 'string' ? text : undefined));
    ipcMain.handle('ai:resume', (_e, id) => this.resume(String(id || '')));
    ipcMain.handle('ai:compact', (_e, id) => this.compact(String(id || '')));
    ipcMain.handle('ai:context', (_e, id) => {
      try {
        const conv = this.conversations.get(String(id || ''));
        const prep = ctxbuf.prepare(conv, { budget: this.contextBudget(), cpt: this.calibration().cpt });
        return { tokens: prep.tokens, budget: this.contextBudget(), compacted: !!conv.summary, compactions: conv.compactions || 0 };
      } catch { return null; }
    });
    ipcMain.on('ai:web-op:result', (_e, { opId, result }) => {
      const p = this.pendingWebOps.get(opId);
      if (!p) return;
      clearTimeout(p.timer);
      this.pendingWebOps.delete(opId);
      p.resolve(result);
    });
  }
}

module.exports = { AiService };
