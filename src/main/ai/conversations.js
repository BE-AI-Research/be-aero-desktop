// Conversation persistence for the AI assistant: one JSON file per
// conversation under <userData>/ai/conversations. Messages are stored in
// the provider-neutral shape the agent loop uses, so switching providers
// never invalidates history:
//   { role: 'user', content, ts }
//   { role: 'assistant', content, toolCalls?: [{ id, name, input }], ts }
//   { role: 'tool', results: [{ id, name, content, isError }], ts }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TITLE = 60;

function titleFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New conversation';
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1) + '…' : t;
}

class Conversations {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
  }

  file(id) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('bad conversation id');
    return path.join(this.dir, `${id}.json`);
  }

  list() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const out = [];
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = this.get(f.slice(0, -5));
        out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length });
      } catch { /* skip corrupt file */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const c = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    if (!c || !Array.isArray(c.messages)) throw new Error('corrupt conversation');
    this.cache.set(id, c);
    return c;
  }

  create(title) {
    const id = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const c = { id, title: title || 'New conversation', createdAt: now, updatedAt: now, messages: [] };
    this.cache.set(id, c);
    this.save(c);
    return c;
  }

  append(id, message) {
    const c = this.get(id);
    c.messages.push({ ...message, ts: Date.now() });
    c.updatedAt = Date.now();
    if (message.role === 'user' && c.title === 'New conversation') c.title = titleFrom(message.content);
    this.save(c);
    return c;
  }

  // Record a compaction: `summary` stands in for messages[0..compactedAt).
  // The messages stay on disk and in the UI; only the request shrinks.
  setSummary(id, summary, compactedAt) {
    const c = this.get(id);
    c.summary = String(summary || '');
    c.compactedAt = Math.max(0, Math.min(c.messages.length, Number(compactedAt) || 0));
    c.compactions = (c.compactions || 0) + 1;
    c.updatedAt = Date.now();
    this.save(c);
    return c;
  }

  rename(id, title) {
    const c = this.get(id);
    c.title = titleFrom(title);
    c.updatedAt = Date.now();
    this.save(c);
    return c;
  }

  remove(id) {
    this.cache.delete(id);
    try { fs.unlinkSync(this.file(id)); } catch { /* already gone */ }
  }

  save(c) {
    const tmp = this.file(c.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf8');
    fs.renameSync(tmp, this.file(c.id));
  }
}

module.exports = { Conversations, titleFrom };
