// Notification center: one place for everything that wants the user's
// attention - web widgets' page notifications, the AI assistant, updates and
// downloads. Persisted so nothing is lost across restarts; the dock renders
// the bell and badge from the broadcast state.
const fs = require('fs');
const crypto = require('crypto');

const MAX_ITEMS = 200;

class NotificationCenter {
  // { file, getWindow, toast(title, body, onClick) }
  constructor({ file, getWindow, toast }) {
    this.file = file;
    this.getWindow = getWindow;
    this.toast = toast;
    this.items = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) this.items = raw.slice(0, MAX_ITEMS);
    } catch { /* first run */ }
  }

  // source: 'web' | 'ai' | 'system' | 'os' (another app's desktop
  // notification, Linux); sourceId: web widget id when web.
  add({ source = 'system', sourceId = null, sourceName = '', title, body = '', url = null, icon = null, toast = true }) {
    const item = {
      id: crypto.randomBytes(6).toString('hex'), ts: Date.now(),
      source, sourceId, sourceName: String(sourceName || '').slice(0, 80),
      title: String(title || '').slice(0, 200), body: String(body || '').slice(0, 1000),
      url: typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null,
      icon: typeof icon === 'string' && /^(https?:|data:image\/)/i.test(icon) ? icon.slice(0, 4000) : null,
      read: false
    };
    this.items.unshift(item);
    if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS;
    this.save();
    this.broadcast();
    if (toast && this.toast) this.toast(item.title, item.body, () => this.open(item.id));
    return item;
  }

  list() {
    return { items: this.items, unread: this.items.filter((i) => !i.read).length };
  }

  markRead(id) {
    for (const i of this.items) if (!id || i.id === id) i.read = true;
    this.save();
    this.broadcast();
  }

  remove(id) {
    this.items = this.items.filter((i) => i.id !== id);
    this.save();
    this.broadcast();
  }

  clear() {
    this.items = [];
    this.save();
    this.broadcast();
  }

  // The renderer decides how to act on an item (focus a web widget, open a
  // link); main only marks it read and forwards.
  open(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    item.read = true;
    this.save();
    this.broadcast();
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      win.webContents.send('notifications:open', item);
    }
  }

  broadcast() {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('notifications:changed', this.list());
  }

  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.items), 'utf8'); } catch { /* best effort */ }
  }
}

module.exports = { NotificationCenter, MAX_ITEMS };
