// Dev helper: screenshot a running window over CDP.
// Usage: node scripts/cdp-shot.js <index|spotlight> <out.png>
const PORT = process.env.CDP_PORT || 9333;
const fs = require('fs');

(async () => {
  const [which = 'index', out = 'shot.png'] = process.argv.slice(2);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find((x) => x.url.endsWith(`${which}.html`));
  if (!t) throw new Error('target not found');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (id, method, params) => new Promise((res) => {
    const on = (m) => { const d = JSON.parse(m.data); if (d.id === id) { ws.removeEventListener('message', on); res(d.result); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const r = await send(1, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  ws.close();
  console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
})().catch((e) => { console.error(e); process.exit(1); });
