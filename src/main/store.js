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
  // Application dock widget. (The layout mode above is also called `dock`;
  // this object used to share that key and silently broke both.)
  // Power button at the far end of the dock (lock / switch user / log off / sleep / restart / shut down).
  powerMenu: { enabled: true, side: 'right' },
  appDock: {
    pinned: [],       // [{ exe, name }]
    align: 'center',  // 'left' | 'center' | 'right'
    hotkey: 'Control+Alt+D',  // summons the dock above everything; falls back if taken
    uacShield: true,          // Windows: UAC shield tile (prompt status + level menu)
    trash: true               // Recycle Bin / Trash tile
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
    media: true,
    scratchpad: true,
    files: true,             // file browser: on, but parked in the dock by default (widgetMinimized)
    ai: true
  },
  files: {
    poolDir: '',             // the File Pool folder; '' = ~/BE-Aero Pool
    showHidden: false,
    view: 'list',            // list | grid
    last: ''                 // folder the browser was last showing
  },
  scratchpad: '',
  // Built-in widgets parked in the dock (id -> true). Web widgets and the
  // AI chat carry their own minimized flags.
  widgetMinimized: { files: true },   // the file browser starts parked in the dock
  // Spell checking for the sidebar's own inputs and for web widgets.
  spellcheck: {
    enabled: true,
    languages: []        // empty = the OS / app locale
  },
  // AI assistant: provider + model, key encrypted at rest (safeStorage),
  // what the model may do without asking, and the user's persona text.
  ai: {
    enabled: true,
    provider: 'anthropic',   // anthropic | openai | ollama | lmstudio | custom
    baseUrl: '',
    apiKey: '',
    model: '',
    permission: 'ask',       // ask | allow | deny  (reads are always allowed)
    systemPrompt: '',
    maxSteps: 12,
    zoom: 1,             // chat text scale (0.8 - 1.6)
    contextTokens: 0,    // request budget; 0 = default for the provider (local servers 16k), capped by the live window
    keepAlive: '30m',    // (older setting, replaced by unloadAfter)
    unloadAfter: '1m',   // Ollama: unload the model this long after the last reply ('keep' = server default)
    evictBlocking: 'ask', // another model holding the server while ours waits: ask | auto | never
    browser: '',          // '' = the default browser; or chrome | msedge | brave | chromium | firefox
    folder: '',           // the assistant's own folder ('' = ~/BE-Aero AI); uploads are copied into Uploads/
    busOperateDesktop: false,   // AI bus: may other devices' assistants use desktop-driving tools here?
    followSharedModel: true,    // shared local server: use a model my other devices already have loaded instead of swapping
    browserMode: 'main',  // browser_open: main = the user's own browser/profile (interaction uses the assistant profile) | assistant = always the assistant profile
    toolCalls: 'auto',   // auto (by model family, with fallback) | native (JSON tools field) | compat (text tool calls)    // local servers (Ollama): keep the model loaded this long after a reply; '0' = don't
    taskMaxRuntimeMin: 30,
    taskModel: '',       // model for scheduled tasks; '' = the chat model (a task can override)
    taskMaxSteps: 10,    // tool steps per task run; then a final answer from what was found
    taskProvider: '',    // provider for scheduled tasks; '' = the chat provider
    taskBaseUrl: '',
    taskApiKey: '',      // encrypted like apiKey
    compactWithModel: true,
    voice: {
      engine: 'auto',        // auto (Whisper when installed) | whisper | system
      whisperModel: 'base.en',
      micId: '', speakerId: '',
      continuous: false,     // false = the mic turns itself off after one transcribed phrase
      hotkey: 'Control+Alt+M',  // global toggle for voice input; falls back if taken
      autoSend: false,       // send the dictated message after autoSendDelay seconds of quiet
      autoSendDelay: 3,
      speak: false, voiceName: '', rate: 1, volume: 100, pitch: 0,
      ttsEngine: 'system',   // system (Windows voices / espeak) | piper (neural, local)
      piperVoice: 'en_US-lessac-medium', piperSpeaker: 0,
      piperNoise: 0.667, piperNoiseW: 0.8, piperSentenceSilence: 0.2,
      interrupt: true        // stop speaking when the microphone starts
    }
  },
  devices: {
    // What syncs to paired devices that allow "Synced state" (state-sync.js).
    // Only the theme by default; the rest is turned on in Settings > Devices.
    // Web widgets are shared one at a time (right-click a widget).
    sync: { theme: true, notes: false, pins: false, conversations: false, tasks: false, clipboard: false },
    syncDefaults: 2,
    newConversationsLocal: false,   // new AI conversations start Local instead of Synced
    enabled: false,          // device connections (the mesh): off until turned on in Settings > Devices
    name: '',                // this device's name for others ('' = the computer name)
    port: 41801
  },
  notifications: {
    toast: true,             // also show OS toasts for web-widget / AI notifications
    captureSystem: true      // Linux: mirror every app's desktop notifications into the center
  }
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
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        // Older builds stored the app-dock object under `dock`, colliding
        // with the layout mode of the same name. Move it to appDock.
        if (saved && saved.dock && typeof saved.dock === 'object') {
          saved.appDock = merge(saved.appDock || {}, saved.dock);
          saved.dock = 'right';
        }
        // 1.2.5 dev builds synced everything by default: back to the theme only.
        if (saved && saved.devices && typeof saved.devices === 'object' && saved.devices.syncDefaults !== 2) {
          delete saved.devices.sync;
          saved.devices.syncDefaults = 2;
        }
        this.data = merge(DEFAULTS, saved);
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
