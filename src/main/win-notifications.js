// Windows: mirror other apps' toast notifications into the notification
// center, read-only and best-effort.
//
// Windows keeps every toast it shows in the user's own notification store,
// %LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db (SQLite).
// We open it read-only and pick up rows newer than the last one seen. Nothing
// is changed, intercepted or dismissed - Windows still shows its own pop-ups.
// The supported API for this (UserNotificationListener) needs a packaged app
// with a declared capability, which a desktop app like this is not.
const fs = require('fs');
const path = require('path');

const POLL_MS = 4000;
const FILETIME_EPOCH_MS = 11644473600000n;

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return XML_ENT[e.toLowerCase()] || m;
});

// A toast's XML -> { title, body } (the first <text> is the title).
function parseToast(xml) {
  const texts = [];
  const re = /<text\b[^>]*>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) && texts.length < 6) {
    const t = unxml(m[1].replace(/<[^>]+>/g, '')).trim();
    if (t) texts.push(t);
  }
  if (!texts.length) return null;
  return { title: texts[0].slice(0, 200), body: texts.slice(1).join('\n').slice(0, 600) };
}

// "Microsoft.WindowsStore_8wekyb3d8bbwe!App" -> "Windows Store";
// "com.squirrel.Discord.Discord" -> "Discord"; "C:\...\app.exe" -> "app".
function guessAppName(id) {
  let s = String(id || '');
  if (!s) return 'An app';
  if (/[\\/]/.test(s)) return path.basename(s).replace(/\.exe$/i, '');
  if (s.includes('!')) s = s.slice(0, s.indexOf('!'));
  s = s.replace(/_[a-z0-9]{13}$/i, '');                   // package publisher hash
  const parts = s.split('.').filter(Boolean);
  let last = parts[parts.length - 1] || s;
  if (/^(app|desktop|exe|client)$/i.test(last) && parts.length > 1) last = parts[parts.length - 2];
  return last.replace(/([a-z])([A-Z])/g, '$1 $2');
}

const filetimeToMs = (ft) => { try { return Number(BigInt(String(ft)) / 10000n - FILETIME_EPOCH_MS); } catch { return Date.now(); } };

class WinNotificationWatcher {
  // { onNotification({ app, title, body, ts }), ownIds: [AUMID], nameFor(id) -> name|null, log }
  constructor({ onNotification, ownIds = [], nameFor = () => null, log = () => {} }) {
    this.onNotification = onNotification;
    this.own = new Set(ownIds.map((x) => String(x).toLowerCase()));
    this.nameFor = nameFor;
    this.log = log;
    this.file = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
    this.lastId = null;
    this.timer = null;
    this.error = null;
  }

  open() {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(this.file, { readOnly: true });
  }

  poll() {
    let db = null;
    try {
      db = this.open();
      if (this.lastId === null) {
        // Start from now: what is already there is history, not news.
        this.lastId = Number(db.prepare('select coalesce(max(Id), 0) id from Notification').get().id) || 0;
        this.error = null;
        return;
      }
      const rows = db.prepare(`select n.Id id, cast(n.ArrivalTime as text) at, n.Payload payload, h.PrimaryId app
        from Notification n join NotificationHandler h on h.RecordId = n.HandlerId
        where n.Id > ? and n.Type = 'toast' order by n.Id limit 50`).all(this.lastId);
      this.error = null;
      for (const r of rows) {
        this.lastId = Math.max(this.lastId, Number(r.id) || 0);
        if (this.own.has(String(r.app || '').toLowerCase())) continue;     // our own toasts are already in the center
        const xml = r.payload instanceof Uint8Array ? Buffer.from(r.payload).toString('utf8') : String(r.payload || '');
        const t = parseToast(xml);
        if (!t) continue;
        const app = this.nameFor(r.app) || guessAppName(r.app);
        try { this.onNotification({ app, title: t.title, body: t.body, ts: filetimeToMs(r.at) }); } catch { /* the center's problem */ }
      }
    } catch (err) {
      if (this.error !== err.message) this.log(`cannot read the Windows notification list: ${err.message}`);
      this.error = err.message;
    } finally {
      try { if (db) db.close(); } catch { /* closed */ }
    }
  }

  start() {
    if (this.timer || process.platform !== 'win32') return;
    if (!fs.existsSync(this.file)) { this.error = 'no notification list on this PC'; return; }
    this.lastId = null;
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  status() { return { running: !!this.timer && !this.error, tool: 'the Windows notification list', error: this.error }; }
}

module.exports = { WinNotificationWatcher, parseToast, guessAppName, filetimeToMs };
