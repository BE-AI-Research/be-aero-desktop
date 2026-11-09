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
    this.registerIpc();
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
  async permit(call) {
    const mode = this.config().permission || 'ask';
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

  async send(conversationId, text) {
    if (!this.enabled()) return { error: 'The AI assistant is disabled.' };
    const content = String(text || '').trim();
    if (!content) return { error: 'empty message' };
    let conv = null;
    if (conversationId) {
      try { conv = this.conversations.get(conversationId); } catch { conv = null; }
    }
    if (!conv) conv = this.conversations.create();
    if (this.runs.has(conv.id)) {
      const q = this.queues.get(conv.id) || [];
      q.push(content);
      this.queues.set(conv.id, q);
      this.emit(conv.id, { type: 'queue', items: q.slice() });
      return { queued: true, position: q.length, conversationId: conv.id };
    }

    const c = this.config();
    const preset = PRESETS[c.provider] || PRESETS.custom;
    if (preset.needsKey && !this.apiKey()) {
      return { error: `${preset.label} needs an API key - add one in Settings > AI assistant.`, conversationId: conv.id };
    }
    const model = c.model || preset.model;
    if (!model) return { error: 'Choose a model in Settings > AI assistant.', conversationId: conv.id };

    this.conversations.append(conv.id, { role: 'user', content });
    this.emit(conv.id, { type: 'user', content, title: conv.title });

    const controller = new AbortController();
    this.runs.set(conv.id, controller);
    const emit = (ev) => this.emit(conv.id, ev);
    try {
      const provider = this.provider();
      const result = await runTurn({
        provider, model, conversation: conv, ctx: this.toolContext(conv.id),
        permit: (call) => this.permit(call), emit, signal: controller.signal,
        maxSteps: Math.max(1, Math.min(30, Number(c.maxSteps) || 12))
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
        this.emit(conv.id, { type: 'queue', items: q.slice() });
        setImmediate(() => this.send(conv.id, next));
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
    ipcMain.handle('ai:send', (_e, id, text) => this.send(id, text));
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
