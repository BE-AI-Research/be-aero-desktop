// Dev helper: a REAL mouse click (through Chromium's input pipeline, not a
// synthetic DOM click) on the element matching a selector, over CDP.
// Usage: CDP_PORT=9336 node scripts/cdp-click.js <index|spotlight> "<css selector>"
const PORT = process.env.CDP_PORT || 9333;

(async () => {
  const [which = 'index', selector] = process.argv.slice(2);
  if (!selector) throw new Error('selector required');
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find((x) => x.url.endsWith(`${which}.html`));
  if (!t) throw new Error('target not found');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); });
  const rectRes = await send('Runtime.evaluate', { expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`, returnByValue: true });
  const rect = rectRes.result && rectRes.result.result && rectRes.result.result.value;
  if (!rect) { console.log(JSON.stringify({ error: 'element not found' })); ws.close(); return; }
  if (!rect.w || !rect.h) { console.log(JSON.stringify({ error: 'element has no size', rect })); ws.close(); return; }
  const base = { x: rect.x, y: rect.y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  console.log(JSON.stringify({ clicked: selector, rect }));
  ws.close();
})().catch((e) => { console.error(e); process.exit(1); });
