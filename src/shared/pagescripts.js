// In-page JavaScript the assistant runs inside web pages - shared by the
// web-widget path (renderer, <webview>.executeJavaScript) and the OS-browser
// path (main, Chrome DevTools Protocol Runtime.evaluate). Every builder
// returns a self-contained expression that evaluates to a JSON-safe value.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AeroPageScripts = factory();
})(this, function () {
  const J = (v) => JSON.stringify(v === undefined ? null : v);

  const READ_PAGE = `(() => {
    const body = document.body ? document.body.innerText : '';
    const text = body.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').slice(0, 20000);
    return { title: document.title, url: location.href, text, length: body.length };
  })()`;

  // Numbered interactive elements. Each gets a data-aero-idx attribute so a
  // later click/type can target it by index without re-deriving a selector.
  const ELEMENTS = `(() => {
    const out = [];
    const nodes = document.querySelectorAll('a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [contenteditable="true"], [onclick]');
    const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    let idx = 0;
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      idx += 1;
      el.setAttribute('data-aero-idx', String(idx));
      const item = { index: idx, tag: el.tagName.toLowerCase(), text: label(el) };
      if (el.type) item.type = el.type;
      if (el.href) item.href = String(el.href).slice(0, 200);
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') item.value = String(el.value || '').slice(0, 80);
      if (el.tagName === 'SELECT') item.options = [...el.options].slice(0, 20).map((o) => o.textContent.trim());
      if (r.top > window.innerHeight || r.bottom < 0) item.offscreen = true;
      out.push(item);
      if (out.length >= 150) break;
    }
    return { url: location.href, title: document.title, count: out.length, elements: out };
  })()`;

  // Expression resolving ONE element from { index | selector | text }.
  function targetExpr(spec) {
    const s = spec || {};
    return `(() => {
      const spec = ${J({ index: s.index, selector: s.selector, text: s.text })};
      if (spec.index !== null && spec.index !== undefined) {
        const byIdx = document.querySelector('[data-aero-idx="' + spec.index + '"]');
        if (byIdx) return byIdx;
      }
      if (spec.selector) { const el = document.querySelector(spec.selector); if (el) return el; }
      if (spec.text) {
        const want = String(spec.text).trim().toLowerCase();
        const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '').trim().toLowerCase();
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width && r.height; };
        const pools = [
          document.querySelectorAll('a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"], summary, label'),
          document.querySelectorAll('li, span, div, td, th, p, h1, h2, h3, h4, option')
        ];
        for (const pool of pools) {
          const els = [...pool].filter(visible);
          const exact = els.find((e) => label(e) === want);
          if (exact) return exact;
          const partial = els.find((e) => label(e).includes(want) && e.children.length < 6);
          if (partial) return partial;
        }
      }
      return null;
    })()`;
  }

  function clickCode(spec) {
    return `(() => {
      const el = ${targetExpr(spec)};
      if (!el) return { ok: false, error: 'no matching element' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      for (const t of ['pointerover', 'pointerenter', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown']) el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, opts) : new MouseEvent(t, opts));
      if (typeof el.focus === 'function') el.focus();
      for (const t of ['pointerup', 'mouseup']) el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, opts) : new MouseEvent(t, opts));
      el.click();
      const href = el.href || (el.closest('a') && el.closest('a').href) || null;
      return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120), href };
    })()`;
  }

  function typeCode(spec, text, submit, clear) {
    return `(() => {
      let el = ${targetExpr(spec)};
      if (!el) return { ok: false, error: 'no matching input' };
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable) {
        const inner = el.querySelector('input, textarea, [contenteditable="true"]');
        if (inner) el = inner;
      }
      el.scrollIntoView({ block: 'center' });
      el.focus();
      el.dispatchEvent(new FocusEvent('focus', { bubbles: false }));
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      const v = ${J(String(text || ''))};
      if (el.isContentEditable) {
        if (${clear !== false}) el.textContent = '';
        document.execCommand && document.execCommand('insertText', false, v) || (el.textContent += v);
      } else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        const next = ${clear !== false} ? v : (el.value || '') + v;
        if (desc && desc.set) desc.set.call(el, next); else el.value = next;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: v, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (${!!submit}) {
        const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', k));
        el.dispatchEvent(new KeyboardEvent('keypress', k));
        el.dispatchEvent(new KeyboardEvent('keyup', k));
        const form = el.form || el.closest('form');
        if (form && typeof form.requestSubmit === 'function') { try { form.requestSubmit(); } catch {} }
      }
      return { ok: true, value: String(el.value || el.textContent || '').slice(0, 120) };
    })()`;
  }

  function findCode(query) {
    return `(() => {
      const q = ${J(String(query || '').toLowerCase())};
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        if (out.length >= 30) break;
        if (el.children.length < 3) {
          const t = (el.innerText || el.value || '').trim();
          if (t && t.toLowerCase().includes(q) && t.length < 300) {
            const r = el.getBoundingClientRect();
            if (r.width && r.height) out.push({ tag: el.tagName.toLowerCase(), text: t.slice(0, 160), index: Number(el.getAttribute('data-aero-idx')) || undefined, href: el.href || undefined });
          }
        }
      }
      return { matches: out };
    })()`;
  }

  function selectCode(spec, value) {
    return `(() => {
      const el = ${targetExpr(spec)};
      if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'no <select> there' };
      const v = ${J(String(value || ''))};
      const opt = [...el.options].find((o) => o.value === v || o.textContent.trim() === v) || [...el.options].find((o) => o.textContent.trim().toLowerCase().includes(v.toLowerCase()));
      if (!opt) return { ok: false, error: 'no such option', options: [...el.options].map((o) => o.textContent.trim()).slice(0, 40) };
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: opt.textContent.trim() };
    })()`;
  }

  function hoverCode(spec) {
    return `(() => {
      const el = ${targetExpr(spec)};
      if (!el) return { ok: false, error: 'no matching element' };
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o));
      return { ok: true };
    })()`;
  }

  const waitCode = (selector) => `!!document.querySelector(${J(String(selector || ''))})`;
  const scrollCode = (dy) => `(() => { window.scrollBy(0, ${Number(dy) || 0}); return { ok: true, y: window.scrollY, max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) }; })()`;
  const READY = `document.readyState`;

  return { READ_PAGE, ELEMENTS, READY, targetExpr, clickCode, typeCode, findCode, selectCode, hoverCode, waitCode, scrollCode };
});
