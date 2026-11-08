// Dev helper: drives the running sidebar over the Chrome DevTools Protocol to
// smoke-test the widget UI - clock faces, telemetry styles, free-form layout,
// resize grips and themes. Start the app with --remote-debugging-port=9333.
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
    const onMessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (d.result.exceptionDetails) return rej(new Error(d.result.exceptionDetails.exception?.description || 'eval threw'));
      res(d.result.result.value);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

// Push a settings patch through the real IPC bridge and let the UI settle.
const patch = (obj) => evaluate(
  `(async () => { await window.aero.setSettings(${JSON.stringify(obj)});
     await new Promise(r => setTimeout(r, 450)); return true; })()`);

const fails = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) fails.push(label);
}

(async () => {
  await connect('index');

  // Collect uncaught errors for the duration of the run, and neutralise
  // pointer capture: synthetic PointerEvents carry no live pointer id, so
  // setPointerCapture would throw NotFoundError and abort every gesture.
  await evaluate(`(() => {
    window.__aeroErrors = [];
    addEventListener('error', (e) => window.__aeroErrors.push(String(e.message)));
    addEventListener('unhandledrejection', (e) => window.__aeroErrors.push('rejection: ' + e.reason));
    Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {};
    return true;
  })()`);

  // ------------------------------------------------------------ clock faces
  const CLOCK_STYLES = ['analog', 'classic', 'minimal', 'hybrid', 'digital', 'flip', 'rings'];
  for (const style of CLOCK_STYLES) {
    await patch({ clock: { style } });
    const r = await evaluate(`(() => {
      const f = document.getElementById('clock-face');
      return { cls: f.className, svg: f.querySelectorAll('svg').length, nodes: f.childElementCount,
               digital: !!f.querySelector('.clock-digital, .digital, .flip, .clock-dtime'),
               text: f.innerText.replace(/\\s+/g, ' ').trim().slice(0, 40) };
    })()`);
    check(`clock style "${style}" renders`, r.nodes > 0, r);
  }

  // ------------------------------------------------------- telemetry styles
  await patch({ telemetry: { metrics: { cpu: true, ram: true, disk: true, net: true } } });
  const TEL_STYLES = ['rings', 'arcs', 'bars', 'graph', 'compact'];
  for (const style of TEL_STYLES) {
    await patch({ telemetry: { style } });
    await evaluate('new Promise(r => setTimeout(r, 1700))'); // let a telemetry tick land
    const r = await evaluate(`(() => {
      const b = document.getElementById('telemetry-body');
      return { cls: b.className, kids: b.childElementCount,
               gauges: b.querySelectorAll('.gauge, .tbar, .tgraph, .tchip').length,
               empty: !!b.querySelector('.tempty'),
               values: [...b.querySelectorAll('.gauge-value, .tbar-value, .tchip-value')].map(e => e.textContent),
               text: b.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80) };
    })()`);
    const live = r.values.filter((v) => v && v !== '--').length;
    check(`telemetry style "${style}" renders 4 metrics with live values`,
      r.gauges === 4 && !r.empty && live >= 2, { ...r, live });
  }

  // per-core heatmap + footer
  await patch({ telemetry: { style: 'rings', showCores: true, showFooter: true } });
  await evaluate('new Promise(r => setTimeout(r, 1700))');
  const extras = await evaluate(`(() => {
    const c = document.getElementById('telemetry-cores'), f = document.getElementById('telemetry-foot');
    return { cores: c.childElementCount, coresHidden: c.classList.contains('hidden'),
             foot: f.textContent.trim(), footHidden: f.classList.contains('hidden') };
  })()`);
  check('per-core heatmap populated', extras.cores > 0 && !extras.coresHidden, extras);
  check('telemetry footer shows cores/mem/uptime', /CORES.*GB.*UP/.test(extras.foot), extras.foot);

  // disabling every metric shows the empty hint rather than breaking
  await patch({ telemetry: { metrics: { cpu: false, ram: false, disk: false, net: false, battery: false } } });
  const none = await evaluate(`(() => { const b = document.getElementById('telemetry-body');
    return { empty: !!b.querySelector('.tempty'), kids: b.childElementCount }; })()`);
  check('no metrics -> empty hint, no crash', none.empty, none);
  await patch({ telemetry: { metrics: { cpu: true, ram: true }, showCores: false } });

  // ------------------------------------------------------------ free-form mode
  await patch({ dock: 'free' });
  const free = await evaluate(`(async () => {
    const d = document.querySelector('[data-widget="clock"]');
    const r = d.getBoundingClientRect();
    return { body: document.body.className, free: document.body.classList.contains('free'),
             widget: { pos: getComputedStyle(d).position, x: Math.round(r.left), y: Math.round(r.top),
                       w: Math.round(r.width), h: Math.round(r.height) },
             grips: document.querySelectorAll('.resize-grip').length,
             vw: innerWidth, vh: innerHeight };
  })()`);
  check('free mode: window covers the work area (not a narrow strip)',
    free.vw > 900 && free.vh > 500, { vw: free.vw, vh: free.vh });
  check('free mode: body.free class set', free.free, free.body);
  check('free mode: widgets absolutely positioned', free.widget.pos === 'absolute', free.widget);
  check('free mode: resize grips present', free.grips > 0, { grips: free.grips });

  // Drag a widget to an arbitrary spot via real pointer events and confirm it
  // lands there and is persisted to settings.layout.free.
  const drag = await evaluate(`(async () => {
    const w = document.querySelector('[data-widget="clock"]');
    const handle = w;
    const r0 = w.getBoundingClientRect();
    const from = { x: Math.round(r0.left + Math.min(40, r0.width / 2)), y: Math.round(r0.top + 8) };
    const to = { x: 520, y: 360 };
    const ev = (type, x, y) => handle.dispatchEvent(new PointerEvent(type,
      { pointerId: 1, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
    ev('pointerdown', from.x, from.y);
    for (let i = 1; i <= 6; i++) {
      ev('pointermove', from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
      await new Promise(r => setTimeout(r, 20));
    }
    ev('pointerup', to.x, to.y);
    await new Promise(r => setTimeout(r, 700));
    const r1 = w.getBoundingClientRect();
    const s = await window.aero.getSettings();
    return { from, to, after: { x: Math.round(r1.left), y: Math.round(r1.top) },
             moved: Math.abs(r1.left - r0.left) > 20 || Math.abs(r1.top - r0.top) > 20,
             saved: s.layout && s.layout.free ? s.layout.free.clock : null };
  })()`);
  check('free mode: widget drags to an arbitrary position', drag.moved, drag);
  check('free mode: dragged position persisted to settings.layout.free', !!drag.saved, drag.saved);

  // ------------------------------------------------------------ resize a widget
  const resize = await evaluate(`(async () => {
    const w = document.querySelector('[data-widget="clock"]');
    const grip = w.querySelector('.resize-grip');
    if (!grip) return { skipped: 'no grip' };
    const r0 = w.getBoundingClientRect();
    const g = grip.getBoundingClientRect();
    const from = { x: Math.round(g.left + g.width / 2), y: Math.round(g.top + g.height / 2) };
    const ev = (type, x, y) => grip.dispatchEvent(new PointerEvent(type,
      { pointerId: 2, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
    ev('pointerdown', from.x, from.y);
    for (let i = 1; i <= 5; i++) { ev('pointermove', from.x + 12 * i, from.y + 10 * i); await new Promise(r => setTimeout(r, 20)); }
    ev('pointerup', from.x + 60, from.y + 50);
    await new Promise(r => setTimeout(r, 700));
    const r1 = w.getBoundingClientRect();
    const s = await window.aero.getSettings();
    return { before: { w: Math.round(r0.width), h: Math.round(r0.height) },
             after: { w: Math.round(r1.width), h: Math.round(r1.height) },
             grew: r1.width > r0.width + 10 || r1.height > r0.height + 10,
             saved: s.layout && s.layout.free ? s.layout.free.clock : null };
  })()`);
  check('resize grip resizes the widget', resize.grew, resize);

  // ------------------------------------------------------------ themes
  const themes = await evaluate('window.aero.listThemes().then(t => t.map(x => x.id))');
  check('themes exposed over IPC', Array.isArray(themes) && themes.length > 1, themes);
  for (const id of themes) {
    const r = await evaluate(`(async () => {
      await window.aero.replaceSettings('theme', { preset: ${JSON.stringify(id)}, custom: null });
      await new Promise(r => setTimeout(r, 350));
      const cs = getComputedStyle(document.documentElement);
      return { accent: cs.getPropertyValue('--accent').trim(), glass: cs.getPropertyValue('--glass-rgb').trim(),
               radius: cs.getPropertyValue('--radius').trim() };
    })()`);
    check(`theme "${id}" sets css vars`, !!r.accent && !!r.glass, r);
  }
  // custom override wins over the preset
  const custom = await evaluate(`(async () => {
    await window.aero.setSettings({ theme: { custom: { accent: '#ff0066' } } });
    await new Promise(r => setTimeout(r, 350));
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  })()`);
  check('custom accent override applies', custom.toLowerCase().includes('ff0066'), custom);

  // ------------------------------------------------------------ reset to sane state
  await evaluate(`(async () => {
    await window.aero.replaceSettings('theme', { preset: 'aero', custom: null });
    await window.aero.replaceSettings('layout', { free: {}, docked: {} });
    await window.aero.setSettings({ dock: 'right', clock: { style: 'analog' },
      telemetry: { style: 'rings', metrics: { cpu: true, ram: true, disk: false, net: false, battery: false } } });
    return true; })()`);

  const errors = await evaluate('(window.__aeroErrors || []).slice(0, 5)');
  check('no uncaught renderer errors', !errors || errors.length === 0, errors);

  ws.close();
  console.log(`\n${fails.length ? 'FAILURES: ' + fails.join(' | ') : 'all widget checks passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
