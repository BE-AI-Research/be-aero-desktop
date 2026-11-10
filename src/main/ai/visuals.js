// Visuals: small HTML pages the assistant writes to *show* information -
// charts, tables, dashboards, comparisons, diagrams. Each is stored under
// <userData>/ai/visuals and served on the aero-visual: scheme to a sandboxed
// <iframe sandbox="allow-scripts"> (opaque origin: no access to the app,
// its storage or the local API). The CSP sent with every page blocks all
// network requests except loading scripts/styles/fonts from a few public
// CDNs, so a visual can draw with Chart.js or D3 but cannot send data out.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_HTML = 512 * 1024;
const MAX_VISUALS = 200;
const ID_RE = /^v[a-f0-9]{10}$/;
const CDNS = 'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com';

const VISUAL_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CDNS}`,
  `style-src 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
  "font-src data: https://fonts.gstatic.com",
  "img-src data: blob: https:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ');

// Base look so a bare fragment already matches the sidebar's glass theme,
// plus a reporter that tells the host page how tall the content is (chat
// cards size themselves to it).
const PRELUDE = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;--fg:#e8edf5;--muted:rgba(232,237,245,.6);--line:rgba(255,255,255,.14);--accent:#6aa9ff}
html,body{margin:0;background:transparent;color:var(--fg);font:13px/1.45 "Segoe UI",system-ui,-apple-system,Ubuntu,sans-serif}
body{padding:10px 12px}
table{border-collapse:collapse;width:100%}th,td{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--muted);font-weight:600}
img,svg,canvas,video{max-width:100%}
html{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.22);border-radius:4px}
a{color:var(--accent)}h1,h2,h3{margin:.2em 0 .5em;font-weight:600}h1{font-size:18px}h2{font-size:15px}h3{font-size:13px}
</style>`;
const REPORTER = `<script>(function(){var last=0;function send(){var h=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0));if(h!==last){last=h;parent.postMessage({__aeroVisual:1,height:h},'*');}}
addEventListener('load',send);if(window.ResizeObserver)new ResizeObserver(send).observe(document.documentElement);setTimeout(send,50);setTimeout(send,600);})();</script>`;

// Whatever the model wrote -> one complete page with the prelude and reporter.
function buildPage(html) {
  let s = String(html || '');
  if (!/<html[\s>]/i.test(s)) {
    s = `<!doctype html><html><head>${PRELUDE}</head><body>${s}${REPORTER}</body></html>`;
  } else {
    s = /<head[^>]*>/i.test(s) ? s.replace(/<head[^>]*>/i, (m) => `${m}${PRELUDE}`) : s.replace(/<html[^>]*>/i, (m) => `${m}<head>${PRELUDE}</head>`);
    s = /<\/body>/i.test(s) ? s.replace(/<\/body>/i, `${REPORTER}</body>`) : `${s}${REPORTER}`;
  }
  return s;
}

class Visuals {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.indexFile = path.join(dir, 'index.json');
    try { this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { this.index = []; }
    if (!Array.isArray(this.index)) this.index = [];
  }

  file(id) {
    if (!ID_RE.test(String(id))) throw new Error('bad visual id');
    return path.join(this.dir, `${id}.html`);
  }

  saveIndex() {
    const tmp = this.indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.index));
    fs.renameSync(tmp, this.indexFile);
  }

  // Create (no id) or replace (existing id). Returns the record.
  save({ id, title, html, where = 'chat', conversationId = null }) {
    const body = String(html || '');
    if (!body.trim()) throw new Error('html is empty');
    if (Buffer.byteLength(body) > MAX_HTML) throw new Error(`html is too large (max ${MAX_HTML / 1024} KB) - embed less data`);
    let rec = id ? this.index.find((v) => v.id === id) : null;
    if (id && !rec) throw new Error(`no visual ${id}`);
    const now = Date.now();
    if (!rec) {
      rec = { id: 'v' + crypto.randomBytes(5).toString('hex'), createdAt: now };
      this.index.push(rec);
    }
    rec.title = String(title || rec.title || 'Visual').slice(0, 80);
    rec.where = where === 'desktop' ? 'desktop' : 'chat';
    rec.updatedAt = now;
    if (conversationId) rec.conversationId = conversationId;
    fs.writeFileSync(this.file(rec.id), body, 'utf8');
    // Oldest chat visuals go first when the store is full.
    while (this.index.length > MAX_VISUALS) {
      const old = this.index.filter((v) => v.where !== 'desktop').sort((a, b) => a.updatedAt - b.updatedAt)[0] || this.index[0];
      this.remove(old.id, false);
    }
    this.saveIndex();
    return { ...rec };
  }

  get(id) { return this.index.find((v) => v.id === id) || null; }
  list() { return this.index.map((v) => ({ ...v })).sort((a, b) => b.updatedAt - a.updatedAt); }

  remove(id, persist = true) {
    const i = this.index.findIndex((v) => v.id === id);
    if (i < 0) return false;
    this.index.splice(i, 1);
    try { fs.unlinkSync(this.file(id)); } catch { /* gone */ }
    if (persist) this.saveIndex();
    return true;
  }

  // The served page (null when unknown).
  page(id) {
    if (!ID_RE.test(String(id)) || !this.get(id)) return null;
    try { return buildPage(fs.readFileSync(this.file(id), 'utf8')); } catch { return null; }
  }
}

module.exports = { Visuals, buildPage, VISUAL_CSP, ID_RE, MAX_HTML };
