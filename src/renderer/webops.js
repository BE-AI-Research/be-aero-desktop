// Operations the host performs inside <webview> guests on behalf of the AI
// assistant, plus the notification shim injected into every guest page.
// Guests have no preload (the host strips them for safety), so the only
// channels are executeJavaScript (host -> guest) and console messages
// (guest -> host) - which is exactly what these two pieces use.
(function () {
  const NOTIFY_PREFIX = '__aero_notify__';

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

  const READ_PAGE = `({
    title: document.title,
    url: location.href,
    text: (document.body ? document.body.innerText : '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').slice(0, 20000)
  })`;

  function clickCode(selector, text) {
    return `(() => {
      const sel = ${JSON.stringify(selector || '')};
      const txt = ${JSON.stringify((text || '').trim().toLowerCase())};
      let el = null;
      if (sel) el = document.querySelector(sel);
      if (!el && txt) {
        const all = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"], summary, label, li, span, div')];
        el = all.find((e) => (e.innerText || e.value || '').trim().toLowerCase() === txt)
          || all.find((e) => (e.innerText || e.value || '').trim().toLowerCase().includes(txt) && e.children.length < 4);
      }
      if (!el) return { ok: false, error: 'no matching element' };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 120) };
    })()`;
  }

  function typeCode(selector, text, submit) {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector || '')});
      if (!el) return { ok: false, error: 'no matching input' };
      el.focus();
      const v = ${JSON.stringify(String(text || ''))};
      if (el.isContentEditable) { el.textContent = v; }
      else {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, v); else el.value = v;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (${submit ? 'true' : 'false'}) {
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
        if (el.form && typeof el.form.requestSubmit === 'function') { try { el.form.requestSubmit(); } catch {} }
      }
      return { ok: true };
    })()`;
  }

  async function handle(entry, { op, args = {} }) {
    if (!entry || !entry.view) return { ok: false, error: 'no such web widget' };
    const view = entry.view;
    const run = (code) => view.executeJavaScript(code, true);
    try {
      switch (op) {
        case 'read':
          return { ok: true, ...(await run(READ_PAGE)) };
        case 'navigate': {
          if (!/^https?:\/\//i.test(args.url || '')) return { ok: false, error: 'http(s) URLs only' };
          const loaded = waitFor(view, 'did-stop-loading', 15000);
          entry.url = args.url;
          view.loadURL(args.url);
          await loaded;
          return { ok: true, ...(await run(READ_PAGE).catch(() => ({ url: args.url }))) };
        }
        case 'click': {
          const r = await run(clickCode(args.selector, args.text));
          if (r && r.ok) await waitFor(view, 'did-stop-loading', 1500);
          return r;
        }
        case 'type':
          return await run(typeCode(args.selector, args.text, !!args.submit));
        case 'scroll':
          await run(`window.scrollBy(0, ${Number(args.dy) || 0})`);
          return { ok: true };
        case 'eval': {
          const value = await run(String(args.code || ''));
          return { ok: true, result: value === undefined ? null : value };
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
