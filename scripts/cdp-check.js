// Dev helper: drives the running app over the Chrome DevTools Protocol to
// smoke-test the Spotlight window. Start the app with --remote-debugging-port=9333.
const PORT = process.env.CDP_PORT || 9333;

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const result = await new Promise((res) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d.result); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  return result.exceptionDetails ? { error: result.exceptionDetails.exception?.description } : result.result.value;
}

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const spot = targets.find((t) => t.url.endsWith('spotlight.html'));
  const side = targets.find((t) => t.url.endsWith('index.html'));
  if (!spot || !side) throw new Error('targets not found: ' + targets.map((t) => t.url).join(', '));

  const wait = 'new Promise(r => setTimeout(r, 600))';
  const typeAndRead = (q) => `(async () => {
    const i = document.getElementById('q'); i.value = ${JSON.stringify(q)};
    i.dispatchEvent(new Event('input')); await ${wait};
    return {
      groups: [...document.querySelectorAll('.group-label')].map(e => e.textContent),
      first: [...document.querySelectorAll('.item .name')].slice(0, 4).map(e => e.textContent),
      hint: document.getElementById('hint').textContent,
      ghost: document.getElementById('ghost').dataset.full || '',
      preview: document.getElementById('preview').innerText.slice(0, 160),
      icons: document.querySelectorAll('.item .ico img').length
    };
  })()`;

  console.log('sidebar search widget:', await evaluate(side.webSocketDebuggerUrl,
    `({ present: !!document.querySelector('.search-widget'), kbd: document.getElementById('search-kbd').textContent,
        hidden: document.querySelector('.search-widget').classList.contains('hidden') })`));
  for (const q of process.argv.slice(2).length ? process.argv.slice(2) : ['chrome', 'disp', '2+3*4', 'downlods']) {
    console.log(`\nquery "${q}":`, JSON.stringify(await evaluate(spot.webSocketDebuggerUrl, typeAndRead(q)), null, 1));
  }
  // Arrow-key navigation changes the selection.
  console.log('\nnav:', await evaluate(spot.webSocketDebuggerUrl, `(async () => {
    const i = document.getElementById('q'); i.value = 'chrome'; i.dispatchEvent(new Event('input')); await ${wait};
    const before = document.querySelector('.item.selected .name').textContent;
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await ${wait};
    const after = document.querySelector('.item.selected .name').textContent;
    i.value = ''; i.dispatchEvent(new Event('input'));
    return { before, after };
  })()`));
})().catch((e) => { console.error(e); process.exit(1); });
