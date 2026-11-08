// Dev helper: evaluate an expression in a running window over CDP.
// Usage: node scripts/cdp-eval.js <index|spotlight> "<expression>"
// Start the app with --remote-debugging-port=9333 (or set CDP_PORT).
const PORT = process.env.CDP_PORT || 9333;

(async () => {
  const [which = 'index', expression = 'document.title'] = process.argv.slice(2);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find((x) => x.url.endsWith(`${which}.html`));
  if (!t) throw new Error('target not found: ' + targets.map((x) => x.url).join(', '));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const result = await new Promise((res) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d.result); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  const out = result.exceptionDetails ? { error: result.exceptionDetails.exception?.description } : result.result.value;
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
