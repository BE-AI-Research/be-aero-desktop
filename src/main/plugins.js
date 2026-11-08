// Third-party widget plugins.
//
// A plugin is a folder containing an aero-widget.json manifest and an HTML
// entry point. The entry is rendered inside a sandboxed iframe in its own
// widget pane, so a plugin can never reach the host page, the file system or
// Electron directly - everything it is allowed to do goes through the SDK
// bridge and is gated by the permissions it declares in its manifest.
const fs = require('fs/promises');
const path = require('path');

// The capability list lives in permissions.js, which also owns the consent
// model. A manifest naming anything else has it dropped - and declaring one
// here still grants nothing until the user allows it.
const { PERMISSIONS } = require('./permissions');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// A plugin's entry must stay inside its own folder; "../" or an absolute path
// would let a manifest point the iframe at anything on disk.
function safeEntry(entry) {
  if (typeof entry !== 'string' || !entry.trim()) return null;
  const cleaned = entry.trim().replace(/\\/g, '/');
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;
  if (cleaned.split('/').some((seg) => seg === '..')) return null;
  if (!/\.html?$/i.test(cleaned)) return null;
  return cleaned;
}

// Turn raw manifest JSON into a trusted, fully-populated descriptor, or return
// { error } explaining why it was rejected.
function validateManifest(raw, { dir = '' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'manifest must be a JSON object' };
  }
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
  if (!ID_RE.test(id)) {
    return { error: 'id must be 2-40 chars of a-z, 0-9 and dashes, starting alphanumeric' };
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
  const entry = safeEntry(raw.entry);
  if (!entry) return { error: 'entry must be a relative .html path inside the plugin folder' };

  const permissions = Array.isArray(raw.permissions)
    ? [...new Set(raw.permissions.filter((p) => PERMISSIONS.includes(p)))]
    : [];

  const settings = Array.isArray(raw.settings)
    ? raw.settings
      .filter((s) => s && typeof s.key === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(s.key))
      .slice(0, 24)
      .map((s) => ({
        key: s.key,
        label: typeof s.label === 'string' ? s.label.slice(0, 80) : s.key,
        type: ['text', 'number', 'checkbox', 'color', 'select'].includes(s.type) ? s.type : 'text',
        default: s.default === undefined ? '' : s.default,
        options: Array.isArray(s.options) ? s.options.slice(0, 32).map(String) : undefined
      }))
    : [];

  return {
    plugin: {
      id,
      name: name.slice(0, 60),
      version: typeof raw.version === 'string' ? raw.version.slice(0, 20) : '0.0.0',
      description: typeof raw.description === 'string' ? raw.description.slice(0, 200) : '',
      author: typeof raw.author === 'string' ? raw.author.slice(0, 80) : '',
      entry,
      dir,
      height: clampInt(raw.height, 80, 1200, 220),
      minHeight: clampInt(raw.minHeight, 60, 1200, 120),
      minWidth: clampInt(raw.minWidth, 120, 2000, 200),
      permissions,
      settings
    }
  };
}

function hasPermission(plugin, permission) {
  return !!plugin && Array.isArray(plugin.permissions) && plugin.permissions.includes(permission);
}

// Read every plugin folder under root. A bad plugin is reported, never fatal:
// one broken manifest must not stop the others from loading.
async function loadPlugins(root) {
  let dirents;
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { plugins: [], errors: [] };  // no plugins folder yet
  }

  const plugins = [];
  const errors = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    const manifestPath = path.join(dir, 'aero-widget.json');
    let text;
    try {
      const stat = await fs.stat(manifestPath);
      if (stat.size > MAX_MANIFEST_BYTES) { errors.push({ dir: d.name, error: 'manifest too large' }); continue; }
      text = await fs.readFile(manifestPath, 'utf8');
    } catch {
      continue; // folder without a manifest: not a plugin
    }

    let raw;
    try { raw = JSON.parse(text); } catch (err) {
      errors.push({ dir: d.name, error: `invalid JSON: ${err.message}` });
      continue;
    }

    const { plugin, error } = validateManifest(raw, { dir });
    if (error) { errors.push({ dir: d.name, error }); continue; }
    if (plugins.some((p) => p.id === plugin.id)) {
      errors.push({ dir: d.name, error: `duplicate plugin id "${plugin.id}"` });
      continue;
    }
    try {
      await fs.access(path.join(dir, plugin.entry));
    } catch {
      errors.push({ dir: d.name, error: `entry file "${plugin.entry}" not found` });
      continue;
    }
    plugins.push(plugin);
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { plugins, errors };
}

module.exports = { loadPlugins, validateManifest, hasPermission, safeEntry, PERMISSIONS };
