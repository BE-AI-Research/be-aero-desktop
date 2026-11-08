// Plugin permissions.
//
// A manifest only ever *requests* a capability. Nothing is granted until the
// user says so, every grant is remembered, and any of them can be revoked at
// any time. Enforcement is against what the user granted, never against what
// the manifest claimed - so a plugin that quietly adds a permission to its
// manifest in an update gains nothing until the user agrees.
//
// Three states per (plugin, permission):
//   undecided  never asked - the next use prompts
//   granted    allowed until revoked
//   denied     refused; calls fail without re-prompting

// Every capability, with the wording the consent prompt and Settings show.
// Each one maps to a real API; there are no decorative permissions.
const PERMISSION_INFO = Object.freeze({
  telemetry: {
    title: 'System telemetry',
    detail: 'Read live CPU, memory, disk and network usage.',
    risk: 'low'
  },
  storage: {
    title: 'Private storage',
    detail: 'Save and read its own data. Other plugins cannot see it.',
    risk: 'low'
  },
  theme: {
    title: 'Theme colours',
    detail: 'Read the colours of your current theme so it can match.',
    risk: 'low'
  },
  'open-external': {
    title: 'Open links',
    detail: 'Open web links in your browser. Only http and https addresses.',
    risk: 'medium'
  },
  notifications: {
    title: 'Notifications',
    detail: 'Show Windows desktop notifications.',
    risk: 'medium'
  }
});

const PERMISSIONS = Object.freeze(Object.keys(PERMISSION_INFO));
const STATES = Object.freeze(['undecided', 'granted', 'denied']);

function isPermission(name) {
  return Object.prototype.hasOwnProperty.call(PERMISSION_INFO, name);
}

function describe(name) {
  return PERMISSION_INFO[name] || { title: name, detail: '', risk: 'unknown' };
}

// The stored state for one capability. Anything unrecognised reads as
// undecided rather than being trusted.
function stateOf(grants, pluginId, permission) {
  const forPlugin = (grants || {})[pluginId] || {};
  const value = forPlugin[permission];
  return STATES.includes(value) ? value : 'undecided';
}

// The question that actually gates a call: did the user allow this, and did the
// plugin declare it in the first place?
function isGranted(grants, plugin, permission) {
  if (!plugin || !isPermission(permission)) return false;
  if (!Array.isArray(plugin.permissions) || !plugin.permissions.includes(permission)) return false;
  return stateOf(grants, plugin.id, permission) === 'granted';
}

// Returns a new grants object; 'undecided' removes the entry so the next use
// asks again.
function setGrant(grants, pluginId, permission, state) {
  if (!isPermission(permission) || !STATES.includes(state)) return grants || {};
  const next = { ...(grants || {}) };
  const forPlugin = { ...(next[pluginId] || {}) };
  if (state === 'undecided') delete forPlugin[permission];
  else forPlugin[permission] = state;
  if (Object.keys(forPlugin).length) next[pluginId] = forPlugin;
  else delete next[pluginId];
  return next;
}

function resetPlugin(grants, pluginId) {
  const next = { ...(grants || {}) };
  delete next[pluginId];
  return next;
}

// Drop grants for plugins that are gone, and for capabilities a plugin no
// longer asks for, so stale consent cannot be reused if an id is recycled.
function pruneGrants(grants, plugins) {
  const byId = new Map((plugins || []).map((p) => [p.id, p]));
  const next = {};
  for (const [id, perms] of Object.entries(grants || {})) {
    const plugin = byId.get(id);
    if (!plugin) continue;
    const kept = {};
    for (const [perm, state] of Object.entries(perms || {})) {
      if (!isPermission(perm)) continue;
      if (!plugin.permissions.includes(perm)) continue;
      if (!STATES.includes(state)) continue;
      kept[perm] = state;
    }
    if (Object.keys(kept).length) next[id] = kept;
  }
  return next;
}

// Per-plugin view for the Settings panel: what it asked for, what the user
// decided, and when it last actually used each capability.
function summarize(plugin, grants, usage) {
  if (!plugin) return [];
  const used = (usage || {})[plugin.id] || {};
  return (plugin.permissions || [])
    .filter(isPermission)
    .map((name) => ({
      name,
      ...describe(name),
      state: stateOf(grants, plugin.id, name),
      lastUsed: used[name] || null
    }));
}

// Does this plugin still have an unanswered request? Drives the "needs review"
// badge in Settings.
function hasUndecided(plugin, grants) {
  return summarize(plugin, grants).some((p) => p.state === 'undecided');
}

module.exports = {
  PERMISSIONS, PERMISSION_INFO, STATES,
  isPermission, describe, stateOf, isGranted, setGrant,
  resetPlugin, pruneGrants, summarize, hasUndecided
};
