// AI service: owns provider configuration (keys encrypted at rest),
// conversations, the permission prompt, the web-frame operation bridge to
// the renderer, the chat widget's pin-on-top override, and the IPC surface
// the chat widget and Spotlight use.
const path = require('path');
const crypto = require('crypto');
const { ipcMain, dialog, safeStorage, shell } = require('electron');
const { Conversations } = require('./conversations');
const { createProvider, PRESETS } = require('./providers');
const { runTurn } = require('./agent');
const { webSearch, fetchPage } = require('./websearch');
const attachments = require('./attachments');
const { TaskScheduler } = require('./scheduler');
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

  status() {
    const c = this.config();
    const preset = PRESETS[c.provider] || PRESETS.custom;
    return {
      enabled: this.enabled(), provider: c.provider || 'anthropic', presetLabel: preset.label,
      baseUrl: c.baseUrl || preset.baseUrl, model: c.model || preset.model,
      hasKey: !!this.apiKey(), needsKey: preset.needsKey, permission: c.permission || 'ask',
      systemPrompt: c.systemPrompt || '', pinned: this.pinned,
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, model: p.model, needsKey: p.needsKey }))
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
      tasks: {
        list: () => d.tasks.list(),
        action: (name, id) => d.tasks.action(name, id)
      },
      createWebWidget: (url, name) => {
        const id = 'w' + crypto.randomBytes(4).toString('hex');
        const list = [...(d.store.get('webWidgets') || []), { id, url, name: name || new URL(url).hostname }];
        d.updateSettings({ webWidgets: list });
        return id;
      },
      webOp: (id, op, args) => this.webOp(id, op, args),
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

  // Ask the renderer (which owns the <webview>s) to perform one operation.
  webOp(id, op, args) {
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

    const controller = new AbortController();
    this.runs.set(conv.id, controller);
    const emit = (ev) => this.emit(conv.id, ev);
    try {
      const provider = this.provider();
      const result = await runTurn({
        provider, model, conversation: conv, ctx: this.toolContext(conv.id),
        permit: (call) => this.permit(call, opts.permission), emit, signal: controller.signal,
        maxSteps: Math.max(1, Math.min(500, Number(c.maxSteps) || 12))
      });
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
