const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AiWidgets, normHost, hostAllowed, cspFor } = require('../src/main/ai/widgets');

test('AI widgets: hosts normalise to origins; only approved ones are reachable', () => {
  assert.strictEqual(normHost('api.example.com'), 'https://api.example.com');
  assert.strictEqual(normHost('https://api.example.com/v1/x?y=1'), 'https://api.example.com');
  assert.strictEqual(normHost('http://192.168.1.38:8123/lovelace'), 'http://192.168.1.38:8123');
  assert.strictEqual(normHost('*.example.com'), 'https://*.example.com');
  assert.strictEqual(normHost('ftp://x.com'), null);
  assert.strictEqual(normHost('javascript:alert(1)'), null);
  const ok = ['https://api.example.com', 'http://192.168.1.38:8123', 'https://*.cdn.net'];
  assert.ok(hostAllowed('https://api.example.com/data', ok));
  assert.ok(hostAllowed('http://192.168.1.38:8123/api/states', ok));
  assert.ok(hostAllowed('https://a.b.cdn.net/x', ok));
  assert.ok(!hostAllowed('http://api.example.com/data', ok), 'scheme must match');
  assert.ok(!hostAllowed('https://evil.com/?https://api.example.com', ok));
  assert.ok(!hostAllowed('https://api.example.com.evil.com/', ok));
  assert.match(cspFor([]), /connect-src 'none'/);
  assert.match(cspFor(ok), /connect-src https:\/\/api\.example\.com http:\/\/192\.168\.1\.38:8123/);
});

test('AI widgets: a folder per widget, approvals outside the AI folder, state, removal', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-aiw-'));
  const aiFolder = path.join(base, 'BE-Aero AI');
  const asked = [];
  let answer = false;
  const changes = [];
  const mk = () => new AiWidgets({
    folder: async () => aiFolder,
    approvalsFile: path.join(base, 'userdata', 'widget-approvals.json'),
    approve: async (w, hosts) => { asked.push(hosts); return answer; },
    onChange: (l) => changes.push(l.length)
  });
  try {
    const w = mk();
    await w.load();
    const r = await w.create({ title: 'BTC: price', html: '<div id=p></div>', hosts: ['api.coingecko.com'] });
    assert.ok(fs.existsSync(path.join(aiFolder, 'AI Widgets', 'BTC price', 'index.html')), 'its own folder, safe name');
    assert.deepStrictEqual(asked, [['https://api.coingecko.com']]);
    assert.deepStrictEqual(r.approvedHosts, [], 'blocked: the user said no');
    assert.match(w.csp(r.id), /connect-src 'none'/);
    await assert.rejects(w.fetch(r.id, { url: 'https://api.coingecko.com/x' }), /not an approved site/);
    // approve on review
    answer = true;
    await w.askHosts(w.get(r.id));
    assert.deepStrictEqual(w.approved(r.id), ['https://api.coingecko.com']);
    assert.match(w.csp(r.id), /connect-src https:\/\/api\.coingecko\.com/);
    // approvals are not in the AI folder (the assistant can write there)
    assert.ok(!fs.readFileSync(path.join(aiFolder, 'AI Widgets', 'BTC price', 'widget.json'), 'utf8').includes('approved'));
    // the page gets the bridge
    assert.match(w.page(r.id), /window\.aeroWidget=/);
    // state
    await w.setState(r.id, { n: 3 });
    assert.deepStrictEqual(await w.getState(r.id), { n: 3 });
    await assert.rejects(w.setState(r.id, 'x'.repeat(300 * 1024)), /too large/);
    // dropping a host drops its approval
    await w.update(r.id, { hosts: [] });
    assert.deepStrictEqual(w.approved(r.id), []);
    // a fresh instance reads the folders back
    const w2 = mk();
    const list = await w2.load();
    assert.deepStrictEqual(list.map((x) => x.title), ['BTC: price']);
    assert.ok(await w2.remove(r.id));
    assert.ok(!fs.existsSync(path.join(aiFolder, 'AI Widgets', 'BTC price')));
    assert.deepStrictEqual(await w2.load(), []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('AI widgets: an html file becomes a widget with its own files; nothing outside is served', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-aiw-html-'));
  try {
    const page = path.join(base, 'site');
    fs.mkdirSync(path.join(page, 'img'), { recursive: true });
    fs.writeFileSync(path.join(page, 'clock.html'), '<html><head><title>World clock</title><link rel="stylesheet" href="style.css"></head><body><img src="img/logo.png"><script src="https://cdn.jsdelivr.net/x.js"></script><a href="../secret.txt">x</a></body></html>');
    fs.writeFileSync(path.join(page, 'style.css'), 'body{color:red}');
    fs.writeFileSync(path.join(page, 'img', 'logo.png'), 'PNG');
    fs.writeFileSync(path.join(base, 'secret.txt'), 'outside the page folder');
    const w = new AiWidgets({ folder: async () => path.join(base, 'BE-Aero AI'), approvalsFile: path.join(base, 'ud', 'a.json'), approve: async () => false });
    await w.load();
    const r = await w.createFromFile(path.join(page, 'clock.html'));
    assert.strictEqual(r.title, 'World clock');
    assert.strictEqual(r.copied, 2, 'style.css and img/logo.png; not the remote script, not ../secret.txt');
    assert.ok(w.asset(r.id, '/style.css'));
    assert.ok(w.asset(r.id, '/img/logo.png'));
    assert.strictEqual(w.asset(r.id, '/../../secret.txt'), null);
    assert.strictEqual(w.asset(r.id, '/%2e%2e/%2e%2e/secret.txt'), null);
    assert.strictEqual(w.asset(r.id, '/state.json'), null, 'its own data is not served');
    await assert.rejects(w.createFromFile(path.join(page, 'style.css')), /not an HTML file/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
