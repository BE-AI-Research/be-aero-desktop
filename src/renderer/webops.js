// Operations the host performs inside <webview> guests on behalf of the AI
// assistant, plus the notification shim injected into every guest page.
// Guests have no preload (the host strips them for safety), so the only
// channels are executeJavaScript (host -> guest) and console messages
// (guest -> host). The in-page scripts themselves are shared with the
// OS-browser path (src/shared/pagescripts.js).
(function () {
  const NOTIFY_PREFIX = '__aero_notify__';
  const P = window.AeroPageScripts;

  // Replaces window.Notification inside a guest page: the page believes it
  // has permission, and every notification it raises is forwarded to the
  // host through a tagged console message the <webview> surfaces.
  const NOTIFICATION_SHIM = `(() => {
    if (window.__aeroNotifyShim) return;
    window.__aeroNotifyShim = true;
    const prefix = ${JSON.stringify(NOTIFY_PREFIX)};
    class AeroNotification {
      constructor(title, options) {
        this.title = String(title || '');
        this.body = options && options.body ? String(options.body) : '';
        this.icon = options && options.icon ? String(options.icon) : '';
        this.tag = options && options.tag ? String(options.tag) : '';
        this.onclick = null; this.onclose = null; this.onerror = null; this.onshow = null;
        try { console.info(prefix + JSON.stringify({ title: this.title, body: this.body, icon: this.icon, tag: this.tag })); } catch {}
        setTimeout(() => { if (typeof this.onshow === 'function') this.onshow(new Event('show')); }, 0);
      }
      close() { if (typeof this.onclose === 'function') this.onclose(new Event('close')); }
      addEventListener(type, fn) { this['on' + type] = fn; }
      removeEventListener() {}
      static requestPermission(cb) { if (typeof cb === 'function') cb('granted'); return Promise.resolve('granted'); }
    }
    Object.defineProperty(AeroNotification, 'permission', { get: () => 'granted' });
    Object.defineProperty(AeroNotification, 'maxActions', { get: () => 0 });
    try { Object.defineProperty(window, 'Notification', { value: AeroNotification, configurable: true, writable: true }); }
    catch { window.Notification = AeroNotification; }
  })();`;

  function parseNotifyMessage(message) {
    if (typeof message !== 'string' || !message.startsWith(NOTIFY_PREFIX)) return null;
    try {
      const n = JSON.parse(message.slice(NOTIFY_PREFIX.length));
      if (!n || typeof n !== 'object' || !n.title) return null;
      return { title: String(n.title), body: String(n.body || ''), icon: String(n.icon || ''), tag: String(n.tag || '') };
    } catch { return null; }
  }

  const waitFor = (view, event, ms) => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; view.removeEventListener(event, finish); resolve(); };
    view.addEventListener(event, finish);
    setTimeout(finish, ms);
  });

  // Wait until the guest reports a complete document, then let SPAs settle.
  async function settle(view, run, ms = 15000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { if ((await run(P.READY)) === 'complete') break; } catch { /* navigating */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function handle(entry, { op, args = {} }) {
    if (!entry || !entry.view) return { ok: false, error: 'no such web widget' };
    const view = entry.view;
    const run = (code) => view.executeJavaScript(code, true);
    const spec = { index: args.index, selector: args.selector, text: args.text };
    try {
      switch (op) {
        case 'read':
          return { ok: true, ...(await run(P.READ_PAGE)) };
        case 'navigate': {
          if (!/^https?:\/\//i.test(args.url || '')) return { ok: false, error: 'http(s) URLs only' };
          const loaded = waitFor(view, 'did-stop-loading', 15000);
          entry.url = args.url;
          view.loadURL(args.url);
          await loaded;
          await settle(view, run, 5000);
          return { ok: true, ...(await run(P.READ_PAGE).catch(() => ({ url: args.url }))) };
        }
        case 'elements':
          return { ok: true, ...(await run(P.ELEMENTS)) };
        case 'find':
          return { ok: true, ...(await run(P.findCode(args.query))) };
        case 'click': {
          const r = await run(P.clickCode(spec));
          if (r && r.ok) await settle(view, run, 4000);
          return r;
        }
        case 'type': {
          const r = await run(P.typeCode(spec, args.text, !!args.submit, args.clear !== false));
          if (r && r.ok && args.submit) await settle(view, run, 6000);
          return r;
        }
        case 'select':
          return await run(P.selectCode(spec, args.value));
        case 'hover':
          return await run(P.hoverCode(spec));
        case 'scroll':
          return await run(P.scrollCode(args.dy));
        case 'submit': {
          const r = await run(`(() => { const el = document.querySelector(${JSON.stringify(args.selector || 'form')}); const f = el && (el.tagName === 'FORM' ? el : el.form || el.closest('form')); if (!f) return { ok: false, error: 'no form' }; if (f.requestSubmit) f.requestSubmit(); else f.submit(); return { ok: true }; })()`);
          if (r && r.ok) await settle(view, run, 8000);
          return r;
        }
        case 'back':
          if (!view.canGoBack()) return { ok: false, error: 'nothing to go back to' };
          view.goBack(); await waitFor(view, 'did-stop-loading', 10000); await settle(view, run, 3000);
          return { ok: true, url: view.getURL() };
        case 'forward':
          if (!view.canGoForward()) return { ok: false, error: 'nothing to go forward to' };
          view.goForward(); await waitFor(view, 'did-stop-loading', 10000); await settle(view, run, 3000);
          return { ok: true, url: view.getURL() };
        case 'reload':
          view.reload(); await waitFor(view, 'did-stop-loading', 15000); await settle(view, run, 3000);
          return { ok: true, url: view.getURL() };
        case 'wait': {
          const until = Date.now() + Math.min(30000, Math.max(100, Number(args.ms) || 10000));
          if (args.selector) {
            while (Date.now() < until) {
              if (await run(P.waitCode(args.selector))) return { ok: true, found: true };
              await new Promise((r) => setTimeout(r, 250));
            }
            return { ok: false, error: 'timed out waiting for ' + args.selector };
          }
          await new Promise((r) => setTimeout(r, until - Date.now()));
          return { ok: true };
        }
        case 'eval': {
          const value = await run(String(args.code || ''));
          return { ok: true, result: value === undefined ? null : value };
        }
        case 'screenshot': {
          // The sandboxed renderer cannot encode images (no Buffer); hand the
          // guest's webContents id to main, which captures and encodes it.
          const page = await run('({ title: document.title, url: location.href })').catch(() => ({}));
          return { ok: true, ...page, webContentsId: view.getWebContentsId(), note: 'Screenshot attached. Use web_elements for clickable targets.' };
        }
        default:
          return { ok: false, error: `unknown op ${op}` };
      }
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  window.AeroWebOps = { handle, NOTIFICATION_SHIM, parseNotifyMessage, NOTIFY_PREFIX };
})();
