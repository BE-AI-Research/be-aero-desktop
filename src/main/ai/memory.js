// Global memory: durable facts the assistant keeps across conversations -
// who the user is, how they like things done, what they are working on.
// One JSON file; every entry is visible and deletable in Settings.
const fs = require('fs');
const crypto = require('crypto');

const MAX_ENTRIES = 400;
const MAX_TEXT = 500;
const DEFAULT_SUMMARY_CHARS = 4000;

class Memory {
  constructor(file) {
    this.file = file;
    this.items = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) this.items = raw;
    } catch { /* first run */ }
  }

  list() {
    return this.items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // Add or refresh. Identical text refreshes the existing entry instead of
  // piling up copies of the same fact.
  remember(text, tags) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!t) throw new Error('nothing to remember');
    const key = t.toLowerCase();
    const now = Date.now();
    const existing = this.items.find((i) => i.text.toLowerCase() === key);
    if (existing) {
      existing.updatedAt = now;
      if (tags && tags.length) existing.tags = [...new Set([...(existing.tags || []), ...tags.map(String)])].slice(0, 8);
      this.save();
      return existing;
    }
    const item = { id: crypto.randomBytes(5).toString('hex'), text: t, tags: (tags || []).map(String).slice(0, 8), createdAt: now, updatedAt: now };
    this.items.push(item);
    if (this.items.length > MAX_ENTRIES) {
      this.items.sort((a, b) => a.updatedAt - b.updatedAt).splice(0, this.items.length - MAX_ENTRIES);
    }
    this.save();
    return item;
  }

  forget(id) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length !== before) this.save();
    return this.items.length !== before;
  }

  clear() {
    this.items = [];
    this.save();
  }

  recall(query, limit = 20) {
    const q = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    return this.items.map((i) => {
      const hay = (i.text + ' ' + (i.tags || []).join(' ')).toLowerCase();
      return { i, score: q.length ? q.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) : 1 };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.i.updatedAt - a.i.updatedAt)
      .slice(0, limit).map((x) => x.i);
  }

  // What goes into the system prompt: newest first, bounded.
  summary(maxChars = DEFAULT_SUMMARY_CHARS) {
    const lines = [];
    let used = 0;
    for (const i of this.list()) {
      const line = `- ${i.text}${i.tags && i.tags.length ? ` [${i.tags.join(', ')}]` : ''}`;
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join('\n');
  }

  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.items, null, 1), 'utf8'); } catch { /* best effort */ }
  }
}

module.exports = { Memory, MAX_ENTRIES, MAX_TEXT };
