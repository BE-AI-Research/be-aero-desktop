// Tiny JSON settings store kept in the user's AppData folder.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  alwaysOnTop: false,
  dock: 'right',            // 'right' | 'left' | 'free'
  dockDisplay: null,        // display id to dock on (null = primary)
  freeFrom: 'right',        // edge the widgets start at when free mode is entered
  width: 340,
  // Widget geometry. free: {key: {x, y, w, h}} relative to the free canvas;
  // docked: {key: {h}}. Missing entries use the built-in defaults.
  layout: { free: {}, docked: {} },
  snapToGrid: false,
  theme: {
    preset: 'aero',
    custom: null            // {tint, tintAlpha, accent, border, radius, text, glow} overrides
  },
  clock: {
    style: 'analog',        // analog | classic | minimal | hybrid | digital | flip | rings
    digital: true,          // digital readout under analog dials
    showSeconds: true,
    showDate: true,
    smooth: false,          // sweeping second hand
    accent: ''              // '' = theme accent
  },
  telemetry: {
    style: 'rings',         // rings | arcs | bars | graph | compact
    metrics: { cpu: true, ram: true, disk: false, net: false, battery: false },
    showCores: false,
    showFooter: true,
    showValues: true,
    interval: 1500,
    history: 60,            // samples kept for graphs
    warnAt: 90,
    thickness: 8,
    drive: 'C:',
    colors: { cpu: '#38bdf8', ram: '#c084fc', disk: '#34d399', net: '#fbbf24', battery: '#a3e635' }
  },
  opacity: 1,
  launchAtStartup: false,
  locked: false,            // prevents dragging
  use24h: false,
  weather: {
    city: 'Seattle',
    latitude: 47.6062,
    longitude: -122.3321,
    label: 'SEATTLE, WA',
    unit: 'fahrenheit',     // 'fahrenheit' | 'celsius'
    forecast: true          // 7-day strip (only drawn when the widget is tall)
  },
  search: {
    hotkey: 'Alt+Space',    // falls back to Ctrl+Space if taken
    webEngine: 'bing',      // bing | google | duckduckgo | brave | a URL with {q}
    extraRoots: [],         // additional folders to index
    launchCounts: {}        // path -> times opened (boosts ranking)
  },
  // Local HTTP API other applications use to push widget panes. Off until the
  // user turns it on: it is a listening socket, so it should be opt-in.
  api: {
    enabled: false,
    port: 8787,       // 0 picks any free port
    token: null,      // PAIRING token - only lets a local app ask to connect
    apps: {}          // appId -> { id, name, token, requested, grants, ... }
  },
  // Third-party widget plugins loaded from the plugins folder.
  plugins: {
    enabled: {},      // id -> bool (missing means enabled)
    settings: {},     // id -> { key: value } from the manifest's settings schema
    grants: {},       // id -> { permission: 'granted'|'denied' } - the user's answers
    usage: {}         // id -> { permission: timestamp } - when it last used each one
  },
  // User-created web widgets: a page embedded as its own sidebar pane.
  // [{ id, name, url, height }] - url must be http(s).
  webWidgets: [],
  // Release notifications: check GitHub for newer published builds.
  updates: {
    auto: true,     // Windows installed build: download + install by itself
    notify: true,   // fallback builds (portable / Linux): notification only
    notifiedVersion: null   // last version the user was told about (no nagging)
  },
  // Application dock: apps pinned to it. [{ exe, name }]
  dock: {
    pinned: [],
    align: 'center',  // 'left' | 'center' | 'right'
    hotkey: 'Control+Alt+D'   // summons the dock above everything; falls back if taken
  },
  // Certificates the user explicitly accepted on a web widget's warning page:
  // "host:port" -> "sha256/..." fingerprint. Exact-match only.
  certTrust: {},
  widgets: {
    search: true,
    clock: true,
    weather: true,
    telemetry: true,
    tasks: true,
    scratchpad: true
  },
  scratchpad: ''
};

function merge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = merge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = merge(DEFAULTS, {});
    try {
      if (fs.existsSync(this.file)) {
        this.data = merge(DEFAULTS, JSON.parse(fs.readFileSync(this.file, 'utf8')));
      }
    } catch (err) {
      console.error('Failed to read settings, using defaults:', err);
    }
    this._timer = null;
  }

  get(key) {
    return key ? this.data[key] : this.data;
  }

  // Replace the whole settings object (import): defaults fill anything the
  // file lacks, so an older export still loads cleanly.
  replaceAll(obj) {
    this.data = merge(DEFAULTS, obj || {});
    this.save();
    return this.data;
  }

  set(patch) {
    this.data = merge(this.data, patch);
    this.save();
    return this.data;
  }

  // Debounced write so frequent updates (scratchpad typing, window moves) are cheap.
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to write settings:', err);
    }
  }
}

module.exports = { Store, DEFAULTS };
