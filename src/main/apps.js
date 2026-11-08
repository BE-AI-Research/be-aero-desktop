// Registered client applications for the local API.
//
// A plugin is identifiable because it is a folder with a manifest. A program
// talking to a socket is not, so apps earn an identity by pairing: they ask
// once, the user approves, and they get their own token with their own
// capabilities. From then on every request is attributable to one app, which
// can be inspected and revoked on its own without disturbing the others.
const crypto = require('crypto');

// What an app may ask for at pairing time. Like plugin permissions, asking is
// not getting - the user approves the set, and can block any of them later.
const APP_CAPABILITIES = Object.freeze({
  panes: {
    title: 'Show widget panes',
    detail: 'Add and update its own panes in your sidebar. It cannot see or change other apps\' panes.',
    risk: 'low'
  },
  telemetry: {
    title: 'Read system telemetry',
    detail: 'Read live CPU, memory, disk and network usage.',
    risk: 'medium'
  }
});

const CAPABILITIES = Object.freeze(Object.keys(APP_CAPABILITIES));
const MAX_APPS = 32;
const NAME_MAX = 48;

function isCapability(name) {
  return Object.prototype.hasOwnProperty.call(APP_CAPABILITIES, name);
}

function describeCapability(name) {
  return APP_CAPABILITIES[name] || { title: name, detail: '', risk: 'unknown' };
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// An app picks its own display name and that name is shown in a consent
// dialog, so it must not be able to dress itself up as the host. Strip control
// characters and bidi overrides (which can visually reverse rendered text),
// collapse whitespace so it cannot pad itself off the edge, and cap the length.
const UNSAFE_NAME_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

function sanitizeAppName(name) {
  // Only a real string is a name; anything else would stringify to junk
  // like "[object Object]" and be shown to the user as if it were chosen.
  const cleaned = (typeof name === 'string' ? name : '')
    .replace(UNSAFE_NAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  return cleaned || 'Unnamed app';
}

// Only capabilities we recognise, deduplicated, in a stable order.
function normalizeCapabilities(requested) {
  if (!Array.isArray(requested)) return [];
  const set = new Set(requested.filter(isCapability));
  return CAPABILITIES.filter((c) => set.has(c));
}

function appId() {
  return crypto.randomBytes(8).toString('hex');
}

// Build a paired app record. Capabilities the user approved start granted;
// anything the app did not ask for simply is not there, which reads as denied.
// exePath is the executable observed on the pairing connection - the identity
// this token is bound to from now on.
function createApp({ name, capabilities, exePath, binary, now }) {
  const caps = normalizeCapabilities(capabilities);
  const grants = {};
  for (const c of caps) grants[c] = 'granted';
  return {
    id: appId(),
    name: sanitizeAppName(name),
    token: newToken(),
    exePath: typeof exePath === 'string' && exePath ? exePath : null,
    // The binary identity observed at pairing: a validly-signed program is
    // bound to its SIGNER (updates keep working), an unsigned one to its
    // SHA-256 (any change to the file requires re-pairing).
    binary: binary && typeof binary === 'object'
      ? (binary.signed
        ? { signed: true, thumbprint: String(binary.thumbprint || ''), subject: String(binary.subject || '').slice(0, 200) }
        : { signed: false, sha256: String(binary.sha256 || '').toLowerCase() })
      : null,
    requested: caps,
    grants,
    createdAt: now,
    lastSeenAt: now
  };
}

// Does the process presenting this token run the binary the token was issued
// to? Apps paired before binding existed (exePath null) are let through, so an
// upgrade does not break them; re-pairing upgrades them to a bound identity.
function matchesBinary(app, observedPath) {
  if (!app) return false;
  if (!app.exePath) return true;
  if (typeof observedPath !== 'string' || !observedPath) return false;
  return app.exePath.toLowerCase() === observedPath.toLowerCase();
}

// Beyond the path: does the binary CONTENT still match what was approved?
// - signed pin: the current signature must be valid and from the same
//   certificate (an in-place update by the same publisher keeps working;
//   a replaced or unsigned binary at the same path does not).
// - unsigned pin: the SHA-256 must be identical.
// - legacy app (no recorded identity): allowed, until it re-pairs.
// Returns 'ok' | 'changed' | 'unverifiable'.
function matchesBinaryIdentity(app, observed) {
  if (!app || !app.binary) return 'ok';
  if (!observed || typeof observed !== 'object') return 'unverifiable';
  if (app.binary.signed) {
    if (!observed.signed) return 'changed';
    return observed.thumbprint === app.binary.thumbprint ? 'ok' : 'changed';
  }
  if (observed.signed) return 'changed';   // unsigned pin, now signed: different file
  if (!observed.sha256) return 'unverifiable';
  return observed.sha256.toLowerCase() === app.binary.sha256 ? 'ok' : 'changed';
}

// Constant-time token comparison, and constant work across the whole table so
// a wrong token leaks neither validity nor which app it nearly matched.
function findByToken(apps, token) {
  if (typeof token !== 'string' || !token) return null;
  const given = Buffer.from(token);
  let found = null;
  for (const app of Object.values(apps || {})) {
    if (typeof app.token !== 'string' || app.token.length !== given.length) continue;
    if (crypto.timingSafeEqual(Buffer.from(app.token), given)) found = app;
  }
  return found;
}

function stateOf(app, capability) {
  if (!app || !isCapability(capability)) return 'denied';
  return app.grants && app.grants[capability] === 'granted' ? 'granted' : 'denied';
}

// The gate: granted by the user AND asked for at pairing time, so an app
// cannot gain a capability it never disclosed.
function can(app, capability) {
  if (!app || !isCapability(capability)) return false;
  if (!Array.isArray(app.requested) || !app.requested.includes(capability)) return false;
  return stateOf(app, capability) === 'granted';
}

function setGrant(apps, id, capability, state) {
  const next = { ...(apps || {}) };
  const app = next[id];
  if (!app || !isCapability(capability) || !['granted', 'denied'].includes(state)) return apps || {};
  next[id] = { ...app, grants: { ...app.grants, [capability]: state } };
  return next;
}

function revoke(apps, id) {
  const next = { ...(apps || {}) };
  delete next[id];
  return next;
}

function touch(apps, id, now) {
  const app = (apps || {})[id];
  if (!app) return apps || {};
  return { ...apps, [id]: { ...app, lastSeenAt: now } };
}

// What Settings shows. The token is never included.
function summarize(apps) {
  return Object.values(apps || {})
    .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
    .map((app) => ({
      id: app.id,
      name: app.name,
      exePath: app.exePath || null,
      publisher: app.binary ? (app.binary.signed ? app.binary.subject : 'unsigned (hash-pinned)') : null,
      createdAt: app.createdAt,
      lastSeenAt: app.lastSeenAt,
      capabilities: (app.requested || []).map((name) => ({
        name,
        ...describeCapability(name),
        state: stateOf(app, name)
      }))
    }));
}

module.exports = {
  APP_CAPABILITIES, CAPABILITIES, MAX_APPS,
  createApp, findByToken, can, stateOf, setGrant, revoke, touch, summarize,
  matchesBinary, matchesBinaryIdentity,
  sanitizeAppName, normalizeCapabilities, isCapability, describeCapability, newToken
};
