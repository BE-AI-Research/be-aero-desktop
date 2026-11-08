// Example client: pair once, then push a pane.
//
// Run it twice - the first time Aero Widgets asks the user to approve this
// program, and the token it returns is saved next to this script so later runs
// connect straight away.
//
//   node examples/clients/pair-and-push.js "Build Monitor"
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(process.env.APPDATA || '.', 'BE-Aero Desktop', 'api-token.json');
const SAVED = path.join(__dirname, '.aero-app.json');

function discover() {
  if (!fs.existsSync(CONFIG)) {
    throw new Error('BE-Aero Desktop is not listening - turn on the app API in Settings > Extensions');
  }
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

async function pair(cfg, name, capabilities) {
  const res = await fetch(`http://${cfg.host}:${cfg.port}/v1/pair`, {
    method: 'POST',
    headers: {
      // The pairing code only lets us ASK; the user still has to approve.
      Authorization: `Bearer ${cfg.pairingToken || cfg.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name, capabilities })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pairing failed (${res.status}): ${body.error}`);
  fs.writeFileSync(SAVED, JSON.stringify(body, null, 2), { mode: 0o600 });
  console.log(`paired as "${body.name}" with: ${body.capabilities.join(', ')}`);
  return body;
}

async function main() {
  const name = process.argv[2] || 'Example Client';
  const cfg = discover();
  const app = fs.existsSync(SAVED)
    ? JSON.parse(fs.readFileSync(SAVED, 'utf8'))
    : await pair(cfg, name, ['panes']);

  const call = (method, p, body) => fetch(`http://${cfg.host}:${cfg.port}${p}`, {
    method,
    headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const ping = await call('GET', '/v1/ping');
  if (ping.status === 401) {
    // The user disconnected us; forget the stale token and pair again.
    fs.unlinkSync(SAVED);
    throw new Error('this app was disconnected in Settings - run again to ask for access');
  }
  console.log('ping:', JSON.stringify(await ping.json()));

  let step = 0;
  const steps = ['Fetching sources', 'Compiling', 'Running tests', 'Packaging', 'Done'];
  const timer = setInterval(async () => {
    const progress = Math.round((step / (steps.length - 1)) * 100);
    const res = await call('PUT', '/v1/panes/build', {
      title: 'Build', subtitle: 'main', icon: '🔨',
      accent: step === steps.length - 1 ? '#34d399' : '#38bdf8',
      progress,
      lines: [steps[step]],
      metrics: [{ label: 'step', value: `${step + 1}/${steps.length}`, percent: progress }],
      actions: [{ label: 'View log', url: 'https://example.com/build/42' }]
    });
    if (!res.ok) { console.error('push failed:', (await res.json()).error); clearInterval(timer); return; }
    if (++step >= steps.length) { clearInterval(timer); console.log('finished'); }
  }, 1200);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
