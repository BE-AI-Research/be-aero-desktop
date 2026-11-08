// Dev helper: verifies widget geometry survives mode switches and restarts.
// Free-form positions and docked heights are stored separately, so moving a
// widget in one mode must never disturb the other.
// Start the app with --remote-debugging-port=9333, then: node scripts/cdp-layout.js
const PORT = process.env.CDP_PORT || 9333;

let ws = null;
let nextId = 1;

async function connect(which) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find((x) => x.url.endsWith(`${which}.html`));
  if (!t) throw new Error('target not found: ' + targets.map((x) => x.url).join(', '));
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
}

function evaluate(expression) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const on = (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== id) return;
      ws.removeEventListener('message', on);
      if (d.result.exceptionDetails) return rej(new Error(d.result.exceptionDetails.exception?.description || 'eval threw'));
      res(d.result.result.value);
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

const fails = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fails.push(label);
}

const settle = (ms = 700) => evaluate(`new Promise(r => setTimeout(r, ${ms}))`);
const setMode = (dock) => evaluate(
  `(async () => { await window.aero.setSettings({ dock: ${JSON.stringify(dock)} });
     await new Promise(r => setTimeout(r, 700)); return true; })()`);
const layout = () => evaluate(
  'window.aero.getSettings().then(s => ({ free: s.layout.free, docked: s.layout.docked, dock: s.dock }))');

// Drag a widget body (free mode) or its grip (resize) with synthetic pointers.
const gesture = (sel, useGrip, dx, dy) => evaluate(`(async () => {
  const w = document.querySelector(${JSON.stringify(sel)});
  const el = ${useGrip} ? w.querySelector('.resize-grip') : w;
  const r = el.getBoundingClientRect();
  const sx = Math.round(r.left + r.width / 2), sy = Math.round(r.top + (${useGrip} ? r.height / 2 : 8));
  const ev = (type, x, y) => el.dispatchEvent(new PointerEvent(type,
    { pointerId: 7, bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
  ev('pointerdown', sx, sy);
  for (let i = 1; i <= 6; i++) { ev('pointermove', sx + (${dx} * i) / 6, sy + (${dy} * i) / 6); await new Promise(r => setTimeout(r, 20)); }
  ev('pointerup', sx + ${dx}, sy + ${dy});
  await new Promise(r => setTimeout(r, 800));
  const b = w.getBoundingClientRect();
  return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
})()`);

(async () => {
  await connect('index');
  await evaluate(`(() => { Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {}; return true; })()`);

  // Start from a clean slate so the assertions are about saving, not leftovers.
  await evaluate(`window.aero.replaceSettings('layout', { free: {}, docked: {} })`);
  await settle();

  // ---------------------------------------------------- free: move and resize
  await setMode('free');
  const moved = await gesture('[data-widget="clock"]', false, -300, 180);
  const resizedFree = await gesture('[data-widget="clock"]', true, 70, 60);
  const afterFree = await layout();
  check('free: clock geometry saved under layout.free',
    !!afterFree.free.clock && afterFree.free.clock.w > 0, afterFree.free.clock);
  check('free: layout.docked untouched by free-mode edits',
    Object.keys(afterFree.docked).length === 0, afterFree.docked);
  const freeGeo = afterFree.free.clock;

  // --------------------------------------------- docked: resize height only
  await setMode('right');
  const resizedDock = await gesture('[data-widget="clock"]', true, 0, 70);
  const afterDock = await layout();
  check('docked: clock height saved under layout.docked',
    !!afterDock.docked.clock && afterDock.docked.clock.h > 0, afterDock.docked.clock);
  check('docked: layout.free survived the mode switch unchanged',
    JSON.stringify(afterDock.free.clock) === JSON.stringify(freeGeo),
    { before: freeGeo, after: afterDock.free.clock });
  const dockGeo = afterDock.docked.clock;

  // ------------------------------------------- switch back: nothing reset
  await setMode('free');
  const back = await evaluate(`(() => { const w = document.querySelector('[data-widget="clock"]');
    const b = w.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; })()`);
  check('free: widget returns to its saved spot after a round trip',
    Math.abs(back.x - freeGeo.x) <= 2 && Math.abs(back.y - freeGeo.y) <= 2 &&
    Math.abs(back.w - freeGeo.w) <= 2 && Math.abs(back.h - freeGeo.h) <= 2,
    { saved: freeGeo, shown: back });

  await setMode('right');
  const backDock = await evaluate(`(() => {
    const b = document.querySelector('[data-widget="clock"]').getBoundingClientRect();
    return { h: Math.round(b.height) }; })()`);
  check('docked: height returns after a round trip',
    Math.abs(backDock.h - dockGeo.h) <= 2, { saved: dockGeo, shown: backDock });

  const final = await layout();
  check('both layouts coexist in settings',
    !!final.free.clock && !!final.docked.clock, final);

  // Flush the debounced write so a restart check can read it from disk.
  await evaluate('window.aero.getSettings()');
  await settle(900);
  console.log('\nsaved state for restart check: ' + JSON.stringify({ free: final.free.clock, docked: final.docked.clock }));

  ws.close();
  console.log(fails.length ? `\nFAILURES: ${fails.join(' | ')}` : '\nall layout persistence checks passed');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
