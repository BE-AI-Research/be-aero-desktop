// AI service: owns provider configuration (keys encrypted at rest),
// conversations, the permission prompt, the web-frame operation bridge to
// the renderer, the chat widget's pin-on-top override, and the IPC surface
// the chat widget and Spotlight use.
const path = require('path');
const crypto = require('crypto');
const { ipcMain, dialog, safeStorage, shell } = require('electron');
const { Conversations } = require('./conversations');
const { createProvider, PRESETS } = require('./providers');
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
    this.runs = new Map();          // conversationId -> AbortController
    this.queues = new Map();        // conversationId -> [text] waiting for the current turn
    this.pendingWebOps = new Map(); // opId -> { resolve, timer }
    this.pinned = false;
    this.calibrations = new Map();  // provider|model -> chars-per-token learned from usage
    this.memory = new Memory(path.join(deps.userDataDir, 'ai', 'memory.json'));
    this.browser = new BrowserController({
      profileDir: path.join(deps.userDataDir, 'ai', 'browser-profile'),
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
      onChange: (list) => { const w = this.d.getWindow(); if (w && !w.isDestroyed()) w.webContents.send('ai:tasks', list); }
    });
    this.scheduler.start();
    this.registerIpc();
  }

  // A scheduled task runs in its own conversation with its own permission
  // policy: unattended runs never raise a dialog - "ask" means read-only.
  async runTask(task, { scheduled } = {}) {
    if (!this.enabled()) return { error: 'AI assistant is disabled' };
    let convId = task.conversationMode === 'shared' ? task.conversationId : null;
    if (convId) { try { this.conversations.get(convId); } catch { convId = null; } }
    if (!convId) {
      const c = this.conversations.create();
      this.conversations.rename(c.id, `Task: ${task.name}`);
      convId = c.id;
    }
    const globalMode = this.config().permission || 'ask';
    const permission = task.permission && task.permission !== 'inherit'
      ? task.permission : (globalMode === 'ask' ? 'deny' : globalMode);
    const result = await this.send(convId, task.prompt, [], { permission, source: scheduled ? 'schedule' : 'task' });
    try {
      const conv = this.conversations.get(convId);
      const last = [...conv.messages].reverse().find((m) => m.role === 'assistant' && m.content);
      this.d.notify(`Task "${task.name}" ${result.error ? 'failed' : 'finished'}`,
        result.error ? String(result.error) : String(last ? last.content : '').replace(/\s+/g, ' ').slice(0, 160));
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

  apiKey() {
    const raw = this.config().apiKey || '';
    if (!raw) return '';
    if (raw.startsWith('enc:')) {
      try {
        return safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64')) : '';
      } catch { return ''; }
    }
    return raw;
  }

  setApiKey(plain) {
    let stored = plain || '';
    if (stored && safeStorage.isEncryptionAvailable()) {
      stored = 'enc:' + safeStorage.encryptString(stored).toString('base64');
    }
    this.d.updateSettings({ ai: { apiKey: stored } });
  }

  provider() {
    const c = this.config();
    return createProvider({ provider: c.provider || 'anthropic', baseUrl: c.baseUrl || '', apiKey: this.apiKey() });
  }

  preset() {
    return PRESETS[this.config().provider] || PRESETS.custom;
  }

  // Token budget for one request: the user's number, else a default for
  // the provider kind (local servers get a small one).
  contextBudget() {
    const c = this.config();
    const p = this.preset();
    return ctxbuf.budgetFor(c.provider || 'anthropic', p.kind, c.contextTokens, !!p.local);
  }

  calibration() {
    const key = `${this.config().provider}|${this.config().model}`;
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
        list: () => this.scheduler.list().map((t) => ({ id: t.id, name: t.name, prompt: t.prompt, schedule: t.schedule, enabled: t.enabled !== false, nextRun: t.nextRun, lastStatus: t.lastStatus || null, permission: t.permission })),
        add: (task) => this.scheduler.upsert(task),
        remove: (id) => this.scheduler.remove(id)
      },
      files: {
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
  emit(conversationId, event) {
    const win = this.d.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('ai:event', { conversationId, ...event });
  }

  async send(conversationId, text, atts, opts = {}) {
    if (!this.enabled()) return { error: 'The AI assistant is disabled.' };
    const content = String(text || '').trim();
    const files = (Array.isArray(atts) ? atts : []).filter((a) => a && typeof a.path === 'string').slice(0, 10)
      .map((a) => { try { return attachments.describe(a.path); } catch { return null; } }).filter(Boolean);
    if (!content && !files.length) return { error: 'empty message' };
    let conv = null;
    if (conversationId) {
      try { conv = this.conversations.get(conversationId); } catch { conv = null; }
    }
    if (!conv) conv = this.conversations.create();
    if (this.runs.has(conv.id)) {
      const q = this.queues.get(conv.id) || [];
      q.push({ text: content, attachments: files });
      this.queues.set(conv.id, q);
      this.emit(conv.id, { type: 'queue', items: q.map((x) => x.text || `(${(x.attachments || []).length} file${(x.attachments || []).length === 1 ? '' : 's'})`) });
      return { queued: true, position: q.length, conversationId: conv.id };
    }

    const c = this.config();
    const preset = PRESETS[c.provider] || PRESETS.custom;
    if (preset.needsKey && !this.apiKey()) {
      return { error: `${preset.label} needs an API key - add one in Settings > AI assistant.`, conversationId: conv.id };
    }
    const model = c.model || preset.model;
    if (!model) return { error: 'Choose a model in Settings > AI assistant.', conversationId: conv.id };

    this.conversations.append(conv.id, { role: 'user', content, ...(files.length ? { attachments: files } : {}) });
    this.emit(conv.id, { type: 'user', content, attachments: files, title: conv.title });
    return this.runConversation(conv, opts);
  }

  // One agent turn over the conversation as it stands on disk (the user's
  // message already appended). Shared by send() and resume().
  async runConversation(conv, opts = {}) {
    const c = this.config();
    const preset = this.preset();
    const model = c.model || preset.model;
    const controller = new AbortController();
    this.runs.set(conv.id, controller);
    const emit = (ev) => this.emit(conv.id, ev);
    try {
      const provider = this.provider();
      const result = await runTurn({
        provider, model, conversation: conv, ctx: this.toolContext(conv.id),
        permit: (call) => this.permit(call, opts.permission), emit, signal: controller.signal,
        maxSteps: Math.max(1, Math.min(500, Number(c.maxSteps) || 12)),
        context: { budget: this.contextBudget(), calibration: this.calibration(), compactWithModel: c.compactWithModel !== false }
      });
      // A server that went away mid-task: the renderer polls and resumes.
      if (result && result.error && result.retryable) emit({ type: 'offline', message: result.error, local: !!preset.local });
      emit({ type: 'done', ...result });
      return { conversationId: conv.id, ...result };
    } catch (err) {
      emit({ type: 'error', message: err.message });
      emit({ type: 'done', error: err.message });
      return { conversationId: conv.id, error: err.message };
    } finally {
      this.runs.delete(conv.id);
      // Next queued message becomes the next turn, in order.
      const q = this.queues.get(conv.id);
      if (q && q.length) {
        const next = q.shift();
        this.emit(conv.id, { type: 'queue', items: q.map((x) => x.text || '(files)') });
        setImmediate(() => this.send(conv.id, next.text, next.attachments));
      }
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

  // ---------------------------------------------------------- IPC
  registerIpc() {
    ipcMain.handle('ai:status', () => this.status());
    ipcMain.handle('ai:set-key', (_e, key) => { this.setApiKey(String(key || '')); return this.status(); });
    ipcMain.handle('ai:models', async () => {
      const p = this.provider();
      try { return { models: await p.listModels() }; } catch (err) {
        return { error: p.describeError ? p.describeError(err) : err.message };
      }
    });
    ipcMain.handle('ai:conversations', () => this.conversations.list());
    ipcMain.handle('ai:conversation', (_e, id) => { try { return this.conversations.get(id); } catch { return null; } });
    ipcMain.handle('ai:new', () => this.conversations.create());
    ipcMain.handle('ai:rename', (_e, id, title) => this.conversations.rename(id, title));
    ipcMain.handle('ai:delete', (_e, id) => { this.stop(id); this.conversations.remove(id); return true; });
    ipcMain.handle('ai:send', (_e, id, text, atts) => this.send(id, text, atts));
    ipcMain.handle('ai:tasks', () => this.scheduler.list());
    ipcMain.handle('ai:task-save', (_e, task) => { try { return this.scheduler.upsert(task); } catch (err) { return { error: err.message }; } });
    ipcMain.handle('ai:task-delete', (_e, id) => { this.scheduler.remove(String(id)); return true; });
    ipcMain.handle('ai:task-toggle', (_e, id, enabled) => this.scheduler.patch(String(id), { enabled: !!enabled }));
    ipcMain.handle('ai:task-run', (_e, id) => { this.scheduler.runTask(String(id)); return true; });
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
    ipcMain.handle('ai:queue', (_e, id) => this.queue(id));
    ipcMain.handle('ai:unqueue', (_e, id, index) => this.unqueue(id, Number(index)));
    ipcMain.handle('ai:pin', (_e, on) => this.setPinned(on));
    ipcMain.handle('ai:probe', () => this.probe());
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
