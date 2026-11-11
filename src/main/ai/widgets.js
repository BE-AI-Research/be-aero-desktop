// AI widgets: desktop widgets the assistant writes on request.
//
// Each lives in its own folder, AI Folder/AI Widgets/<name>/:
//   index.html   - the widget (served on aero-widget://<id>/ to a sandboxed
//                  <iframe sandbox="allow-scripts">: opaque origin, no access
//                  to the app, its storage or the local API)
//   widget.json  - { id, title, hosts, width, height, createdAt }
//   state.json   - what the widget saved (aeroWidget.save)
// The folder is the source of truth: edit index.html and the widget reloads.
//
// Network: blocked, except the hosts the widget declares AND the user
// approved. Approvals are kept in the app's own data, never in the AI
// folder - the assistant can write there, and must not approve itself.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { buildPage } = require('./visuals');

const MAX_HTML = 512 * 1024;
const MAX_STATE = 256 * 1024;
const MAX_FETCH = 2 * 1024 * 1024;
const MAX_WIDGETS = 50;
const ID_RE = /^aw[a-f0-9]{10}$/;
const CDNS = 'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com';

// "api.example.com", "https://api.example.com/x", "192.168.1.38:8123",
// "http://homeassistant.local:8123", "*.example.com" -> an origin, or null.
function normHost(h) {
  let s = String(h || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const wild = /^https?:\/\/\*\./i.test(s);
  let u;
  try { u = new URL(wild ? s.replace('*.', 'wildcard.') : s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
  const host = wild ? u.host.replace(/^wildcard\./, '*.') : u.host;
  if (!/^[a-z0-9*.:[\]-]+$/i.test(host)) return null;
  return `${u.protocol}//${host}`;
}

// Is url inside one of the approved origins?
function hostAllowed(url, approved) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  return (approved || []).some((o) => {
    const m = /^(https?:)\/\/(\*\.)?(.+)$/.exec(o);
    if (!m || m[1] !== u.protocol) return false;
    if (!m[2]) return u.host.toLowerCase() === m[3].toLowerCase();
    return u.host.toLowerCase().endsWith(`.${m[3].toLowerCase()}`);
  });
}

function cspFor(approved) {
  const extra = (approved || []).join(' ');
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${CDNS}`,
    `style-src 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
    'font-src data: https://fonts.gstatic.com',
    `img-src data: blob: https: ${extra}`.trim(),
    'media-src data: blob:',
    `connect-src ${extra || "'none'"}`,
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; ');
}

// window.aeroWidget inside the frame: load/save its state, and fetch from
// an approved host through the app (many APIs refuse a sandboxed frame's
// "null" origin; the app's fetch is checked against the same approvals).
const BRIDGE = `<script>(function(){var n=0,wait={};
addEventListener('message',function(e){var d=e.data;if(!d||d.__aeroWidgetReply!==1||!wait[d.rid])return;var w=wait[d.rid];delete wait[d.rid];if(d.error)w[1](new Error(d.error));else w[0](d.result);});
function call(op,args){return new Promise(function(res,rej){var rid=++n;wait[rid]=[res,rej];parent.postMessage({__aeroWidget:1,rid:rid,op:op,args:args},'*');});}
window.aeroWidget={load:function(){return call('load');},save:function(v){return call('save',v);},
fetch:function(url,opts){return call('fetch',{url:String(url),method:(opts&&opts.method)||'GET',headers:(opts&&opts.headers)||{},body:opts&&opts.body!=null?String(opts.body):null});}};})();</script>`;

const safeName = (t) => String(t || 'Widget').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Widget';

class AiWidgets {
  // { folder: async () => AI folder path, approvalsFile, approve: async (widget, newHosts) -> bool, onChange(list), log }
  constructor({ folder, approvalsFile, approve, onChange = () => {}, log = () => {} }) {
    this.folder = folder;
    this.approvalsFile = approvalsFile;
    this.approve = approve;
    this.onChange = onChange;
    this.log = log;
    this.widgets = new Map();          // id -> { id, title, hosts, width, height, createdAt, dir }
    try { this.approvals = JSON.parse(fs.readFileSync(approvalsFile, 'utf8')) || {}; } catch { this.approvals = {}; }
    this.watcher = null;
    this.reloadTimer = null;
  }

  async root() {
    const dir = path.join(await this.folder(), 'AI Widgets');
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  saveApprovals() {
    try {
      fs.mkdirSync(path.dirname(this.approvalsFile), { recursive: true });
      fs.writeFileSync(this.approvalsFile, JSON.stringify(this.approvals));
    } catch (err) { this.log(`widget approvals not saved: ${err.message}`); }
  }

  approved(id) { return (this.approvals[id] || []).slice(); }

  // Read every widget folder.
  async load() {
    const root = await this.root();
    const found = new Map();
    let dirents = [];
    try { dirents = await fsp.readdir(root, { withFileTypes: true }); } catch { /* none */ }
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(dir, 'widget.json'), 'utf8'));
        if (!meta || !ID_RE.test(String(meta.id)) || found.has(meta.id)) continue;
        await fsp.access(path.join(dir, 'index.html'));
        const st = await fsp.stat(path.join(dir, 'index.html'));
        found.set(meta.id, {
          id: meta.id, title: String(meta.title || d.name).slice(0, 80), dir,
          hosts: (Array.isArray(meta.hosts) ? meta.hosts : []).map(normHost).filter(Boolean).slice(0, 20),
          width: Number(meta.width) || 320, height: Number(meta.height) || 240,
          createdAt: Number(meta.createdAt) || st.birthtimeMs, updatedAt: st.mtimeMs
        });
      } catch { /* not a widget folder */ }
    }
    this.widgets = found;
    // Approvals of widgets that are gone go too.
    let pruned = false;
    for (const id of Object.keys(this.approvals)) if (!found.has(id)) { delete this.approvals[id]; pruned = true; }
    if (pruned) this.saveApprovals();
    return this.list();
  }

  list() {
    return [...this.widgets.values()].map((w) => ({ ...w, approvedHosts: this.approved(w.id), pendingHosts: w.hosts.filter((h) => !this.approved(w.id).includes(h)) }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id) { return this.widgets.get(id) || null; }

  async writeMeta(w) {
    const meta = { id: w.id, title: w.title, hosts: w.hosts, width: w.width, height: w.height, createdAt: w.createdAt };
    await fsp.writeFile(path.join(w.dir, 'widget.json'), JSON.stringify(meta, null, 2), 'utf8');
  }

  // Ask the user about hosts this widget declares that are not approved yet.
  async askHosts(w) {
    const have = this.approved(w.id);
    const fresh = w.hosts.filter((h) => !have.includes(h));
    if (!fresh.length) return { approved: have, asked: false };
    const ok = this.approve ? await this.approve(w, fresh) : false;
    if (ok) { this.approvals[w.id] = [...new Set([...have, ...fresh])]; this.saveApprovals(); }
    return { approved: this.approved(w.id), asked: true, allowed: !!ok };
  }

  async create({ title, html, hosts = [], width, height }) {
    const body = String(html || '');
    if (!body.trim()) throw new Error('html is empty');
    if (Buffer.byteLength(body) > MAX_HTML) throw new Error(`html is too large (max ${MAX_HTML / 1024} KB)`);
    if (this.widgets.size >= MAX_WIDGETS) throw new Error(`too many widgets (max ${MAX_WIDGETS}) - remove one first`);
    const root = await this.root();
    const { freeName } = require('../files');
    const dir = path.join(root, await freeName(root, safeName(title)));
    await fsp.mkdir(dir, { recursive: true });
    const w = {
      id: 'aw' + crypto.randomBytes(5).toString('hex'), title: String(title || 'Widget').slice(0, 80), dir,
      hosts: [...new Set((hosts || []).map(normHost).filter(Boolean))].slice(0, 20),
      width: Math.max(160, Math.min(1600, Number(width) || 320)), height: Math.max(80, Math.min(1200, Number(height) || 240)),
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await fsp.writeFile(path.join(dir, 'index.html'), body, 'utf8');
    await this.writeMeta(w);
    this.widgets.set(w.id, w);
    const net = await this.askHosts(w);
    this.onChange(this.list());
    return { id: w.id, title: w.title, folder: dir, hosts: w.hosts, approvedHosts: net.approved };
  }

  async update(id, { title, html, hosts, width, height }) {
    const w = this.get(id);
    if (!w) throw new Error(`no widget ${id}`);
    if (html != null) {
      const body = String(html);
      if (!body.trim()) throw new Error('html is empty');
      if (Buffer.byteLength(body) > MAX_HTML) throw new Error(`html is too large (max ${MAX_HTML / 1024} KB)`);
      await fsp.writeFile(path.join(w.dir, 'index.html'), body, 'utf8');
    }
    if (title) w.title = String(title).slice(0, 80);
    if (Array.isArray(hosts)) w.hosts = [...new Set(hosts.map(normHost).filter(Boolean))].slice(0, 20);
    if (width) w.width = Math.max(160, Math.min(1600, Number(width)));
    if (height) w.height = Math.max(80, Math.min(1200, Number(height)));
    w.updatedAt = Date.now();
    await this.writeMeta(w);
    // Hosts no longer declared lose their approval.
    if (this.approvals[id]) { this.approvals[id] = this.approvals[id].filter((h) => w.hosts.includes(h)); this.saveApprovals(); }
    const net = await this.askHosts(w);
    this.onChange(this.list());
    return { id, title: w.title, hosts: w.hosts, approvedHosts: net.approved };
  }

  async remove(id, trash) {
    const w = this.get(id);
    if (!w) return false;
    this.widgets.delete(id);
    delete this.approvals[id];
    this.saveApprovals();
    try { if (trash) await trash(w.dir); else await fsp.rm(w.dir, { recursive: true, force: true }); } catch (err) { this.log(`widget folder not removed: ${err.message}`); }
    this.onChange(this.list());
    return true;
  }

  revoke(id) { delete this.approvals[id]; this.saveApprovals(); this.onChange(this.list()); }

  // ---- serving
  page(id) {
    const w = ID_RE.test(String(id)) && this.get(id);
    if (!w) return null;
    let html;
    try { html = fs.readFileSync(path.join(w.dir, 'index.html'), 'utf8'); } catch { return null; }
    const page = buildPage(html);
    return /<head[^>]*>/i.test(page) ? page.replace(/<head[^>]*>/i, (m) => `${m}${BRIDGE}`) : `${BRIDGE}${page}`;
  }

  csp(id) { return cspFor(this.approved(id)); }

  // ---- the frame's bridge
  async getState(id) {
    const w = this.get(id);
    if (!w) throw new Error('no such widget');
    try { return JSON.parse(await fsp.readFile(path.join(w.dir, 'state.json'), 'utf8')); } catch { return null; }
  }

  async setState(id, value) {
    const w = this.get(id);
    if (!w) throw new Error('no such widget');
    const text = JSON.stringify(value === undefined ? null : value);
    if (Buffer.byteLength(text) > MAX_STATE) throw new Error(`state is too large (max ${MAX_STATE / 1024} KB)`);
    await fsp.writeFile(path.join(w.dir, 'state.json'), text, 'utf8');
    return true;
  }

  async fetch(id, { url, method = 'GET', headers = {}, body = null } = {}) {
    if (!this.get(id)) throw new Error('no such widget');
    if (!hostAllowed(url, this.approved(id))) throw new Error(`not an approved site for this widget: ${url}`);
    const m = String(method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) throw new Error('unsupported method');
    const h = {};
    for (const [k, v] of Object.entries(headers || {}).slice(0, 20)) if (/^[a-z0-9-]+$/i.test(k) && !/^(host|cookie|origin|referer)$/i.test(k)) h[k] = String(v).slice(0, 4000);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const res = await fetch(url, { method: m, headers: h, body: m === 'GET' ? undefined : body, redirect: 'manual', signal: ac.signal });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_FETCH) throw new Error('response too large');
      return { status: res.status, ok: res.ok, headers: { 'content-type': res.headers.get('content-type') || '' }, text: buf.toString('utf8') };
    } finally { clearTimeout(timer); }
  }

  // ---- edits made by hand in the folder reload the widget
  async watch() {
    if (this.watcher) return;
    const root = await this.root();
    try {
      this.watcher = fs.watch(root, { recursive: true }, (_ev, file) => {
        if (file && /state\.json$/i.test(String(file))) return;        // its own saves
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.load().then((l) => this.onChange(l)).catch(() => {}), 400);
      });
      this.watcher.on('error', () => { this.watcher = null; });
    } catch { this.watcher = null; }
  }

  stop() { if (this.watcher) { this.watcher.close(); this.watcher = null; } clearTimeout(this.reloadTimer); }
}

module.exports = { AiWidgets, normHost, hostAllowed, cspFor, ID_RE: ID_RE };
