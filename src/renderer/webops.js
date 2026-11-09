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

  // Interactive elements with stable selectors the model can act on.
  const ELEMENTS = `(() => {
    const out = [];
    const seen = new Set();
    const nodes = document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"]');
    const cssPath = (el) => {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 5) {
        let seg = cur.tagName.toLowerCase();
        if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
        const name = cur.getAttribute('name');
        if (name && /^[\w-]+$/.test(name)) seg += '[name="' + name + '"]';
        else {
          const sibs = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
          if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
        }
        parts.unshift(seg);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    };
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const sel = cssPath(el);
      if (seen.has(sel)) continue;
      seen.add(sel);
      const item = { tag: el.tagName.toLowerCase(), selector: sel, text };
      if (el.type) item.type = el.type;
      if (el.href) item.href = el.href.slice(0, 200);
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') item.value = String(el.value || '').slice(0, 80);
      out.push(item);
      if (out.length >= 120) break;
    }
    return { url: location.href, title: document.title, count: out.length, elements: out };
  })()`;

  function findCode(query) {
    return `(() => {
      const q = ${JSON.stringify(String(query || '').toLowerCase())};
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        if (out.length >= 30) break;
        if (!el.children.length || el.children.length < 3) {
          const t = (el.innerText || el.value || '').trim();
          if (t && t.toLowerCase().includes(q) && t.length < 300) {
            const r = el.getBoundingClientRect();
            if (r.width && r.height) out.push({ tag: el.tagName.toLowerCase(), text: t.slice(0, 160), id: el.id || undefined, href: el.href || undefined });
          }
        }
      }
      return { matches: out };
    })()`;
  }

  function selectCode(selector, value) {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector || '')});
      if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'no <select> at that selector' };
      const v = ${JSON.stringify(String(value || ''))};
      const opt = [...el.options].find((o) => o.value === v || o.textContent.trim() === v);
      if (!opt) return { ok: false, error: 'no such option', options: [...el.options].map((o) => o.textContent.trim()).slice(0, 40) };
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: opt.textContent.trim() };
    })()`;
  }

  function hoverCode(selector) {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector || '')});
      if (!el) return { ok: false, error: 'no matching element' };
      el.scrollIntoView({ block: 'center' });
      for (const t of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) el.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      return { ok: true };
    })()`;
  }

  function waitCode(selector) {
    return `!!document.querySelector(${JSON.stringify(selector || '')})`;
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
        case 'elements':
          return { ok: true, ...(await run(ELEMENTS)) };
        case 'find':
          return { ok: true, ...(await run(findCode(args.query))) };
        case 'select':
          return await run(selectCode(args.selector, args.value));
        case 'hover':
          return await run(hoverCode(args.selector));
        case 'submit': {
          const r = await run(`(() => { const el = document.querySelector(${JSON.stringify(args.selector || 'form')}); const f = el && (el.tagName === 'FORM' ? el : el.form); if (!f) return { ok: false, error: 'no form' }; if (f.requestSubmit) f.requestSubmit(); else f.submit(); return { ok: true }; })()`);
          if (r && r.ok) await waitFor(view, 'did-stop-loading', 8000);
          return r;
        }
        case 'back':
          if (!view.canGoBack()) return { ok: false, error: 'nothing to go back to' };
          view.goBack(); await waitFor(view, 'did-stop-loading', 10000);
          return { ok: true, url: view.getURL() };
        case 'forward':
          if (!view.canGoForward()) return { ok: false, error: 'nothing to go forward to' };
          view.goForward(); await waitFor(view, 'did-stop-loading', 10000);
          return { ok: true, url: view.getURL() };
        case 'wait': {
          const until = Date.now() + Math.min(30000, Math.max(100, Number(args.ms) || 10000));
          if (args.selector) {
            while (Date.now() < until) {
              if (await run(waitCode(args.selector))) return { ok: true, found: true };
              await new Promise((r) => setTimeout(r, 250));
            }
            return { ok: false, error: 'timed out waiting for ' + args.selector };
          }
          await new Promise((r) => setTimeout(r, until - Date.now()));
          return { ok: true };
        }
        case 'reload':
          view.reload(); await waitFor(view, 'did-stop-loading', 15000);
          return { ok: true, url: view.getURL() };
        default:
          return { ok: false, error: `unknown op ${op}` };
      }
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  window.AeroWebOps = { handle, NOTIFICATION_SHIM, parseNotifyMessage, NOTIFY_PREFIX };
})();
