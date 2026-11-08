// Local app API: lets other programs on this machine push widget panes and
// read telemetry, in any language, over plain HTTP.
//
// Security posture: bound to 127.0.0.1 only. Each client program pairs once -
// it asks, the user approves in a dialog, and it receives its OWN token with
// its OWN capabilities. From then on every request is attributable to one app,
// which the user can inspect, restrict or revoke individually. Pairing itself
// requires the pairing token from the app data folder, so only a process
// already running as this user can even raise the prompt.
//
// Tokens are additionally bound to the executable observed on the pairing
// connection: on every request Windows is asked which process owns the socket,
// and a token presented by a different binary is refused. A stolen token is
// therefore only usable by the very program it was issued to.
//
// Requests are capped in size, apps are isolated from each other's panes, and
// the only content that reaches the UI is the structured pane shape in
// panes.js, which the renderer draws as text.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const apps = require('./apps');

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 256 * 1024;
const TOKEN_FILE = 'api-token.json';
const PAIR_DENY_COOLDOWN_MS = 30 * 1000;

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Constant-time compare so a wrong token leaks nothing through timing.
function tokenMatches(expected, given) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bearerFrom(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (m) return m[1].trim();
  return typeof req.headers['x-aero-token'] === 'string' ? req.headers['x-aero-token'].trim() : null;
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch {
        reject(Object.assign(new Error('body must be valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

class ApiServer {
  constructor({ panes, store, userDataDir, getTelemetry, onPair, onAppsChanged, peer, onLog = () => {} }) {
    this.panes = panes;
    this.store = store;
    this.userDataDir = userDataDir;
    this.getTelemetry = getTelemetry;
    // Asks the user to approve a pairing; resolves true/false.
    this.onPair = onPair || (async () => false);
    this.onAppsChanged = onAppsChanged || (() => {});
    // Resolves the process behind a request: { pid, path } or null.
    // When absent (tests, unsupported platform), binding is not enforced.
    this.peer = peer || null;
    this.onLog = onLog;
    this.server = null;
    this.port = null;
    this.pairingInFlight = false;
    // name -> when the user last said no, so a refusal cannot be re-asked in a loop.
    this.recentlyDenied = new Map();
  }

  registeredApps() {
    return (this.settings().apps) || {};
  }

  saveApps(next) {
    // Assign rather than merge: a merge could never remove a revoked app.
    const api = this.store.get('api');
    api.apps = next;
    this.store.save();
    this.onAppsChanged(apps.summarize(next));
  }

  settings() {
    return this.store.get('api') || {};
  }

  // The pairing token. It does not grant access to anything by itself - it
  // only lets a local process ASK to be paired, which still needs the user.
  token() {
    const api = this.settings();
    if (!api.token) {
      const token = newToken();
      this.store.set({ api: { token } });
      return token;
    }
    return api.token;
  }

  // Rotating this stops new pairing requests; already-paired apps keep working
  // until they are revoked individually.
  regenerateToken() {
    const token = newToken();
    this.store.set({ api: { token } });
    this.writeTokenFile(token);
    return token;
  }

  setAppGrant(id, capability, state) {
    this.saveApps(apps.setGrant(this.registeredApps(), id, capability, state));
    return apps.summarize(this.registeredApps());
  }

  // Revoking kills the token and takes the app's panes down with it.
  revokeApp(id) {
    this.panes.clearOwner(id);
    this.saveApps(apps.revoke(this.registeredApps(), id));
    return apps.summarize(this.registeredApps());
  }

  listApps() {
    return apps.summarize(this.registeredApps());
  }

  // A well-known file so a local helper app can discover how to connect.
  writeTokenFile(token) {
    if (!this.userDataDir) return;
    const file = path.join(this.userDataDir, TOKEN_FILE);
    try {
      fs.writeFileSync(file, JSON.stringify({
        host: HOST,
        port: this.port,
        // Named for what it is: this only opens the pairing conversation.
        pairingToken: token || this.token(),
        // Older clients read "token"; keep it working as the pairing token.
        token: token || this.token()
      }, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      this.onLog(`could not write ${TOKEN_FILE}: ${err.message}`);
    }
  }

  removeTokenFile() {
    if (!this.userDataDir) return;
    try { fs.unlinkSync(path.join(this.userDataDir, TOKEN_FILE)); } catch { /* already gone */ }
  }

  start() {
    const api = this.settings();
    if (!api.enabled) return Promise.resolve(null);
    if (this.server) return Promise.resolve(this.port);

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', (err) => {
        this.onLog(`API server error: ${err.message}`);
        this.server = null;
        this.port = null;
        resolve(null);
      });
      this.server.listen(api.port || 0, HOST, () => {
        this.port = this.server.address().port;
        this.store.set({ api: { port: this.port } });
        this.writeTokenFile();
        this.onLog(`API listening on http://${HOST}:${this.port}`);
        resolve(this.port);
      });
    });
  }

  async stop() {
    this.removeTokenFile();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.port = null;
    await new Promise((resolve) => server.close(resolve));
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  send(res, status, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      // No browser page should be able to call this API from a web origin.
      'Access-Control-Allow-Origin': 'null',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(text);
  }

  // Pairing: a local process asks for an identity and the user decides.
  async handlePair(req, res) {
    if (!tokenMatches(this.token(), bearerFrom(req))) {
      this.send(res, 401, { error: 'pairing requires the pairing token from api-token.json' });
      return;
    }
    // Only one dialog at a time, so a burst of requests cannot stack prompts.
    if (this.pairingInFlight) { this.send(res, 429, { error: 'a pairing request is already open' }); return; }

    const body = await readBody(req);
    const name = apps.sanitizeAppName(body.name);
    const capabilities = apps.normalizeCapabilities(body.capabilities);
    if (!capabilities.length) {
      this.send(res, 400, { error: `capabilities must include at least one of: ${apps.CAPABILITIES.join(', ')}` });
      return;
    }
    const table = this.registeredApps();
    if (Object.keys(table).length >= apps.MAX_APPS) {
      this.send(res, 409, { error: `too many paired apps (limit ${apps.MAX_APPS})` });
      return;
    }

    // A refusal sticks for a while: without this, a program could re-ask the
    // instant the user clicks Deny and nag them into agreeing.
    const deniedAt = this.recentlyDenied.get(name) || 0;
    if (Date.now() - deniedAt < PAIR_DENY_COOLDOWN_MS) {
      this.send(res, 429, {
        error: 'this app was declined recently - try again later or approve it in Settings'
      });
      return;
    }

    // Identify the program asking BEFORE prompting, so the dialog can show the
    // real binary and the token can be bound to it. Fail closed: if Windows
    // cannot say who is calling, no identity is issued.
    let exePath = null;
    let binary = null;
    if (this.peer) {
      const identity = await this.peer.identify(req);
      exePath = identity && identity.path ? identity.path : null;
      if (!exePath) {
        this.send(res, 403, {
          error: 'could not identify the requesting program - pairing refused'
        });
        return;
      }
      // Record what the binary IS, not just where it lives: its signer when
      // validly signed, its hash otherwise. The dialog shows this and every
      // later request is checked against it.
      binary = this.peer.describeBinary ? await this.peer.describeBinary(exePath) : null;
    }

    this.pairingInFlight = true;
    let approved = false;
    try {
      approved = await this.onPair({ name, capabilities, exePath, binary });
    } finally {
      this.pairingInFlight = false;
    }
    if (!approved) {
      this.recentlyDenied.set(name, Date.now());
      this.send(res, 403, { error: 'the user declined this pairing request' });
      return;
    }
    this.recentlyDenied.delete(name);

    const app = apps.createApp({ name, capabilities, exePath, binary, now: Date.now() });
    this.saveApps({ ...table, [app.id]: app });
    this.onLog(`paired "${app.name}" (${capabilities.join(', ')}) -> ${exePath || 'unbound'}`);
    this.send(res, 200, {
      appId: app.id, name: app.name, token: app.token, capabilities: app.requested
    });
  }

  async handle(req, res) {
    try {
      // Reject cross-origin browser traffic outright: a page on the web must
      // never be able to drive the sidebar, even with a stolen token.
      if (req.headers.origin) {
        this.send(res, 403, { error: 'cross-origin requests are not allowed' });
        return;
      }

      const url = new URL(req.url, `http://${HOST}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'v1') { this.send(res, 404, { error: 'unknown endpoint' }); return; }
      const [, resource, id] = parts;
      const method = req.method.toUpperCase();

      // Pairing is the one route reachable without an app token.
      if (resource === 'pair' && (method === 'POST' || method === 'PUT')) {
        await this.handlePair(req, res);
        return;
      }

      // Everything else needs an app identity.
      const app = apps.findByToken(this.registeredApps(), bearerFrom(req));
      if (!app) {
        this.send(res, 401, { error: 'unknown or revoked app token - pair at POST /v1/pair' });
        return;
      }

      // The token alone is not enough: the request must come from the binary
      // the token was issued to. Resolution is cached per connection, so this
      // costs one lookup per socket, not per request.
      if (this.peer && app.exePath) {
        const identity = await this.peer.identify(req);
        const observed = identity && identity.path ? identity.path : null;
        if (!apps.matchesBinary(app, observed)) {
          this.onLog(`binary mismatch for "${app.name}": expected ${app.exePath}, saw ${observed || 'unknown'}`);
          this.send(res, 403, {
            error: `this token belongs to a different program`,
            expected: app.exePath,
            hint: 'pair again from the new binary if the program moved or was updated'
          });
          return;
        }
        // Same path - but is it still the same PROGRAM? Signed apps must
        // present the same signer; unsigned apps the same hash. Cached by
        // (mtime, size), so this costs nothing until the file changes.
        if (app.binary && this.peer.describeBinary) {
          const current = await this.peer.describeBinary(observed);
          const verdict = apps.matchesBinaryIdentity(app, current);
          if (verdict !== 'ok') {
            this.onLog(`binary identity ${verdict} for "${app.name}" at ${observed}`);
            this.send(res, 403, {
              error: app.binary.signed
                ? 'the program at this path is no longer signed by the publisher that paired'
                : 'the program at this path has changed since it paired',
              verdict,
              hint: 'pair again so the user can approve the new program'
            });
            return;
          }
        }
      }
      this.saveApps(apps.touch(this.registeredApps(), app.id, Date.now()));

      const require_ = (capability) => {
        if (apps.can(app, capability)) return true;
        this.send(res, 403, {
          error: `"${app.name}" does not have the "${capability}" capability`,
          capability,
          hint: 'the user can change this in Settings > Extensions'
        });
        return false;
      };

      if (resource === 'ping' && method === 'GET') {
        this.send(res, 200, {
          ok: true,
          app: 'BE-Aero Desktop',
          api: 1,
          you: { id: app.id, name: app.name, capabilities: app.requested.filter((c) => apps.can(app, c)) }
        });
        return;
      }

      if (resource === 'telemetry' && method === 'GET') {
        if (!require_('telemetry')) return;
        this.send(res, 200, await this.getTelemetry());
        return;
      }

      if (resource === 'panes') {
        if (!require_('panes')) return;
        // Every read and write below is scoped to this app's own panes.
        if (method === 'GET' && !id) { this.send(res, 200, { panes: this.panes.listFor(app.id) }); return; }
        if (method === 'GET') {
          const pane = this.panes.get(app.id, id);
          if (!pane) { this.send(res, 404, { error: 'no such pane' }); return; }
          this.send(res, 200, pane);
          return;
        }
        if ((method === 'PUT' || method === 'POST') && id) {
          const body = await readBody(req);
          const { pane, error } = this.panes.set(id, body, Date.now(), app);
          if (error) { this.send(res, 400, { error }); return; }
          this.send(res, 200, pane);
          return;
        }
        if (method === 'DELETE' && id) {
          this.send(res, 200, { deleted: this.panes.delete(app.id, id) });
          return;
        }
        if (method === 'DELETE') {
          this.send(res, 200, { cleared: this.panes.clearOwner(app.id) });
          return;
        }
      }

      this.send(res, 404, { error: 'unknown endpoint' });
    } catch (err) {
      this.send(res, err.status || 500, { error: err.message || 'server error' });
    }
  }
}

module.exports = { ApiServer, newToken, tokenMatches, bearerFrom, readBody, HOST };
