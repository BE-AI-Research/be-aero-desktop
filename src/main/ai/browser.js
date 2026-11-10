// OS browser control through the Chrome DevTools Protocol.
//
// The assistant cannot drive the user's running browser (Chromium forbids
// attaching to a profile that was not started with debugging on), so it
// launches the user's Chromium-based browser - Chrome, Edge, Brave, ... -
// with a dedicated "BE-Aero" profile and remote debugging enabled, then
// talks CDP: tabs, navigation, page text, numbered elements, clicks,
// typing, scrolling and screenshots the model can look at. The profile
// persists, so the user signs in to sites once. Firefox has no CDP; it
// stays on the keystroke path.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const scripts = require('../../shared/pagescripts');

const PORT = 9341;
const LAUNCH_WAIT_MS = 20000;
const NAV_WAIT_MS = 15000;

const WIN_CANDIDATES = {
  chrome: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')],
  msedge: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  brave: ['C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')],
  chromium: [path.join(process.env.LOCALAPPDATA || '', 'Chromium\\Application\\chrome.exe')]
};
const PROGID_TO_KEY = { ChromeHTML: 'chrome', MSEdgeHTM: 'msedge', BraveHTML: 'brave', ChromiumHTM: 'chromium' };
const LINUX_BINS = ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'brave-browser', 'chromium', 'chromium-browser'];
// Browsers the user can pick (Settings > AI assistant > Browser). Firefox can
// open pages but has no DevTools protocol, so the assistant profile (click /
// type) always runs on a Chromium browser.
const NAMES = { chrome: 'Google Chrome', msedge: 'Microsoft Edge', brave: 'Brave', chromium: 'Chromium', firefox: 'Firefox' };
const WIN_FIREFOX = ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'];
const LINUX_KEYS = { 'google-chrome': 'chrome', 'google-chrome-stable': 'chrome', 'microsoft-edge': 'msedge', 'brave-browser': 'brave', chromium: 'chromium', 'chromium-browser': 'chromium', firefox: 'firefox' };

// -> [{ key, name, path, cdp }] for the browsers installed here, one per key.
function listBrowsers() {
  const out = [];
  const add = (key, p) => { if (p && !out.some((b) => b.key === key)) out.push({ key, name: NAMES[key] || key, path: p, cdp: key !== 'firefox' }); };
  if (process.platform === 'win32') {
    for (const [key, list] of Object.entries(WIN_CANDIDATES)) for (const p of list) if (p && fs.existsSync(p)) { add(key, p); break; }
    for (const p of WIN_FIREFOX) if (fs.existsSync(p)) { add('firefox', p); break; }
    return out;
  }
  for (const bin of [...LINUX_BINS, 'firefox']) {
    try { const p = execSync(`command -v ${bin}`, { encoding: 'utf8' }).trim(); if (p) add(LINUX_KEYS[bin], p); } catch { /* not installed */ }
  }
  return out;
}

function defaultBrowserKeyWin() {
  try {
    const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId', { windowsHide: true, encoding: 'utf8' });
    const m = /ProgId\s+REG_SZ\s+(\S+)/.exec(out);
    if (m) for (const [prefix, key] of Object.entries(PROGID_TO_KEY)) if (m[1].startsWith(prefix)) return key;
  } catch { /* no association */ }
  return null;
}

// The Chromium browser for the assistant profile: the user's choice when it
// is installed and Chromium-based, else the default browser, else the first
// one found.
function detectBrowser(preferred) {
  if (preferred && preferred !== 'firefox') {
    const b = listBrowsers().find((x) => x.key === preferred && x.cdp);
    if (b) return { path: b.path, name: b.key, isDefault: false };
  }
  if (process.platform === 'win32') {
    const preferred = defaultBrowserKeyWin();
    const order = [preferred, 'chrome', 'msedge', 'brave', 'chromium'].filter(Boolean);
    for (const key of order) for (const p of WIN_CANDIDATES[key] || []) if (p && fs.existsSync(p)) return { path: p, name: key, isDefault: key === preferred };
    return null;
  }
  for (const bin of LINUX_BINS) {
    try { const p = execSync(`command -v ${bin}`, { encoding: 'utf8' }).trim(); if (p) return { path: p, name: bin, isDefault: bin === LINUX_BINS[0] }; } catch { /* next */ }
  }
  return null;
}

