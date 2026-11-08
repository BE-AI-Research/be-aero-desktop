const test = require('node:test');
const assert = require('node:assert');
const { ApiServer, newToken, tokenMatches, bearerFrom, HOST } = require('../src/main/api-server');
const { PaneRegistry } = require('../src/main/panes');

// Minimal stand-in for the real settings store.
function fakeStore(initial = {}) {
  const data = { api: { enabled: true, port: 0, token: null, apps: {} }, ...initial };
  return {
    get: (key) => (key ? data[key] : data),
    set: (patch) => {
      for (const [k, v] of Object.entries(patch)) {
        data[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...data[k], ...v } : v;
      }
      return data;
    },
    save: () => {}
  };
}

test('newToken produces distinct, url-safe tokens', () => {
  const a = newToken();
  assert.notStrictEqual(a, newToken());
  assert.ok(a.length >= 32);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(a));
});

test('tokenMatches rejects wrong, short and non-string tokens', () => {
  const t = newToken();
  assert.ok(tokenMatches(t, t));
  assert.ok(!tokenMatches(t, t.slice(0, -1)));
  assert.ok(!tokenMatches(t, `${t}x`));
  assert.ok(!tokenMatches(t, null));
  assert.ok(!tokenMatches(null, t));
});

test('bearerFrom reads both supported header styles', () => {
  assert.strictEqual(bearerFrom({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
  assert.strictEqual(bearerFrom({ headers: { 'x-aero-token': 'abc123' } }), 'abc123');
  assert.strictEqual(bearerFrom({ headers: {} }), null);
});

// ---------------------------------------------------------------- live server
// `approve` decides what the simulated user does at the pairing dialog.
async function withServer(run, { approve = true, storeOverrides, peer } = {}) {
  const panes = new PaneRegistry();
  const store = fakeStore(storeOverrides);
  const prompts = [];
  const server = new ApiServer({
    panes,
    store,
    userDataDir: null,                       // skip writing the token file in tests
    getTelemetry: async () => ({ cpu: 12, ram: 34 }),
    onPair: async (req) => { prompts.push(req); return typeof approve === 'function' ? approve(req) : approve; },
    peer
  });
  const port = await server.start();
  assert.ok(port, 'server should have started');

  const call = (method, path, { body, token, headers } = {}) => fetch(`http://${HOST}:${port}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token || server.token()}` }),
      'Content-Type': 'application/json',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  // Pair an app and return its token.
  const pair = async (name, capabilities) => {
    const res = await call('POST', '/v1/pair', { body: { name, capabilities } });
    return { status: res.status, body: await res.json() };
  };

  try {
    await run({ call, pair, port, panes, server, store, prompts });
  } finally {
    await server.stop();
  }
}

test('pairing needs the pairing token', async () => {
  await withServer(async ({ call, port }) => {
    const none = await fetch(`http://${HOST}:${port}/v1/pair`, { method: 'POST' });
    assert.strictEqual(none.status, 401);
    const wrong = await call('POST', '/v1/pair', { token: newToken(), body: { name: 'X', capabilities: ['panes'] } });
    assert.strictEqual(wrong.status, 401);
  });
});

test('pairing prompts the user and issues a scoped token', async () => {
  await withServer(async ({ pair, prompts }) => {
    const { status, body } = await pair('Build Monitor', ['panes']);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.name, 'Build Monitor');
    assert.deepStrictEqual(body.capabilities, ['panes']);
    assert.ok(body.token && body.appId);
    assert.deepStrictEqual(prompts, [{ name: 'Build Monitor', capabilities: ['panes'], exePath: null, binary: null }]);
  });
});

test('a declined pairing issues nothing', async () => {
  await withServer(async ({ pair, server }) => {
    const { status, body } = await pair('Sneaky', ['panes', 'telemetry']);
    assert.strictEqual(status, 403);
    assert.ok(!body.token);
    assert.strictEqual(server.listApps().length, 0);
  }, { approve: false });
});

test('pairing requires at least one real capability', async () => {
  await withServer(async ({ pair }) => {
    assert.strictEqual((await pair('X', [])).status, 400);
    assert.strictEqual((await pair('X', ['root'])).status, 400);
  });
});

test('the pairing token itself cannot call the API', async () => {
  await withServer(async ({ call }) => {
    // The pairing token opens the conversation; it is not an access token.
    assert.strictEqual((await call('GET', '/v1/ping')).status, 401);
    assert.strictEqual((await call('GET', '/v1/panes')).status, 401);
  });
});

test('an app token only unlocks what it was granted', async () => {
  await withServer(async ({ call, pair }) => {
    const { body: app } = await pair('Panes Only', ['panes']);
    const t = app.token;

    const ping = await call('GET', '/v1/ping', { token: t });
    assert.strictEqual(ping.status, 200);
    assert.strictEqual((await ping.json()).you.name, 'Panes Only');

    assert.strictEqual((await call('PUT', '/v1/panes/a', { token: t, body: { title: 'A' } })).status, 200);

    // Never requested telemetry, so it is refused with a clear reason.
    const tel = await call('GET', '/v1/telemetry', { token: t });
    assert.strictEqual(tel.status, 403);
    assert.strictEqual((await tel.json()).capability, 'telemetry');
  });
});

test('blocking a capability in Settings takes effect immediately', async () => {
  await withServer(async ({ call, pair, server }) => {
    const { body: app } = await pair('Watcher', ['panes', 'telemetry']);
    assert.strictEqual((await call('GET', '/v1/telemetry', { token: app.token })).status, 200);

    server.setAppGrant(app.appId, 'telemetry', 'denied');
    assert.strictEqual((await call('GET', '/v1/telemetry', { token: app.token })).status, 403);
    // Its other capability is untouched.
    assert.strictEqual((await call('GET', '/v1/panes', { token: app.token })).status, 200);
  });
});

test('apps cannot see, change or delete each other\'s panes', async () => {
  await withServer(async ({ call, pair }) => {
    const { body: a } = await pair('App A', ['panes']);
    const { body: b } = await pair('App B', ['panes']);

    // Both use the same pane id; they must not collide.
    await call('PUT', '/v1/panes/status', { token: a.token, body: { title: 'From A' } });
    await call('PUT', '/v1/panes/status', { token: b.token, body: { title: 'From B' } });

    assert.strictEqual((await (await call('GET', '/v1/panes/status', { token: a.token })).json()).title, 'From A');
    assert.strictEqual((await (await call('GET', '/v1/panes/status', { token: b.token })).json()).title, 'From B');

    // A listing only ever shows your own.
    const listA = await (await call('GET', '/v1/panes', { token: a.token })).json();
    assert.strictEqual(listA.panes.length, 1);
    assert.strictEqual(listA.panes[0].title, 'From A');

    // Deleting removes only your own copy.
    await call('DELETE', '/v1/panes/status', { token: a.token });
    assert.strictEqual((await call('GET', '/v1/panes/status', { token: a.token })).status, 404);
    assert.strictEqual((await call('GET', '/v1/panes/status', { token: b.token })).status, 200);

    // And a bulk clear is scoped too.
    await call('PUT', '/v1/panes/x', { token: a.token, body: { title: 'x' } });
    await call('DELETE', '/v1/panes', { token: a.token });
    assert.strictEqual((await (await call('GET', '/v1/panes', { token: b.token })).json()).panes.length, 1);
  });
});

test('revoking an app kills its token and removes its panes', async () => {
  await withServer(async ({ call, pair, server, panes }) => {
    const { body: a } = await pair('Doomed', ['panes']);
    const { body: b } = await pair('Keeper', ['panes']);
    await call('PUT', '/v1/panes/one', { token: a.token, body: { title: 'A' } });
    await call('PUT', '/v1/panes/two', { token: b.token, body: { title: 'B' } });
    assert.strictEqual(panes.list().length, 2);

    server.revokeApp(a.appId);
    assert.strictEqual((await call('GET', '/v1/ping', { token: a.token })).status, 401);
    assert.strictEqual(panes.list().length, 1, 'its panes should be gone');
    assert.strictEqual((await call('GET', '/v1/ping', { token: b.token })).status, 200);
  });
});

test('one app cannot flood the sidebar', async () => {
  await withServer(async ({ call, pair, panes }) => {
    const { body: a } = await pair('Chatty', ['panes']);
    let refused = 0;
    for (let i = 0; i < panes.perOwner + 3; i++) {
      const res = await call('PUT', `/v1/panes/p${i}`, { token: a.token, body: { title: `p${i}` } });
      if (res.status === 400) refused++;
    }
    assert.strictEqual(panes.countFor(a.appId), panes.perOwner);
    assert.strictEqual(refused, 3);
  });
});

test('API rejects anything sent from a browser origin', async () => {
  await withServer(async ({ call }) => {
    const res = await call('GET', '/v1/ping', { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(res.status, 403);
  });
});

test('malformed panes and unknown endpoints answer cleanly', async () => {
  await withServer(async ({ call, pair }) => {
    const { body: a } = await pair('X', ['panes']);
    assert.strictEqual((await call('PUT', '/v1/panes/has space', { token: a.token, body: {} })).status, 400);
    assert.strictEqual((await call('GET', '/v1/nope', { token: a.token })).status, 404);
    assert.strictEqual((await call('GET', '/v2/ping', { token: a.token })).status, 404);
  });
});

test('rotating the pairing token blocks new pairings but keeps paired apps working', async () => {
  await withServer(async ({ call, pair, server }) => {
    const { body: a } = await pair('Early', ['panes']);
    const old = server.token();
    server.regenerateToken();

    const stale = await call('POST', '/v1/pair', { token: old, body: { name: 'Late', capabilities: ['panes'] } });
    assert.strictEqual(stale.status, 401);
    assert.strictEqual((await call('GET', '/v1/ping', { token: a.token })).status, 200);
  });
});

test('API does not start when disabled', async () => {
  const server = new ApiServer({
    panes: new PaneRegistry(),
    store: fakeStore({ api: { enabled: false, port: 0, token: null, apps: {} } }),
    userDataDir: null,
    getTelemetry: async () => ({})
  });
  assert.strictEqual(await server.start(), null);
  await server.stop();
});

// ------------------------------------------------- binary-bound identity
// A controllable stand-in for the Windows peer resolver: tests decide what
// executable the server "sees" on each connection.
function fakePeer(initialPath) {
  return {
    current: initialPath,
    identify() { return Promise.resolve(this.current ? { pid: 1234, path: this.current } : null); }
  };
}

test('pairing records the executable and shows it to the user', async () => {
  const peer = fakePeer('C:\\Tools\\build.exe');
  await withServer(async ({ pair, prompts, server }) => {
    const { status } = await pair('Build Monitor', ['panes']);
    assert.strictEqual(status, 200);
    assert.strictEqual(prompts[0].exePath, 'C:\\Tools\\build.exe');
    assert.strictEqual(server.listApps()[0].exePath, 'C:\\Tools\\build.exe');
  }, { peer });
});

test('pairing is refused when the caller cannot be identified', async () => {
  const peer = fakePeer(null);
  await withServer(async ({ pair, prompts }) => {
    const { status, body } = await pair('Ghost', ['panes']);
    assert.strictEqual(status, 403);
    assert.match(body.error, /could not identify/);
    // Fail closed BEFORE the dialog: no prompt is ever raised.
    assert.strictEqual(prompts.length, 0);
  }, { peer });
});

test('a token presented by a different binary is refused', async () => {
  const peer = fakePeer('C:\\Tools\\build.exe');
  await withServer(async ({ call, pair }) => {
    const { body: app } = await pair('Build Monitor', ['panes']);
    assert.strictEqual((await call('GET', '/v1/ping', { token: app.token })).status, 200);

    // The same token now arrives from another executable - a stolen token.
    peer.current = 'C:\\Evil\\stealer.exe';
    const res = await call('GET', '/v1/ping', { token: app.token });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /different program/);
    assert.strictEqual(body.expected, 'C:\\Tools\\build.exe');

    // Back on the right binary, the token works again.
    peer.current = 'C:\\Tools\\build.exe';
    assert.strictEqual((await call('GET', '/v1/ping', { token: app.token })).status, 200);
  }, { peer });
});

test('path comparison is case-insensitive like NTFS', async () => {
  const peer = fakePeer('C:\\Tools\\build.exe');
  await withServer(async ({ call, pair }) => {
    const { body: app } = await pair('Build Monitor', ['panes']);
    peer.current = 'c:\\TOOLS\\Build.EXE';
    assert.strictEqual((await call('GET', '/v1/ping', { token: app.token })).status, 200);
  }, { peer });
});

test('an unidentifiable caller cannot use a bound token', async () => {
  const peer = fakePeer('C:\\Tools\\build.exe');
  await withServer(async ({ call, pair }) => {
    const { body: app } = await pair('Build Monitor', ['panes']);
    // Resolution fails mid-session (process table race, elevation, ...).
    peer.current = null;
    assert.strictEqual((await call('GET', '/v1/ping', { token: app.token })).status, 403);
  }, { peer });
});

test('legacy apps without a bound path still work, bound ones stay strict', async () => {
  const peer = fakePeer('C:\\Tools\\build.exe');
  await withServer(async ({ call, server }) => {
    // Simulate an app paired before binding existed.
    const apps = require('../src/main/apps');
    const legacy = apps.createApp({ name: 'Old Timer', capabilities: ['panes'], now: 1 });
    server.saveApps({ [legacy.id]: legacy });

    peer.current = 'C:\\Random\\whatever.exe';
    assert.strictEqual((await call('GET', '/v1/ping', { token: legacy.token })).status, 200);
  }, { peer });
});

test('without a peer resolver the API still enforces tokens', async () => {
  // No peer passed at all (platform without support): plain token auth.
  await withServer(async ({ call, pair }) => {
    const { body: app } = await pair('Plain', ['panes']);
    assert.strictEqual((await call('GET', '/v1/ping', { token: app.token })).status, 200);
    assert.strictEqual((await call('GET', '/v1/ping', { token: newToken() })).status, 401);
  });
});