async function fetchJson(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

class BrowserController {
  constructor({ profileDir, resizeImage, preferred }) {
    this.profileDir = profileDir;
    this.preferred = preferred || (() => '');   // () -> browser key chosen in Settings
    this.resizeImage = resizeImage;     // (pngBuffer) -> { mime, data(base64) }
    this.proc = null;
    this.exe = null;
  }

  info() {
    const b = detectBrowser(this.preferred());
    return b ? { available: true, browser: b.name, path: b.path, isDefault: b.isDefault, profile: this.profileDir } : { available: false };
  }

  async isUp() {
    try { await fetchJson(`http://127.0.0.1:${PORT}/json/version`); return true; } catch { return false; }
  }

  async ensureRunning() {
    if (await this.isUp()) return true;
    const b = detectBrowser(this.preferred());
    if (!b) throw new Error('No Chromium-based browser (Chrome, Edge, Brave) was found on this machine.');
    this.exe = b;
    fs.mkdirSync(this.profileDir, { recursive: true });
    const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${this.profileDir}`, '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate', '--new-window', 'about:blank'];
    this.proc = spawn(b.path, args, { detached: true, stdio: 'ignore' });
    this.proc.unref();
    const until = Date.now() + LAUNCH_WAIT_MS;
    while (Date.now() < until) {
      if (await this.isUp()) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`${b.name} started but did not open its debugging port.`);
  }

  async tabs() {
    await this.ensureRunning();
    const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
    return list.filter((t) => t.type === 'page' && !/^(devtools|chrome-extension):/.test(t.url || ''))
      .map((t) => ({ id: t.id, title: t.title, url: t.url, ws: t.webSocketDebuggerUrl }));
  }

  // Tab by id (or id prefix), by title/url fragment, or the only tab.
  async resolveTab(hint) {
    const tabs = await this.tabs();
    if (!tabs.length) return { error: 'the browser has no open tabs - use browser_open first' };
    const h = String(hint || '').trim();
    if (!h) return tabs.length === 1 ? tabs[0] : { error: 'several tabs are open - pass the tab id', tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })) };
    const t = tabs.find((x) => x.id === h) || tabs.find((x) => x.id.startsWith(h))
      || tabs.find((x) => (x.url || '').toLowerCase().includes(h.toLowerCase()) || (x.title || '').toLowerCase().includes(h.toLowerCase()));
    return t || { error: `no tab matches "${h}"`, tabs: tabs.map((x) => ({ id: x.id, title: x.title, url: x.url })) };
  }

  async open(url) {
    await this.ensureRunning();
    const target = await fetchJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    const tab = { id: target.id, title: target.title, url: target.url, ws: target.webSocketDebuggerUrl };
    await this.waitForLoad(tab);
    try { await fetchJson(`http://127.0.0.1:${PORT}/json/activate/${tab.id}`); } catch { /* fine */ }
    return tab;
  }

  async activate(tab) { await fetchJson(`http://127.0.0.1:${PORT}/json/activate/${tab.id}`); return { ok: true }; }
  async close(tab) { await fetchJson(`http://127.0.0.1:${PORT}/json/close/${tab.id}`); return { ok: true }; }

  // One CDP session per operation: cheap, and never leaks a socket.
  async cdp(tab, calls) {
    const ws = new WebSocket(tab.ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not connect to the tab')); });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params) => new Promise((res, rej) => {
      const myId = ++id;
      const timer = setTimeout(() => { pending.delete(myId); rej(new Error(`${method} timed out`)); }, 20000);
      pending.set(myId, (d) => { clearTimeout(timer); d.error ? rej(new Error(d.error.message)) : res(d.result); });
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });
    try { return await calls(send); } finally { try { ws.close(); } catch { /* closed */ } }
  }

  async evaluate(tab, expression) {
    return this.cdp(tab, async (send) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'page script failed');
      return r.result ? r.result.value : undefined;
    });
  }

  async waitForLoad(tab, ms = NAV_WAIT_MS) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { if ((await this.evaluate(tab, scripts.READY)) === 'complete') break; } catch { /* navigating */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 500));   // let SPAs settle
  }

  async navigate(tab, url) {
    await this.cdp(tab, (send) => send('Page.navigate', { url }));
    await this.waitForLoad(tab);
    return this.read(tab);
  }

  async read(tab) { return { ok: true, tabId: tab.id, ...(await this.evaluate(tab, scripts.READ_PAGE)) }; }
  async elements(tab) { return { ok: true, tabId: tab.id, ...(await this.evaluate(tab, scripts.ELEMENTS)) }; }
  async find(tab, query) { return { ok: true, ...(await this.evaluate(tab, scripts.findCode(query))) }; }
  async click(tab, spec) {
    const r = await this.evaluate(tab, scripts.clickCode(spec));
    if (r && r.ok) await this.waitForLoad(tab, 4000);
    return r;
  }
  async type(tab, spec, text, submit, clear) {
    const r = await this.evaluate(tab, scripts.typeCode(spec, text, submit, clear));
    if (r && r.ok && submit) await this.waitForLoad(tab, 6000);
    return r;
  }
  async select(tab, spec, value) { return this.evaluate(tab, scripts.selectCode(spec, value)); }
  async hover(tab, spec) { return this.evaluate(tab, scripts.hoverCode(spec)); }
  async scroll(tab, dy) { return this.evaluate(tab, scripts.scrollCode(dy)); }
  async wait(tab, selector, ms) {
    const until = Date.now() + Math.min(30000, Math.max(100, Number(ms) || 10000));
    if (!selector) { await new Promise((r) => setTimeout(r, until - Date.now())); return { ok: true }; }
    while (Date.now() < until) {
      if (await this.evaluate(tab, scripts.waitCode(selector))) return { ok: true, found: true };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, error: `timed out waiting for ${selector}` };
  }
  async history(tab, delta) {
    return this.cdp(tab, async (send) => {
      const h = await send('Page.getNavigationHistory');
      const entry = h.entries[h.currentIndex + delta];
      if (!entry) return { ok: false, error: delta < 0 ? 'nothing to go back to' : 'nothing to go forward to' };
      await send('Page.navigateToHistoryEntry', { entryId: entry.id });
      return { ok: true, url: entry.url };
    }).then(async (r) => { if (r.ok) await this.waitForLoad(tab); return r; });
  }
  async eval(tab, code) { const value = await this.evaluate(tab, String(code || '')); return { ok: true, result: value === undefined ? null : value }; }

  async screenshot(tab) {
    try { await fetchJson(`http://127.0.0.1:${PORT}/json/activate/${tab.id}`); } catch { /* fine */ }
    const png = await this.cdp(tab, async (send) => {
      await send('Page.bringToFront');
      const r = await send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(r.data, 'base64');
    });
    const img = this.resizeImage ? this.resizeImage(png) : { mime: 'image/png', data: png.toString('base64') };
    const page = await this.evaluate(tab, '({ title: document.title, url: location.href })');
    return { ok: true, tabId: tab.id, ...page, images: [img], note: 'Screenshot attached. Use browser_elements for clickable targets.' };
  }
}

module.exports = { listBrowsers, BrowserController, detectBrowser, PORT };
