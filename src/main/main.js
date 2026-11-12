// BE-Aero Desktop - Electron main process.
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, globalShortcut, protocol
} = require('electron');
const { dialog, Notification } = require('electron');
const fsp = require('fs/promises');
const path = require('path');
const { Store } = require('./store');
const { PRESETS, themeVars } = require('./themes');
const telemetry = require('./telemetry');
const { Spotlight } = require('./spotlight');
const { loadPlugins } = require('./plugins');
const perms = require('./permissions');
const { PaneRegistry } = require('./panes');
const { ApiServer } = require('./api-server');
const clientApps = require('./apps');
const { PeerResolver } = require('./peer');
const { hostKey, sameSite } = require('../shared/weburl');
const { unionRect, toRelative } = require('../shared/displays');
const { TaskWindows } = require('./tasks');
const { togglePinned, isPinned, appNameFromExe } = require('../shared/dock');
const updater = require('./updater');
const { session, Notification: SysNotification } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const ICON_PATH = path.join(ROOT, 'build', 'icon.png');
const TOGGLE_SHORTCUT = 'Control+Alt+W';

let win = null;
const filesWindows = new Set();   // file browser windows (files.html)
let tray = null;
let store = null;
let telemetryTimer = null;
let isQuitting = false;
let spotlight = null;
let pluginList = [];
let pluginErrors = [];
let panes = null;
let apiServer = null;
let peerResolver = null;
let linuxTasks = null;
let mediaCtl = null;
let voice = null;
let whisper = null;
let piper = null;
let aiService = null;
let notifyCenter = null;
let deviceService = null;
// BE-Aero Relay Server client (relay-client.js): messages for my devices
// that are offline go through a relay, sealed end to end.
let relayClient = null;
// Relay storage (relay-drive.js): Shared storage + the File Pool copy, encrypted here.
let relayDrive = null;
// My devices (not relays) I can send to now: online, or reachable through a relay.
function sendTargets() {
  const mesh = deviceService && deviceService.mesh;
  if (!mesh) return [];
  return [...mesh.peers.values()].filter((p) => p.role !== 'relay')
    .map((p) => ({ id: p.id, p, online: mesh.conns.has(p.id), relayed: !mesh.conns.has(p.id) && !!(relayClient && relayClient.reachable(p.id)) }))
    .filter((x) => x.online || x.relayed);
}
let linuxNotify = null;
let dockHotkey = null;       // the accelerator actually registered for the dock
let dockSummoned = false;    // sidebar lifted above everything by the dock hotkey
let lastUpdateStatus = { state: 'idle' };
let updateTimer = null;
let taskWindows = null;
let uacMonitor = null;
let trash = null;
const taskIconCache = new Map();
let PLUGINS_DIR = null;

app.setAppUserModelId('com.beaero.desktop');

const OZONE_X11 = process.argv.some((a) => a.startsWith('--ozone-platform'));
let RELAUNCHING = false;
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  // Wayland gives apps no say over window position, and every X11 facility
  // this desktop layer uses (dock window type, input shapes) is a silent
  // no-op there. Chromium picks its Ozone platform BEFORE this script runs,
  // so appendSwitch cannot force X11 - the flag must be on the real command
  // line. The installer puts it in the launcher and CLI wrapper; for every
  // other way of starting the binary, relaunch ourselves once with it.
  if (!OZONE_X11
      && !process.argv.includes('--doctor')
      && (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY)) {
    RELAUNCHING = true;
    app.relaunch({ args: process.argv.slice(1).concat(['--ozone-platform=x11']) });
    app.exit(0);
  }
}

// Plugin pages are served over their own scheme rather than file://. A
// sandboxed file:// frame gets an opaque origin and is then not allowed to
// load its own scripts; a standard scheme behaves like a normal web origin, so
// the SDK and any assets load while the frame stays sandboxed.
protocol.registerSchemesAsPrivileged([{
  scheme: 'aero-plugin',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}, {
  // Assistant-made visuals (charts, tables, dashboards); see ai/visuals.js.
  scheme: 'aero-visual',
  privileges: { standard: true, secure: true }
}, {
  // Assistant-made desktop widgets; see ai/widgets.js.
  scheme: 'aero-widget',
  privileges: { standard: true, secure: true }
}]);

// Only one sidebar at a time: a second launch just shows the existing one.
// `be-aero-desktop --doctor` prints platform diagnostics and exits - the
// first thing to ask for when a Linux desktop misbehaves. It must run even
// while the app itself is running, so it skips the single-instance lock.
// `--user-data-dir=<path>` keeps a second copy (a dev instance beside the
// installed app) on its own settings, conversations and single-instance lock.
const USER_DATA_ARG = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (USER_DATA_ARG) app.setPath('userData', require('path').resolve(USER_DATA_ARG.slice('--user-data-dir='.length)));

const DOCTOR = process.argv.includes('--doctor');
if (DOCTOR) {
  app.whenReady().then(() => {
    const probe = new BrowserWindow({ show: false, frame: false, transparent: true });
    const report = {
      app: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      sessionType: process.env.XDG_SESSION_TYPE || null,
      waylandDisplay: process.env.WAYLAND_DISPLAY || null,
      desktop: process.env.XDG_CURRENT_DESKTOP || null,
      ozonePlatform: OZONE_X11 ? 'x11 (forced via command line)'
        : (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY)
          ? 'WAYLAND (native - positioning/input shaping unavailable; launch with --ozone-platform=x11)'
          : 'x11 (native session)',
      setShapeAvailable: typeof probe.setShape === 'function',
      displays: screen.getAllDisplays().map((d) => ({
        id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor
      }))
    };
    probe.destroy();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    app.exit(0);
  });
}

// A copy whose files were replaced underneath it (reinstall over a running
// app) keeps running headless and keeps the single-instance lock, so every
// later launch would quit silently. Linux marks such a process plainly:
// /proc/<pid>/exe ends in "(deleted)". Clear those before taking the lock.
function clearStaleLinuxInstances() {
  if (process.platform !== 'linux') return;
  const fs = require('fs');
  let killed = 0;
  try {
    for (const n of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
      let exe;
      try { exe = fs.readlinkSync(`/proc/${n}/exe`); } catch { continue; }
      if (/be-aero-desktop[^/]*\s\(deleted\)$/.test(exe)) {
        try { process.kill(Number(n), 'SIGTERM'); killed++; } catch { /* not ours */ }
      }
    }
  } catch { /* no /proc */ }
  if (killed) {
    console.log(`[linux] stopped ${killed} stale instance(s) left over from a reinstall`);
    // Give the lock a moment to be released; a copy too wedged to honour
    // SIGTERM gets SIGKILL, then the same grace again.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    let forced = 0;
    for (const n of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
      let exe;
      try { exe = fs.readlinkSync(`/proc/${n}/exe`); } catch { continue; }
      if (/be-aero-desktop[^/]*\s\(deleted\)$/.test(exe)) {
        try { process.kill(Number(n), 'SIGKILL'); forced++; } catch { /* gone */ }
      }
    }
    if (forced) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  }
}

// The relaunching parent must never take the lock its child is about to need.
if (RELAUNCHING) {
  // exiting
} else if (!DOCTOR && (clearStaleLinuxInstances(), !app.requestSingleInstanceLock())) {
  // Say so: a silent exit here reads as "the app does not launch". If the
  // other copy is a stale headless one (files replaced underneath it), this
  // tells the user what to stop.
  process.stdout.write('BE-Aero Desktop is already running; showing the existing instance. '
    + 'If nothing appears, stop the stale copy: pkill -f be-aero-desktop\n');
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function loadIcon() {
  const img = nativeImage.createFromPath(ICON_PATH);
  return img.isEmpty() ? undefined : img;
}

// Every display's work area as plain {x, y, w, h} rects (DIP space).
function workAreaRects() {
  return screen.getAllDisplays().map((d) => ({
    x: d.workArea.x, y: d.workArea.y, w: d.workArea.width, h: d.workArea.height
  }));
}

// The same work areas in PHYSICAL pixels. This matters the moment monitors
// run different DPI scales: a window spanning displays gets exactly ONE scale
// factor, so a union computed from mixed per-monitor DIP rects maps to the
// wrong physical area (here: 100% primary + 150% secondary left the window
// 227 physical px short of the secondary's bottom edge, and every widget
// placed there landed offset). Physical pixels are the one coordinate space
// the OS itself uses for window placement.
function physicalWorkAreas() {
  // dipToScreenPoint is Windows-only; elsewhere DIP space is what setBounds takes directly.
  return screen.getAllDisplays().map((d) => {
    const wa = d.workArea;
    // Top-left converted as a point (it lies on its own display); the size is
    // DIP x scale. Converting the bottom-right corner as a point is wrong at
    // display boundaries - the API picks whichever display CONTAINS the
    // point, which can be the neighbour with a different scale.
    const tl = screen.dipToScreenPoint({ x: wa.x, y: wa.y });
    return {
      x: tl.x, y: tl.y,
      w: Math.round(wa.width * d.scaleFactor),
      h: Math.round(wa.height * d.scaleFactor)
    };
  });
}

const toWH = (r) => ({ x: r.x, y: r.y, width: r.w, height: r.h });

// Physical union -> the DIP rect to give setBounds, expressed at the scale the
// spanning window itself will use. Falls back to plain DIP math if the
// Windows-only conversion APIs are unavailable.
function freeSpanBounds() {
  if (process.platform !== 'win32') {
    const u = unionRect(workAreaRects());
    return { x: u.x, y: u.y, width: u.w, height: u.h };
  }
  try {
    const phys = unionRect(physicalWorkAreas());
    const dip = screen.screenToDipRect(win, toWH(phys));
    return { x: dip.x, y: dip.y, width: dip.width, height: dip.height };
  } catch {
    const u = unionRect(workAreaRects());
    return { x: u.x, y: u.y, width: u.w, height: u.h };
  }
}

// The display the docked sidebar lives on: the user's choice when it is still
// attached, the primary otherwise (unplugging a monitor must never leave the
// sidebar stranded off-screen).
function dockDisplay() {
  const id = store.get('dockDisplay');
  return screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay();
}

// Work out where the window should live based on the dock setting.
// Docked: a strip on the edge of the chosen display. Free: a transparent,
// click-through canvas spanning EVERY display's work area, so widgets can be
// dragged onto any monitor; the renderer keeps them on real screens.
function computeBounds() {
  const s = store.get();
  if (s.dock === 'free') {
    return freeSpanBounds();
  }
  const wa = { ...dockDisplay().workArea };
  // GNOME on Wayland draws its top bar as shell chrome that XWayland's work
  // area knows nothing about (workArea === bounds); inset the strip so the
  // toolbar is not buried underneath it.
  if (process.platform === 'linux'
      && /gnome/i.test(process.env.XDG_CURRENT_DESKTOP || '')
      && wa.y === dockDisplay().bounds.y && wa.height === dockDisplay().bounds.height) {
    wa.y += 36; wa.height -= 36;
  }
  const width = Math.max(300, Math.min(480, s.width || 340));
  const x = s.dock === 'left' ? wa.x : wa.x + wa.width - width;
  return { x, y: wa.y, width, height: wa.height };
}

// For the renderer: display work areas relative to the window's origin, in
// the WINDOW's coordinate space. Each physical rect is converted through the
// same single scale the spanning window renders at, so what the renderer
// calls (x, y) is exactly where the OS puts those pixels.
function displayGeometry() {
  const bounds = computeBounds();
  if (process.platform !== 'win32') {
    const rects = toRelative(workAreaRects(), { x: bounds.x, y: bounds.y });
    const home = dockDisplay().workArea;
    return {
      displays: rects,
      homeRect: { x: home.x - bounds.x, y: home.y - bounds.y, w: home.width, h: home.height }
    };
  }
  try {
    const physList = physicalWorkAreas();
    const physHome = physList[screen.getAllDisplays().findIndex((d) => d.id === dockDisplay().id)]
      || physList[0];
    const physUnion = unionRect(physList);
    const winDip = screen.screenToDipRect(win, toWH(physUnion));
    const rel = (phys) => {
      const r = screen.screenToDipRect(win, toWH(phys));
      return { x: r.x - winDip.x, y: r.y - winDip.y, w: r.width, h: r.height };
    };
    return { displays: physList.map(rel), homeRect: rel(physHome) };
  } catch {
    const rects = toRelative(workAreaRects(), { x: bounds.x, y: bounds.y });
    const home = dockDisplay().workArea;
    return {
      displays: rects,
      homeRect: { x: home.x - bounds.x, y: home.y - bounds.y, w: home.width, h: home.height }
    };
  }
}

// The widget layer belongs at the BACK: on the desktop, behind every app
// window the user works with. Re-assert that whenever we might have risen
// (bounds changes, startup, losing focus) - unless Always on top is chosen.
function sinkToDesktop() {
  if (!win) return;
  if (store.get('alwaysOnTop') || dockSummoned || (aiService && aiService.isPinned())) return;
  // Linux: the canvas stacks like a normal window - clicking a widget brings
  // the widgets over the app windows, clicking an app (through the empty
  // space, which takes no input) brings that app forward. Keeping it below
  // everything (linuxKeepBelow) was tried and left the widgets stuck behind.
  if (process.platform === 'linux') return;
  if (process.platform !== 'win32' || !taskWindows) return;
  try {
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
    taskWindows.sendToBottom(hwnd);
  } catch { /* window going away */ }
}

function applyBounds() {
  if (!win) return;
  win.setBounds(computeBounds());
  // Spanning mixed-DPI displays, Electron's DIP conversion often lands short
  // (it converts against one display's scale). Re-assert the exact physical
  // rect through Win32, which is what the OS actually honours.
  sinkToDesktop();
  if (process.platform === 'win32' && store.get('dock') === 'free' && taskWindows) {
    const phys = unionRect(physicalWorkAreas());
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
    taskWindows.setPhysicalBounds(hwnd, phys).then((ok) => {
      // Chromium re-lays-out at the window's scale; tell the renderer the
      // display map once the real bounds have settled.
      if (ok && win) setTimeout(() => {
        sendSettings();
      }, 150);
    });
  }
}

// Input model.
// Windows/macOS: click-through with forwarded mouse moves - the renderer
// reclaims the mouse over a widget (setIgnoreMouseEvents + forward).
// Linux: forwarding does not exist, and the cursor-poll fallback dies under
// XWayland, where the global cursor freezes the moment the pointer is over
// a Wayland surface (i.e. the desktop behind us). So on Linux the window
// always TAKES input and the X11 SHAPE region decides where: docked mode is
// the whole strip, free-form mode is the widget rects the renderer reports.
function linuxShapeInput() {
  return process.platform === 'linux' && win && typeof win.setShape === 'function';
}

// setShape only sets the drawn (bounding) shape. Under Xwayland - GNOME and
// every Wayland session - input follows the INPUT shape alone, so it is set
// as well (x11-input-shape.js); without it the transparent canvas took every
// click on the screen.
let x11Input = null;
let lastInputRects = null;
function linuxKeepBelow(on) {
  if (process.platform !== 'linux' || !win || win.isDestroyed()) return;
  setInputRegion(null);           // make sure the shared X11 connection exists
  x11Input.keepBelow(require('./x11-input-shape').xidOf(win), on).catch(() => {});
}
// Before the window is lifted above others (summon, always on top, pinned):
// "keep below" would hold it down, so it is cleared first.
function liftFromDesktop() { if (process.platform === 'linux') linuxKeepBelow(false); }
function setInputRegion(rects) {
  if (process.platform !== 'linux' || !win || win.isDestroyed()) return;
  if (rects) lastInputRects = rects;
  if (!x11Input) {
    const { X11InputShape } = require('./x11-input-shape');
    x11Input = new X11InputShape({ log: (m) => console.log('[input-shape]', m) });
    // A window that is unmapped and mapped again (hide/show, a display
    // change) can come back with a full input region: re-assert it now and then.
    setInterval(() => {
      if (lastInputRects && win && !win.isDestroyed() && win.isVisible()) {
        x11Input.set(require('./x11-input-shape').xidOf(win), lastInputRects).catch(() => {});
      }
    }, 5000);
  }
  if (rects) x11Input.set(require('./x11-input-shape').xidOf(win), rects).catch(() => {});
}

function applyInputModel() {
  if (!win) return;
  if (!linuxShapeInput()) { setIgnoreMouse(true); return; }
  win.setIgnoreMouseEvents(false);
  if (store.get('dock') !== 'free') {
    // Docked: the whole strip is interactive. The docs say an empty list
    // reverts to rectangular, but an implementation that reads it as an
    // empty REGION would make the window deaf - pass the full rect instead.
    const b = win.getBounds();
    const full = [{ x: 0, y: 0, width: b.width, height: b.height }];
    win.setShape(full);
    setInputRegion(full);
  }
  // free: the renderer's rect reports (window:input-shape) take over
}

ipcMain.on('window:input-shape', (_e, rects) => {
  if (!linuxShapeInput() || store.get('dock') !== 'free') return;
  try {
    const list = (Array.isArray(rects) ? rects : [])
      .map((r) => ({ x: r.x | 0, y: r.y | 0, width: r.width | 0, height: r.height | 0 }))
      .filter((r) => r.width > 0 && r.height > 0);
    win.setShape(list);
    // Input: the same widgets with a tighter margin (the drawn shape keeps
    // 24 px for glows; 8 px is enough for the resize grips), so a window
    // just beside a widget can still be clicked.
    const b = win.getContentBounds();
    const full = list.length === 1 && list[0].x === 0 && list[0].y === 0 && list[0].width >= b.width - 2 && list[0].height >= b.height - 2;
    setInputRegion(full ? list : list.map((r) => ({ x: r.x + 16, y: r.y + 16, width: Math.max(1, r.width - 32), height: Math.max(1, r.height - 32) })));
  } catch { /* window going away */ }
});

let mousePollTimer = null;
function setIgnoreMouse(ignore) {
  if (!win) return;
  if (process.platform !== 'linux') {
    win.setIgnoreMouseEvents(!!ignore, { forward: true });
    return;
  }
  win.setIgnoreMouseEvents(!!ignore);
  clearInterval(mousePollTimer);
  mousePollTimer = null;
  if (ignore) {
    mousePollTimer = setInterval(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      try {
        const pt = screen.getCursorScreenPoint();
        const b = win.getBounds();
        if (pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height) {
          win.webContents.send('mouse:probe', { x: pt.x - b.x, y: pt.y - b.y });
        }
      } catch { /* display going away */ }
    }, 120);
  }
}

// Settings (theme and all) go to the desktop and to every file browser window.
function sendSettings() {
  const s = publicSettings();
  for (const w of [win, ...filesWindows]) if (w && !w.isDestroyed()) w.webContents.send('settings:changed', s);
}

// A file browser in its own window: resizable, in the taskbar, any number.
function openFilesWindow(start) {
  const bg = `rgb(${(themeVars(store.get('theme'))['--glass-rgb'] || '18, 24, 40')})`;
  const w = new BrowserWindow({
    width: 980, height: 640, minWidth: 520, minHeight: 320,
    title: 'Files - BE-Aero', icon: loadIcon(), autoHideMenuBar: true, show: false,
    backgroundColor: /^rgb\([\d,\s]+\)$/.test(bg) ? bg : '#121828',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  w.setMenu(null);
  filesWindows.add(w);
  w.on('closed', () => filesWindows.delete(w));
  w.once('ready-to-show', () => w.show());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.loadFile(path.join(ROOT, 'src', 'renderer', 'files.html'), { query: start ? { path: String(start) } : {} });
  return true;
}

function createWindow() {
  const s = store.get();
  // Linux, docked: declare what this window IS - an X11 dock
  // (_NET_WM_WINDOW_TYPE_DOCK). Window managers place normal windows by
  // policy (GNOME centers them and may refuse later moves), but a dock is
  // positioned by its client and takes input normally. Free-form spans the
  // whole work area, so placement policy cannot move it anywhere wrong and
  // it stays a normal window.
  const linuxDock = process.platform === 'linux' && s.dock !== 'free';
  win = new BrowserWindow({
    ...computeBounds(),
    ...(linuxDock ? { type: 'dock' } : {}),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: s.alwaysOnTop,
    title: 'BE-Aero Desktop',
    icon: loadIcon(),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      // Web widgets render in <webview> guests: a guest is its own top-level
      // page, so sites that refuse to be iframed (X-Frame-Options /
      // frame-ancestors) still load, and their cookies are first-party.
      webviewTag: true
    }
  });

  win.setOpacity(s.opacity);
  // Transparent areas let clicks fall through to the desktop; the renderer
  // turns mouse capture back on whenever the pointer is over a widget.
  applyInputModel();

  if (!app.isPackaged) {
    // Surface renderer warnings/errors in the terminal during development.
    // Harden every guest the renderer attaches: no preload, no node, always
    // sandboxed, only http(s) content, and only the web-widget partition. A
    // compromised renderer could otherwise attach a privileged guest.
    win.webContents.on('will-attach-webview', (e, webPreferences, params) => {
      delete webPreferences.preload;
      delete webPreferences.preloadURL;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      if (!/^https?:/i.test(params.src || '') || params.partition !== 'persist:webwidgets') {
        e.preventDefault();
      }
    });

    // A web widget that fails to load is otherwise a silent blank box; tell
    // the renderer which URL failed and why so the pane can say so.
    win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame || !/^https?:/i.test(validatedURL || '')) return;
      win.webContents.send('webwidget:failed', {
        code: errorCode, description: errorDescription, url: validatedURL
      });
    });

    win.webContents.on('console-message', (e) => {
      console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
    win.webContents.on('preload-error', (_e, p, err) => console.error('[preload]', p, err));
  }

  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    // Linux WMs often override the pre-map position of a frameless window
    // (GNOME centers it, sometimes well after mapping); re-assert the
    // computed bounds twice and say what the WM actually honoured.
    if (process.platform === 'linux') {
      const assert = () => { if (win) applyBounds(); };
      setTimeout(assert, 300);
      setTimeout(() => {
        assert();
        if (!win) return;
        const want = computeBounds();
        const got = win.getBounds();
        if (want.x !== got.x || want.y !== got.y) {
          console.warn(`[linux] WM ignored position: wanted ${want.x},${want.y} got ${got.x},${got.y}`);
        }
      }, 1500);
    }
  });

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      rebuildTrayMenu();
    }
  });

  // External links open in the default browser, never inside the widget.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
  rebuildTrayMenu();
}

// Keyboard input to whatever application has focus - the assistant's way of
// driving programs that have no API. Windows: .NET SendKeys through a
// PowerShell one-liner (passed base64-encoded so no quoting can break it);
// Linux: xdotool when present.
function sendKeysToForeground({ text = '', keys = '' }) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // Literal text must escape SendKeys' own metacharacters.
      const literal = String(text).replace(/[+^%~(){}[\]]/g, '{$&}');
      const script = 'Add-Type -AssemblyName System.Windows.Forms; '
        + (literal ? `[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(literal)}); ` : '')
        + (keys ? `[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(String(keys))}); ` : '');
      const enc = Buffer.from(script, 'utf16le').toString('base64');
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true, stdio: 'ignore' });
      child.once('error', (err) => resolve({ ok: false, error: err.message }));
      child.once('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `SendKeys exited ${code}` }));
      return;
    }
    const steps = [];
    if (text) steps.push(['type', '--delay', '15', '--', String(text)]);
    if (keys) steps.push(['key', '--', ...String(keys).split(/\s+/).filter(Boolean)]);
    const runStep = (i) => {
      if (i >= steps.length) return resolve({ ok: true });
      const child = spawn('xdotool', steps[i], { stdio: 'ignore' });
      child.once('error', () => resolve({ ok: false, error: 'xdotool is not installed (needed to send keys on Linux)' }));
      child.once('exit', (code) => (code === 0 ? runStep(i + 1) : resolve({ ok: false, error: `xdotool exited ${code}` })));
    };
    runStep(0);
  });
}

// ---------------------------------------------------------------- Dock hotkey
// Like the search hotkey, but for the dock: lift the sidebar above whatever
// is on screen (a full-screen game included), light the dock up, and sink
// back to the desktop layer as soon as the user picks an app or presses the
// key again. Widgets otherwise live BEHIND every app window, so without this
// the dock is unreachable while anything is maximised.
function summonDock() {
  if (!win) return;
  if (dockSummoned) { unsummonDock(); return; }
  dockSummoned = true;
  console.log('[dock] summoned');
  if (!store.get('alwaysOnTop')) { liftFromDesktop(); win.setAlwaysOnTop(true, 'screen-saver'); }
  win.show();
  win.focus();
  win.webContents.send('dock:summon', true);
}

function unsummonDock() {
  if (!dockSummoned) return;
  dockSummoned = false;
  console.log('[dock] dismissed');
  if (win && !win.isDestroyed()) {
    if (!store.get('alwaysOnTop') && !(aiService && aiService.isPinned())) {
      win.setAlwaysOnTop(false);
      sinkToDesktop();
    }
    win.webContents.send('dock:summon', false);
  }
}

// Register the dock hotkey; fall back through free combinations if the
// user's choice is already owned by another program (or by Search).
function applyDockHotkey(accel) {
  const { isValid, normalize } = require('../shared/hotkey');
  if (dockHotkey) { try { globalShortcut.unregister(dockHotkey); } catch { /* gone */ } }
  dockHotkey = null;
  const wanted = isValid(accel) ? normalize(accel) : null;
  const candidates = [...new Set([wanted, 'Control+Alt+D', 'Control+Shift+D', 'Control+Alt+Shift+D',
    'Alt+Shift+D'].filter(Boolean))];
  for (const c of candidates) {
    try {
      if (globalShortcut.register(c, summonDock)) { dockHotkey = c; break; }
    } catch (err) {
      console.warn('Invalid dock hotkey', c, err.message);
    }
  }
  if (!dockHotkey) console.warn('Could not register any dock hotkey');
  else if (dockHotkey !== wanted) console.warn(`Dock hotkey ${accel} is taken; using ${dockHotkey}`);
  else console.log(`Dock hotkey: ${dockHotkey}`);
  rebuildTrayMenu();
  return dockHotkey;
}

ipcMain.handle('dock:hotkey', () => dockHotkey);

// Voice hotkey: toggles dictation in the AI chat from anywhere. The sidebar
// is shown (without taking focus) so the result is visible.
let voiceHotkey = null;
function onVoiceHotkey() {
  if (!win || win.isDestroyed()) return;
  if (aiService && !aiService.enabled()) return;
  if (!win.isVisible()) win.showInactive();
  win.webContents.send('ai:voice-hotkey');
}
function applyVoiceHotkey(accel) {
  const { isValid, normalize } = require('../shared/hotkey');
  if (voiceHotkey) { try { globalShortcut.unregister(voiceHotkey); } catch { /* gone */ } }
  voiceHotkey = null;
  if (accel === '') { rebuildTrayMenu(); return null; }   // turned off
  const wanted = isValid(accel) ? normalize(accel) : null;
  const candidates = [...new Set([wanted, 'Control+Alt+M', 'Control+Alt+Shift+M', 'Alt+Shift+M'].filter(Boolean))];
  for (const c of candidates) {
    if (c === dockHotkey) continue;
    try { if (globalShortcut.register(c, onVoiceHotkey)) { voiceHotkey = c; break; } } catch (err) { console.warn('Invalid voice hotkey', c, err.message); }
  }
  if (!voiceHotkey) console.warn('Could not register any voice hotkey');
  else if (voiceHotkey !== wanted) console.warn(`Voice hotkey ${accel} is taken; using ${voiceHotkey}`);
  return voiceHotkey;
}
ipcMain.handle('voice:hotkey', () => voiceHotkey);

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide(); else win.showInactive();
  rebuildTrayMenu();
}

function setLaunchAtStartup() {
  // Reconcile rather than set: re-assert the correct Run entry when enabled
  // and sweep stale ones (old identities, old install paths) every time.
  // Only meaningful in the packaged build; in dev it would register electron.exe.
  require('./startup').reconcileStartupRegistration({ app, store });
}

// Apply a settings patch and push the result to the renderer.
function updateSettings(patch) {
  const before = store.get();
  if (patch.dock === 'free' && before.dock !== 'free' && win) {
    // Remember which edge the sidebar came from so widgets start out there.
    patch = { ...patch, freeFrom: before.dock };
  }
  const s = store.set(patch);

  if (win) {
    if ('alwaysOnTop' in patch) {
      if (s.alwaysOnTop) liftFromDesktop();
      win.setAlwaysOnTop(s.alwaysOnTop, 'floating');
      if (!s.alwaysOnTop) sinkToDesktop();
    }
    if ('opacity' in patch) win.setOpacity(Math.max(0.3, Math.min(1, s.opacity)));
    if ('dock' in patch || 'width' in patch || 'dockDisplay' in patch) {
      // On Linux the docked sidebar is a different WINDOW TYPE (dock) than
      // free-form (normal), and X11 window types are fixed at creation -
      // crossing that line rebuilds the window.
      if (process.platform === 'linux' && 'dock' in patch
          && (patch.dock === 'free') !== (before.dock === 'free')) {
        const old = win;
        win = null;
        try { old.destroy(); } catch { /* already gone */ }
        createWindow();
      } else {
        applyBounds();
        applyInputModel();
      }
    }
    sendSettings();
  }
  if (patch.telemetry && ('interval' in patch.telemetry || 'metrics' in patch.telemetry)) startTelemetry();
  if (spotlight && patch.theme) spotlight.applyTheme && spotlight.applyTheme(s.theme);
  if (patch.spellcheck) applySpellcheck();
  if (patch.devices) rebuildTrayMenu();          // "Send clipboard to" follows the Clipboard switch
  if (patch.appDock && typeof patch.appDock === 'object' && 'hotkey' in patch.appDock) {
    applyDockHotkey(s.appDock.hotkey);
  }
  if (patch.ai && patch.ai.voice && typeof patch.ai.voice === 'object' && 'hotkey' in patch.ai.voice) {
    applyVoiceHotkey(((s.ai || {}).voice || {}).hotkey);
  }
  if (spotlight && patch.search) {
    if ('hotkey' in patch.search) spotlight.applyHotkey(s.search.hotkey);
    if ('extraRoots' in patch.search) spotlight.reindex();
  }
  if ('launchAtStartup' in patch && patch.launchAtStartup !== before.launchAtStartup) {
    setLaunchAtStartup();
  }
  rebuildTrayMenu();
  return s;
}

function buildMenuTemplate() {
  const s = store.get();
  const dockItem = (label, value) => ({
    label, type: 'radio', checked: s.dock === value, click: () => updateSettings({ dock: value })
  });
  const widgetItem = (label, key) => ({
    label, type: 'checkbox', checked: s.widgets[key],
    click: (item) => updateSettings({ widgets: { [key]: item.checked } })
  });

  return [
    { label: win && win.isVisible() ? 'Hide BE-Aero Desktop' : 'Show BE-Aero Desktop', click: toggleWindow },
    { label: `Search...${spotlight && spotlight.hotkey ? '\t' + spotlight.hotkey.replace('Control', 'Ctrl') : ''}`,
      click: () => spotlight && spotlight.show() },
    { label: 'Settings...', click: () => { showWindow(); win.webContents.send('settings:open'); } },
    { label: 'Check for updates...', click: () => runUpdateCheck({ manual: true }) },
    { label: 'Create widget from web address...',
      click: () => { showWindow(); win.webContents.send('settings:open', 'webwidget'); } },
    ...clipMenuItems(),
    { type: 'separator' },
    { label: 'Widgets', submenu: [
      widgetItem('Search bar', 'search'),
      widgetItem('Chronometer', 'clock'),
      widgetItem('Weather', 'weather'),
      widgetItem('System telemetry', 'telemetry'),
      widgetItem(`Application dock${dockHotkey ? '\t' + dockHotkey.replace('Control', 'Ctrl') : ''}`, 'tasks'),
      { label: 'Dock alignment', submenu: ['left', 'center', 'right'].map((a) => ({
        label: a[0].toUpperCase() + a.slice(1), type: 'radio',
        checked: ((store.get('appDock') || {}).align || 'center') === a,
        click: () => updateSettings({ appDock: { align: a } })
      })) },
      widgetItem('Scratchpad', 'scratchpad'),
      widgetItem('Files', 'files'),
      widgetItem('Sound', 'sound'),
      widgetItem('AI chat', 'ai'),
      // Plugins and web widgets are widgets too - individually toggleable
      // from the same place.
      ...(pluginList.length ? [{ type: 'separator' },
        ...pluginList.map((p) => ({
          label: p.name, type: 'checkbox',
          checked: ((store.get('plugins') || {}).enabled || {})[p.id] !== false,
          click: (item) => {
            updateSettings({ plugins: { enabled: { [p.id]: item.checked } } });
            broadcastPlugins();
          }
        }))] : []),
      ...((store.get('webWidgets') || []).length ? [{ type: 'separator' },
        ...(store.get('webWidgets') || []).map((w) => ({
          label: w.name || w.url, type: 'checkbox',
          checked: !w.minimized,
          click: (item) => {
            const list = (store.get('webWidgets') || [])
              .map((x) => (x.id === w.id ? { ...x, minimized: !item.checked } : x));
            updateSettings({ webWidgets: list });
          }
        }))] : [])
    ] },
    { label: 'Position', submenu: [
      dockItem('Dock right', 'right'),
      dockItem('Dock left', 'left'),
      dockItem('Free-form (drag widgets onto any monitor)', 'free'),
      ...(screen.getAllDisplays().length > 1 ? [
        { type: 'separator' },
        ...screen.getAllDisplays().map((d, i) => ({
          label: `Dock on display ${i + 1} (${d.size.width}\u00d7${d.size.height}${d.id === screen.getPrimaryDisplay().id ? ', primary' : ''})`,
          type: 'radio',
          checked: dockDisplay().id === d.id,
          click: () => updateSettings({ dockDisplay: d.id })
        }))
      ] : []),
      { type: 'separator' },
      { label: 'Reset widget layout', click: () => {
        store.get().layout = { free: {}, docked: {} };
        updateSettings({});
      } }
    ] },
    { label: 'Float above all windows', type: 'checkbox', checked: !!s.alwaysOnTop,
      click: (item) => updateSettings({ alwaysOnTop: item.checked }) },
    { label: 'Lock widget layout', type: 'checkbox', checked: !!s.locked,
      click: (item) => updateSettings({ locked: item.checked }) },
    { label: 'AI assistant', submenu: [
      { label: 'Enable AI assistant', type: 'checkbox', checked: (s.ai || {}).enabled !== false,
        click: (item) => updateSettings({ ai: { enabled: item.checked } }) },
      { label: 'Edit persona & instructions...', click: () => { showWindow(); win.webContents.send('settings:open', 'ai'); } },
      { label: 'Provider & model...', click: () => { showWindow(); win.webContents.send('settings:open', 'ai'); } }
    ] },
    { label: 'Theme', submenu: [
      ...Object.entries(PRESETS).map(([id, p]) => ({
        label: p.name, type: 'radio', checked: s.theme.preset === id && !s.theme.custom,
        click: () => { store.get().theme = { preset: id, custom: null }; updateSettings({ theme: {} }); }
      })),
      { type: 'separator' },
      { label: s.theme.custom ? 'Customize... (custom colours active)' : 'Customize...',
        click: () => { showWindow(); win.webContents.send('settings:open', 'theme'); } }
    ] },
    { label: 'Always on top', type: 'checkbox', checked: s.alwaysOnTop,
      click: (item) => updateSettings({ alwaysOnTop: item.checked }) },
    { label: 'Launch at startup', type: 'checkbox', checked: s.launchAtStartup,
      enabled: app.isPackaged,
      click: (item) => updateSettings({ launchAtStartup: item.checked }) },
    { type: 'separator' },
    { label: 'Rebuild search index', click: () => spotlight && spotlight.reindex() },
    { label: 'Reload widgets', click: () => win && win.webContents.reload() },
    { label: 'Quit BE-Aero Desktop', click: () => { isQuitting = true; app.quit(); } }
  ];
}

// Clipboard to and from my devices: off until turned on in Settings > Devices.
const clipboardOn = () => (((store.get('devices') || {}).sync || {}).clipboard === true);

// Sound widget: mixer + Bluetooth (sound.js). The helper starts on first use.
let soundService = null;
const sound = () => (soundService || (soundService = require('./sound').createSound()));
const soundCall = (fn) => async (_e, ...args) => {
  const s = sound();
  if (!s) return { error: 'Sound controls are not available on this system.' };
  try { return { result: await fn(s, ...args) }; } catch (err) { return { error: String(err && err.message || err) }; }
};
ipcMain.handle('relay:status', () => (relayClient ? relayClient.status() : []));

// The widget tray (dock): the widgets you made - AI widgets (also those made
// from .html files) and web widgets - with show/hide, open and delete.
// Built-in widgets are not listed.
ipcMain.handle('widgets:created', () => {
  const out = [];
  for (const w of (aiService && aiService.widgets ? aiService.widgets.list() : [])) {
    out.push({ kind: 'ai', id: w.id, name: w.title, shown: !w.hidden, where: w.dir, sites: (w.approvedHosts || []).length });
  }
  for (const w of store.get('webWidgets') || []) {
    let host = '';
    try { host = new URL(w.url).hostname; } catch { host = w.url; }
    out.push({ kind: 'web', id: w.id, name: w.name || host, shown: !w.hidden, where: w.url, shared: !!w.shared });
  }
  return out;
});
ipcMain.handle('widgets:toggle', async (_e, kind, id, on) => {
  if (kind === 'ai' && aiService) return aiService.widgets.setHidden(String(id), !on);
  if (kind === 'web') {
    updateSettings({ webWidgets: (store.get('webWidgets') || []).map((w) => (w.id === id ? { ...w, hidden: !on, ...(on ? { minimized: false } : {}) } : w)) });
    return true;
  }
  return false;
});
// Add a widget from the tray: an .html file (copied into AI Widgets), or a web page.
ipcMain.handle('widgets:add-html', async () => {
  if (!aiService) return { error: 'Turn on the AI assistant first - widgets made from files live in its folder.' };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Make a widget from an HTML file', properties: ['openFile'],
    filters: [{ name: 'Web page', extensions: ['html', 'htm'] }]
  });
  if (canceled || !filePaths || !filePaths[0]) return { canceled: true };
  try { return { ok: true, ...(await aiService.widgets.createFromFile(filePaths[0])) }; } catch (err) { return { error: String(err && err.message || err) }; }
});
ipcMain.handle('widgets:add-web', async (_e, rawUrl, rawName) => {
  let url = String(rawUrl || '').trim();
  if (!url) return { error: 'Enter the page address.' };
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error(); } catch { return { error: 'That does not look like a web address.' }; }
  const entry = { id: `w${Date.now().toString(36)}`, name: String(rawName || '').trim().slice(0, 40), url, height: 300 };
  updateSettings({ webWidgets: [...(store.get('webWidgets') || []), entry] });
  return { ok: true, id: entry.id };
});
ipcMain.handle('widgets:open', async (_e, kind, id) => {
  if (kind === 'ai' && aiService) { const w = aiService.widgets.get(String(id)); if (w) { shell.openPath(w.dir); return true; } }
  if (kind === 'web') { const w = (store.get('webWidgets') || []).find((x) => x.id === id); if (w && /^https?:/i.test(w.url)) { shell.openExternal(w.url); return true; } }
  return false;
});
ipcMain.handle('widgets:delete', async (_e, kind, id) => {
  if (kind === 'ai' && aiService) return aiService.widgets.remove(String(id), (dir) => shell.trashItem(dir));
  if (kind === 'web') { updateSettings({ webWidgets: (store.get('webWidgets') || []).filter((w) => w.id !== id) }); return true; }
  return false;
});
ipcMain.handle('sound:state', async (_e, dev) => {
  if (dev) {
    try { return await meshCall(String(dev), 'sound.state', {}, 20000); } catch (err) { return { error: String(err && err.message || err), devices: [], sessions: [] }; }
  }
  const s = sound();
  if (!s) return { error: 'Sound controls are not available on this system.', devices: [], sessions: [] };
  try { return await s.state(); } catch (err) { return { error: String(err && err.message || err), devices: [], sessions: [] }; }
});
ipcMain.handle('sound:set', async (e, what, id, value, dev) => {
  if (!dev) return soundSetLocal(e, what, id, value);
  try { return { result: await meshCall(String(dev), 'sound.set', { what: String(what), id: id == null ? null : String(id), value }) }; } catch (err) { return { error: String(err && err.message || err) }; }
});
const soundSetLocal = soundCall((s, what, id, value) => {
  if (what === 'master') return s.setMaster(Number(value));
  if (what === 'master-mute') return s.muteMaster(!!value);
  if (what === 'app') return s.setApp(String(id), Number(value));
  if (what === 'app-mute') return s.muteApp(String(id), !!value);
  if (what === 'default') return s.setDefault(String(id));
  throw new Error('unknown setting');
});

// The devices whose media and volume can be controlled from here: this one
// and my other devices that are connected now (live control needs a direct link).
function controlDevices() {
  const mesh = deviceService && deviceService.mesh;
  const self = { id: '', name: (store.get('devices') || {}).name || require('os').hostname(), self: true };
  if (!mesh) return [self];
  return [self, ...[...mesh.peers.values()].filter((p) => p.role !== 'relay' && mesh.conns.has(p.id))
    .map((p) => ({ id: p.id, name: p.label || p.name || p.id.slice(0, 7) }))];
}
function meshCall(dev, op, args, timeout = 10000) {
  const mesh = deviceService && deviceService.mesh;
  if (!mesh) return Promise.reject(new Error('Device connections are off.'));
  if (!mesh.conns.has(dev)) return Promise.reject(new Error('That device is not connected right now.'));
  return mesh.request(dev, op, args, timeout).catch((err) => {
    if (/unknown request/.test(String(err && err.message))) throw new Error('That device needs a newer BE-Aero before it can be controlled from here.');
    throw err;
  });
}
// Answering: my media and mixer for my other devices (the "media" permission).
function attachMedia(mesh) {
  const crypto = require('crypto');
  mesh.handle('media.info', 'media', async (a) => {
    const r = await mediaCtl.info();
    if (r && r.thumb) {
      const key = crypto.createHash('sha1').update(r.thumb).digest('hex').slice(0, 16);
      if (a && a.thumbKey === key) { delete r.thumb; r.thumbSame = true; }
      r.thumbKey = key;
    }
    return r;
  });
  mesh.handle('media.action', 'media', async (a) => mediaCtl.action(String((a && a.name) || '')));
  mesh.handle('media.seek', 'media', async (a) => mediaCtl.seek(Number(a && a.seconds)));
  mesh.handle('sound.state', 'media', async () => {
    const s = sound();
    if (!s) return { error: 'Sound controls are not available on that device.', devices: [], sessions: [] };
    return s.state();
  });
  mesh.handle('sound.set', 'media', async (a) => {
    const r = await soundSetLocal(null, a && a.what, a && a.id, a && a.value);
    if (r && r.error) throw new Error(r.error);
    return r ? r.result : false;
  });
}
ipcMain.handle('sound:bt', soundCall((s, what, id, on) => {
  if (what === 'state') return s.bluetooth();
  if (what === 'connect') return s.btConnect(String(id), !!on);
  if (what === 'power') return s.btPower(!!on);
  if (what === 'settings') return s.openBluetoothSettings();
  throw new Error('unknown request');
}));
app.on('will-quit', () => { if (soundService) soundService.destroy(); });

// Clicking another app's notification brings that app up.
// Windows: the toast's own link (activationType="protocol"), else an open
// window of the app, else launch it by its app id (shell:AppsFolder).
// Linux: its window, else launch its desktop entry.
async function openNotificationApp(launch = {}) {
  if (process.platform === 'linux') return linuxTasks ? linuxTasks.openApp({ appId: launch.appId, name: launch.name }) : false;
  if (process.platform !== 'win32') return false;
  const uri = String(launch.uri || '');
  if (uri && /^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^(file|javascript|vbscript|data|ms-msdt|search-ms):/i.test(uri)) {
    try { await shell.openExternal(uri); return true; } catch { /* fall through */ }
  }
  const aumid = String(launch.aumid || '');
  if (taskWindows) {
    // Words of the app id / name a window's program should carry:
    // "com.squirrel.Discord.Discord" -> discord, "Microsoft.Office.OUTLOOK.EXE.15" -> outlook.
    const skip = /^(com|org|net|microsoft|windows|app|apps|exe|desktop|client|squirrel|google|mozilla|\d+)$/i;
    const words = [...new Set([...aumid.split(/[.!_\\/\s-]+/), ...String(launch.name || '').split(/\s+/)]
      .map((w) => w.toLowerCase().replace(/\.exe$/, '')).filter((w) => w.length > 2 && !skip.test(w)))];
    try {
      const wins = await taskWindows.list();
      const hit = wins.find((w) => { const base = path.basename(String(w.exe || ''), '.exe').toLowerCase(); return base && words.some((x) => base === x || base.includes(x) || x.includes(base)); });
      if (hit && await taskWindows.action('raise', hit.hwnd)) return true;
    } catch { /* no window list */ }
  }
  if (aumid && /^[\w.!{}\\: -]+$/.test(aumid)) {
    // A desktop app's id can be its full path; launch that directly.
    const target = /^[a-z]:\\/i.test(aumid) || /^\{[0-9A-F-]+\}\\/i.test(aumid) ? null : `shell:AppsFolder\\${aumid}`;
    const { spawn } = require('child_process');
    if (target) { spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref(); return true; }
  }
  return false;
}

// "Send clipboard to" - one item per paired device online now.
function clipMenuItems() {
  const mesh = deviceService && deviceService.mesh;
  if (!mesh || !clipboardOn()) return [];        // off in Settings > Devices
  const targets = sendTargets();
  return [{ label: 'Send clipboard to', enabled: targets.length > 0,
    submenu: targets.length ? targets.map(({ id, p, relayed }) => ({ label: `${p.label || p.name || id.slice(0, 7)}${relayed ? '  (via relay)' : ''}`, click: () => sendClipboardTo(id) }))
      : [{ label: 'No paired devices online', enabled: false }] }];
}

async function sendClipboardTo(peerId) {
  const { clipboard } = require('electron');
  const mesh = deviceService && deviceService.mesh;
  const p = mesh && mesh.peers.get(peerId);
  const name = (p && (p.label || p.name)) || 'that device';
  const tell = (title, body) => { if (notifyCenter) notifyCenter.add({ source: 'system', title, body, toast: true }); };
  try {
    const msg = require('./clip-send').readClip(clipboard);
    if (!msg) { tell('Nothing to send', 'The clipboard has no text or image.'); return; }
    const viaRelay = !mesh.conns.has(peerId) && relayClient && relayClient.reachable(peerId);
    if (viaRelay) await relayClient.send(peerId, 'clipboard', '', msg);
    else await mesh.request(peerId, 'clipboard.put', msg, 30000);
    tell(viaRelay ? `Clipboard sent to ${name} through the relay` : `Clipboard sent to ${name}`, msg.kind === 'image' ? `An image (${msg.width} × ${msg.height})` : String(msg.text).replace(/\s+/g, ' ').trim().slice(0, 80));
  } catch (err) {
    tell('Clipboard not sent', /turned off/.test(err.message) ? `${name} has clipboard sharing turned off (Settings > Devices on ${name}).` : /allowed/.test(err.message) ? `${name} has not allowed "Clipboard" for this device (Settings > Devices on ${name}).` : err.message);
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

ipcMain.on('menu:popup', () => {
  if (win) Menu.buildFromTemplate(buildMenuTemplate()).popup({ window: win });
});

function createTray() {
  // The tray is optional: stock GNOME has no tray host at all, and GTK's
  // status-icon path is historically assert-happy. The toolbar's menu
  // button carries the same menu, so a tray failure must never hurt boot.
  try {
    const icon = loadIcon();
    if (!icon && process.platform === 'linux') {
      console.warn('[tray] no icon found; skipping tray (menu lives in the toolbar)');
      return;
    }
    tray = new Tray(icon || nativeImage.createEmpty());
    tray.setToolTip(`BE-Aero Desktop  (${TOGGLE_SHORTCUT.replace('Control', 'Ctrl')} to toggle)`);
    tray.on('click', toggleWindow);
    rebuildTrayMenu();
  } catch (err) {
    console.warn('[tray] unavailable:', err.message);
    tray = null;
  }
}

function telemetryOpts() {
  const t = store.get('telemetry');
  return { disk: t.metrics.disk, net: t.metrics.net, drive: t.drive };
}

// (Re)start sampling at the configured interval.
function startTelemetry() {
  clearInterval(telemetryTimer);
  telemetry.sample(telemetryOpts()); // prime the CPU / network deltas
  const ms = Math.max(500, Math.min(10000, Number(store.get('telemetry').interval) || 1500));
  telemetryTimer = setInterval(() => {
    if (win && win.isVisible()) win.webContents.send('telemetry:update', telemetry.sample(telemetryOpts()));
  }, ms);
}

// ---------------------------------------------------------------- IPC
// Settings as sent to the renderer: stored values plus the resolved theme.
function publicSettings() {
  const s = store.get();
  // API keys stay in the main process (even encrypted, the page has no use for them).
  const ai = s.ai ? { ...s.ai, apiKey: s.ai.apiKey ? '(saved)' : '', taskApiKey: s.ai.taskApiKey ? '(saved)' : '', keys: Object.fromEntries(Object.entries(s.ai.keys || {}).map(([k, v]) => [k, v ? '(saved)' : ''])) } : s.ai;
  return { ...s, ai, themeVars: themeVars(s.theme), ...displayGeometry() };
}

ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('themes:list', () => Object.entries(PRESETS).map(([id, p]) => ({ id, ...p })));
ipcMain.handle('settings:set', (_e, patch) => {
  patch = patch || {};
  // The page only ever sees "(saved)" for API keys; never let that come back as a key.
  if (patch.ai && typeof patch.ai === 'object') {
    const ai = { ...patch.ai };
    for (const f of ['apiKey', 'taskApiKey']) if (ai[f] === '(saved)') delete ai[f];
    if (ai.keys && typeof ai.keys === 'object') ai.keys = Object.fromEntries(Object.entries(ai.keys).filter(([, v]) => v !== '(saved)'));
    patch = { ...patch, ai };
  }
  return updateSettings(patch);
});
// ---------------------------------------------------------------- Plugin files
const PLUGIN_MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon'
};

// What a plugin page is allowed to do. Scripts and styles are its own (plus
// inline, which is how small widgets are written); it may reach https for data
// but can never frame anything or post a form somewhere.
const PLUGIN_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src https:",
  "media-src 'self' https:",
  "form-action 'none'",
  "frame-src 'none'",
  "base-uri 'none'"
].join('; ');

function registerPluginProtocol() {
  protocol.handle('aero-plugin', async (request) => {
    const url = new URL(request.url);
    const plugin = pluginById(url.hostname);
    if (!plugin) return new Response('no such plugin', { status: 404 });

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // The SDK is always the host's copy, so every plugin runs the same version
    // and cannot ship a stale or tampered one.
    const file = relative === 'aero-sdk.js'
      ? path.join(ROOT, 'sdk', 'aero-sdk.js')
      : path.join(plugin.dir, relative);

    // Never serve anything outside the plugin's own folder.
    const root = relative === 'aero-sdk.js' ? path.join(ROOT, 'sdk') : plugin.dir;
    const resolved = path.resolve(file);
    if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }

    try {
      const body = await fsp.readFile(resolved);
      if (!app.isPackaged) console.log(`[plugin] 200 ${request.url}`);
      const type = PLUGIN_MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      const headers = { 'content-type': type, 'cache-control': 'no-cache' };
      if (type === 'text/html') headers['content-security-policy'] = PLUGIN_CSP;
      return new Response(body, { headers });
    } catch {
      if (!app.isPackaged) console.log(`[plugin] 404 ${request.url}`);
      return new Response('not found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------- Extensions
// Plugins (local folders rendered in a sandboxed iframe) and app panes (pushed
// in over the local API). Both show up as ordinary widgets in the sidebar.

function pluginById(id) {
  return pluginList.find((p) => p.id === id) || null;
}

// Current values for a plugin's manifest-declared settings: the stored value
// when the user set one, the manifest default otherwise. Only declared keys -
// the panel never shows or edits the plugin's free-form storage.
function settingsValuesFor(plugin) {
  const stored = ((store.get('plugins') || {}).settings || {})[plugin.id] || {};
  const out = {};
  for (const s of plugin.settings || []) {
    out[s.key] = Object.prototype.hasOwnProperty.call(stored, s.key) ? stored[s.key] : s.default;
  }
  return out;
}

// Coerce a value from the settings panel to the declared control type, so a
// plugin reading its config gets the type its schema promised.
function coerceSetting(schema, value) {
  switch (schema.type) {
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : Number(schema.default) || 0;
    }
    case 'checkbox': return !!value;
    case 'select': {
      const options = schema.options || [];
      return options.includes(String(value)) ? String(value) : String(schema.default ?? options[0] ?? '');
    }
    default: return String(value ?? '').slice(0, 8192);
  }
}

// What the renderer is allowed to know: never hand out absolute paths beyond
// the entry URL the iframe needs.
function publicPlugins() {
  const enabled = (store.get('plugins') || {}).enabled || {};
  return pluginList.map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    description: p.description,
    author: p.author,
    height: p.height,
    minHeight: p.minHeight,
    minWidth: p.minWidth,
    permissions: p.permissions,
    permissionState: perms.summarize(p, grants(), usage()),
    needsReview: perms.hasUndecided(p, grants()),
    settings: p.settings,
    settingsValues: settingsValuesFor(p),
    enabled: enabled[p.id] !== false,
    entryUrl: `aero-plugin://${p.id}/${p.entry}`
  }));
}

async function refreshPlugins() {
  const result = await loadPlugins(PLUGINS_DIR);
  pluginList = result.plugins;
  pluginErrors = result.errors;
  for (const e of pluginErrors) console.warn(`Plugin "${e.dir}" skipped: ${e.error}`);
  console.log(`Plugins: ${pluginList.length} loaded, ${pluginErrors.length} skipped`);
  // Forget consent for plugins that are gone, and for capabilities a plugin
  // stopped asking for, so a recycled id never inherits an old decision.
  const pruned = perms.pruneGrants(grants(), pluginList);
  if (JSON.stringify(pruned) !== JSON.stringify(grants())) setGrants(pruned);
  broadcastPlugins();
  return publicPlugins();
}

function broadcastPlugins() {
  if (win) win.webContents.send('plugins:changed', publicPlugins());
}

function broadcastPanes(list) {
  if (win) win.webContents.send('panes:changed', list);
}

async function startApi() {
  const port = await apiServer.start();
  broadcastApi();
  return port;
}

function apiStatus() {
  const api = store.get('api') || {};
  return {
    enabled: !!api.enabled,
    running: !!apiServer && !!apiServer.port,
    port: apiServer ? apiServer.port : null,
    // This is the PAIRING token: it only lets a local program ask to pair.
    pairingToken: api.token || null,
    tokenFile: PLUGINS_DIR ? path.join(path.dirname(PLUGINS_DIR), 'api-token.json') : null,
    apps: apiServer ? apiServer.listApps() : []
  };
}

function broadcastApi() {
  if (win) win.webContents.send('api:changed', apiStatus());
}

// A local program is asking for an identity. Show what it wants in plain
// language and let the user decide; nothing is issued without an Allow.
async function confirmPairing({ name, capabilities, exePath, binary }) {
  const lines = capabilities.map((c) => {
    const info = clientApps.describeCapability(c);
    return `  - ${info.title}: ${info.detail}`;
  }).join('\n');

  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'BE-Aero Desktop - connection request',
    message: `Allow "${name}" to connect to BE-Aero Desktop?`,
    detail: `A program running on this PC is asking for its own access.\n\n`
      + (exePath ? `Program: ${exePath}\n` : '')
      + (binary && binary.signed ? `Publisher: ${binary.subject} (signature verified)\n\n`
        : exePath ? `Publisher: UNSIGNED - the program's fingerprint will be pinned instead\n\n` : '')
      + `It wants to:\n${lines}\n\n`
      + `Access will only work from that program. Only allow this if you `
      + `recognise it and started it yourself. You can restrict or disconnect `
      + `it later in Settings > Extensions.`,
    buttons: ['Allow', 'Deny'],
    defaultId: 1,          // consent must be deliberate
    cancelId: 1,
    noLink: true
  });
  return response === 0;
}

// ---------------------------------------------------------------- Permissions
// A manifest only requests a capability; the user grants it. The first time a
// plugin actually uses something it has asked for, we prompt - and remember the
// answer. Revoking in Settings takes effect on the very next call.

function grants() {
  return (store.get('plugins') || {}).grants || {};
}

function usage() {
  return (store.get('plugins') || {}).usage || {};
}

function setGrants(next) {
  // Assign rather than merge: store.set deep-merges, which could never remove
  // a revoked grant.
  const plugins = store.get('plugins');
  plugins.grants = next;
  store.save();
  broadcastPlugins();
}

function noteUsage(id, permission) {
  const plugins = store.get('plugins');
  plugins.usage = { ...(plugins.usage || {}) };
  plugins.usage[id] = { ...(plugins.usage[id] || {}), [permission]: Date.now() };
  store.save();
}

// One prompt at a time, and only one per (plugin, permission) in flight, so a
// plugin cannot spam dialogs by firing a burst of calls.
const pendingPrompts = new Map();

function askUser(plugin, permission) {
  const key = `${plugin.id}:${permission}`;
  if (pendingPrompts.has(key)) return pendingPrompts.get(key);

  const info = perms.describe(permission);
  const promise = dialog.showMessageBox(win, {
    type: 'question',
    title: 'BE-Aero Desktop - permission request',
    message: `Allow "${plugin.name}" to use ${info.title.toLowerCase()}?`,
    detail: `${info.detail}\n\n`
      + `Plugin: ${plugin.name} ${plugin.version}${plugin.author ? ` by ${plugin.author}` : ''}\n`
      + `You can change this later in Settings > Extensions.`,
    buttons: ['Allow', 'Deny'],
    defaultId: 1,          // defaulting to Deny: consent should be deliberate
    cancelId: 1,
    noLink: true
  }).then(({ response }) => {
    const state = response === 0 ? 'granted' : 'denied';
    setGrants(perms.setGrant(grants(), plugin.id, permission, state));
    pendingPrompts.delete(key);
    return state === 'granted';
  }).catch(() => {
    pendingPrompts.delete(key);
    return false;
  });

  pendingPrompts.set(key, promise);
  return promise;
}

// The gate every privileged plugin call goes through.
async function requirePermission(id, permission) {
  const plugin = pluginById(id);
  if (!plugin) throw new Error(`unknown plugin "${id}"`);
  if (!perms.isPermission(permission)) throw new Error(`unknown permission "${permission}"`);
  if (!plugin.permissions.includes(permission)) {
    throw new Error(`"${plugin.name}" did not request the "${permission}" permission in its manifest`);
  }

  const state = perms.stateOf(grants(), id, permission);
  if (state === 'denied') {
    throw new Error(`"${permission}" was denied for "${plugin.name}" - allow it in Settings > Extensions`);
  }
  if (state === 'undecided' && !await askUser(plugin, permission)) {
    throw new Error(`"${permission}" was denied for "${plugin.name}"`);
  }
  noteUsage(id, permission);
  return plugin;
}

ipcMain.handle('plugins:list', () => publicPlugins());
ipcMain.handle('plugins:reload', () => refreshPlugins());
ipcMain.handle('plugins:set-enabled', (_e, id, enabled) => {
  if (!pluginById(id)) return publicPlugins();
  updateSettings({ plugins: { enabled: { [id]: !!enabled } } });
  broadcastPlugins();
  return publicPlugins();
});
ipcMain.handle('plugins:open-folder', () => shell.openPath(PLUGINS_DIR));

// The user edits a manifest-declared setting in the panel. This is the user's
// own action on their own machine, so no plugin permission is involved; the
// key must be declared in the manifest, and the value is coerced to its type.
ipcMain.handle('plugins:set-setting', (_e, id, key, value) => {
  const plugin = pluginById(id);
  const schema = plugin && (plugin.settings || []).find((x) => x.key === key);
  if (!schema) return publicPlugins();
  store.set({ plugins: { settings: { [id]: { [key]: coerceSetting(schema, value) } } } });
  broadcastPlugins();
  return publicPlugins();
});

// A plugin's own key/value store, namespaced so plugins cannot read each other.
ipcMain.handle('plugin:storage-get', async (_e, id) => {
  await requirePermission(id, 'storage');
  return ((store.get('plugins') || {}).settings || {})[id] || {};
});
ipcMain.handle('plugin:storage-set', async (_e, id, patch) => {
  await requirePermission(id, 'storage');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch must be an object');
  const trimmed = {};
  for (const [k, v] of Object.entries(patch).slice(0, 64)) {
    if (typeof v === 'string' && v.length > 8192) continue;  // keep settings.json small
    trimmed[k] = v;
  }
  store.set({ plugins: { settings: { [id]: trimmed } } });
  return ((store.get('plugins') || {}).settings || {})[id] || {};
});
ipcMain.handle('plugin:telemetry', async (_e, id) => {
  await requirePermission(id, 'telemetry');
  return telemetry.sample(telemetryOpts());
});
ipcMain.handle('plugin:theme', async (_e, id) => {
  await requirePermission(id, 'theme');
  return themeVars(store.get('theme'));
});
ipcMain.handle('plugin:open-external', async (_e, id, url) => {
  await requirePermission(id, 'open-external');
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('only http(s) urls can be opened');
  shell.openExternal(url);
  return true;
});
ipcMain.handle('plugin:notify', async (_e, id, body) => {
  const plugin = await requirePermission(id, 'notifications');
  if (!Notification.isSupported()) throw new Error('notifications are not available');
  new Notification({
    // The plugin names itself in the title so a notification can never pretend
    // to come from the host or from another app.
    title: `${plugin.name}: ${String((body && body.title) || '').slice(0, 80)}`.trim(),
    body: String((body && body.body) || '').slice(0, 300),
    icon: loadIcon()
  }).show();
  return true;
});

// A plugin may ask what it has without triggering a prompt, so it can degrade
// gracefully instead of firing a dialog the user did not invite.
ipcMain.handle('plugin:permission-query', (_e, id, permission) => {
  const plugin = pluginById(id);
  if (!plugin || !perms.isPermission(permission)) return 'denied';
  if (!plugin.permissions.includes(permission)) return 'denied';
  return perms.stateOf(grants(), id, permission);
});
// ...and may politely ask for one, which does prompt if still undecided.
ipcMain.handle('plugin:permission-request', async (_e, id, permission) => {
  try {
    await requirePermission(id, permission);
    return 'granted';
  } catch {
    return perms.stateOf(grants(), id, permission) === 'undecided'
      ? 'denied' : perms.stateOf(grants(), id, permission);
  }
});

// ---------------------------------------------------------------- Consent IPC
ipcMain.handle('permissions:catalog', () => perms.PERMISSION_INFO);
ipcMain.handle('permissions:set', (_e, id, permission, state) => {
  if (!pluginById(id)) return publicPlugins();
  setGrants(perms.setGrant(grants(), id, permission, state));
  return publicPlugins();
});
ipcMain.handle('permissions:reset', (_e, id) => {
  if (!pluginById(id)) return publicPlugins();
  setGrants(perms.resetPlugin(grants(), id));
  return publicPlugins();
});

// ---------------------------------------------------------------- App pane IPC
ipcMain.handle('panes:list', () => panes.list());
ipcMain.handle('api:status', () => apiStatus());
ipcMain.handle('api:set-enabled', async (_e, enabled) => {
  store.set({ api: { enabled: !!enabled } });
  if (enabled) await startApi(); else await apiServer.stop();
  rebuildTrayMenu();
  return apiStatus();
});
ipcMain.handle('api:regenerate-token', () => {
  apiServer.regenerateToken();
  return apiStatus();
});
ipcMain.handle('api:capability-catalog', () => clientApps.APP_CAPABILITIES);
ipcMain.handle('api:set-app-grant', (_e, id, capability, state) => {
  apiServer.setAppGrant(id, capability, state);
  return apiStatus();
});
ipcMain.handle('api:revoke-app', (_e, id) => {
  apiServer.revokeApp(id);
  return apiStatus();
});

ipcMain.handle('telemetry:get', () => telemetry.sample(telemetryOpts()));
// Replace a whole subtree (store.set deep-merges, so it can't remove keys).
ipcMain.handle('settings:replace', (_e, key, value) => {
  if (!['layout', 'theme'].includes(key)) return store.get();
  store.get()[key] = value;
  store.save();
  // Pass the replaced key through as the patch so downstream listeners (the
  // Spotlight theme push among them) can see WHAT changed, not just that
  // something did.
  updateSettings({ [key]: {} });
  return publicSettings();
});
ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
ipcMain.handle('displays:list', () => screen.getAllDisplays().map((d, i) => ({
  id: d.id,
  label: `Display ${i + 1} - ${d.size.width}\u00d7${d.size.height}${d.id === screen.getPrimaryDisplay().id ? ' (primary)' : ''}`,
  primary: d.id === screen.getPrimaryDisplay().id
})));

// ---------------------------------------------------------------- Power menu
// Only the five fixed verbs reach the OS; the renderer never names a command.
ipcMain.handle('power:action', (_e, action) => require('./power').runPower(String(action || '')));
// The dock's gear: the operating system's own Settings app.
ipcMain.handle('os:settings', async () => {
  if (process.platform === 'win32') { await shell.openExternal('ms-settings:'); return true; }
  if (process.platform === 'darwin') { await shell.openPath('/System/Applications/System Settings.app'); return true; }
  const { execFileSync, spawn } = require('child_process');
  const has = (bin) => { try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };
  const desktop = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const order = [
    ...(desktop.includes('kde') ? ['systemsettings', 'systemsettings5'] : []),
    ...(desktop.includes('xfce') ? ['xfce4-settings-manager'] : []),
    ...(desktop.includes('cinnamon') ? ['cinnamon-settings'] : []),
    ...(desktop.includes('mate') ? ['mate-control-center'] : []),
    'gnome-control-center', 'budgie-control-center', 'systemsettings', 'xfce4-settings-manager', 'cinnamon-settings', 'mate-control-center', 'lxqt-config'
  ];
  const bin = order.find(has);
  if (!bin) return false;
  spawn(bin, [], { detached: true, stdio: 'ignore' }).unref();
  return true;
});

// ---------------------------------------------------------------- App dock
ipcMain.handle('tasks:action', (_e, name, hwnd) => {
  if (taskWindows) return taskWindows.action(name, hwnd);
  if (linuxTasks) return linuxTasks.action(name, hwnd);
  return false;
});
// Linux dock helper (GNOME Shell extension) status and install.
ipcMain.handle('tasks:source', () => (linuxTasks ? linuxTasks.status() : { source: process.platform === 'win32' ? 'win32' : 'none' }));
ipcMain.handle('tasks:install-helper', async () => {
  if (!linuxTasks) return { ok: false, error: 'Linux only' };
  const from = app.isPackaged
    ? path.join(process.resourcesPath, 'gnome-extension', require('./tasks-linux').EXT_UUID)
    : path.join(__dirname, '..', '..', 'linux', 'gnome-extension', require('./tasks-linux').EXT_UUID);
  return linuxTasks.installHelper(from);
});
ipcMain.handle('tasks:icon', async (_e, exe) => {
  if (typeof exe !== 'string' || !exe) return null;
  const key = exe.toLowerCase();
  if (taskIconCache.has(key)) return taskIconCache.get(key);
  let url = null;
  if (linuxTasks && exe.endsWith('.desktop')) {
    url = linuxTasks.icon(exe);
  } else {
    try {
      const img = await app.getFileIcon(exe, { size: 'normal' });
      url = img.isEmpty() ? null : img.toDataURL();
    } catch { /* missing or protected binary */ }
  }
  if (taskIconCache.size > 200) taskIconCache.clear();
  taskIconCache.set(key, url);
  return url;
});
// Launch a pinned app that is not running. Only executables the dock knows
// about (a stored pin, or a window the worker reported) are launchable.
function dockKnowsExe(exe) {
  if (typeof exe !== 'string') return false;
  if (process.platform === 'linux' ? !/\.desktop$/i.test(exe) : !/\.exe$/i.test(exe)) return false;
  const pinned = (store.get('appDock') || {}).pinned || [];
  return isPinned(pinned, exe) || lastDockExes.has(exe.toLowerCase());
}
let lastDockExes = new Set();

ipcMain.handle('notifications:capture', (_e, on) => {
  if (!linuxNotify) return { supported: false };
  if (on) linuxNotify.start(); else linuxNotify.stop();
  return { supported: true, ...linuxNotify.status() };
});
ipcMain.handle('notifications:capture-status', () => (linuxNotify ? { supported: true, ...linuxNotify.status() } : { supported: false }));
ipcMain.handle('trash:state', () => (trash && (store.get('appDock') || {}).trash !== false ? trash.refresh() : { supported: false }));
ipcMain.handle('trash:open', () => (trash ? trash.open() : false));
ipcMain.handle('trash:put', async (_e, paths) => {
  const list = [].concat(paths || []).map(String).filter((p) => p && path.isAbsolute(p));
  let n = 0;
  for (const p of list) { try { await shell.trashItem(p); n++; } catch { /* in use, or gone */ } }
  if (trash) trash.refresh();
  return n;
});
ipcMain.handle('trash:menu', () => new Promise((resolve) => {
  if (!trash) { resolve(false); return; }
  const st = trash.state();
  const bin = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
  const emptyIt = async () => {
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: [`Empty ${bin}`, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      message: `Permanently delete ${st.count === 1 ? 'the item' : st.count ? `all ${st.count} items` : 'everything'} in the ${bin}?`,
      detail: 'This cannot be undone.'
    });
    if (r.response === 0) await trash.empty();
  };
  Menu.buildFromTemplate([
    { label: st.count === null ? bin : st.empty ? `${bin} is empty` : `${bin}: ${st.count} item${st.count === 1 ? '' : 's'}`, enabled: false },
    { type: 'separator' },
    { label: `Open ${bin}`, click: () => trash.open() },
    { label: `Empty ${bin}…`, enabled: !st.empty, click: () => { emptyIt(); } }
  ]).popup({ window: win, callback: () => resolve(true) });
}));
ipcMain.handle('trash:enable', (_e, on) => {
  if (!trash) return { supported: false };
  if (on) trash.start(); else trash.stop();
  return on ? trash.refresh() : { supported: false };
});
ipcMain.handle('uac:state', () => (uacMonitor && (store.get('appDock') || {}).uacShield !== false ? uacMonitor.state() : { supported: false }));
ipcMain.handle('uac:enable', (_e, on) => {
  if (!uacMonitor) return { supported: false };
  if (on) uacMonitor.start(); else uacMonitor.stop();
  return on ? uacMonitor.state() : { supported: false };
});
// The shield's menu: status, bring a held-back prompt forward, the level.
// Left-click the shield: a prompt is waiting off screen -> bring it up;
// otherwise the menu. Polls first, so a prompt from a second ago counts.
ipcMain.handle('uac:click', async () => {
  if (!uacMonitor) return false;
  uacMonitor.polling = false;
  await uacMonitor.poll();
  const st = uacMonitor.state();
  if (st.waiting && await uacMonitor.bringForward()) return 'shown';
  return 'menu';
});
ipcMain.handle('uac:menu', async () => {
  if (!uacMonitor) return false;
  await uacMonitor.refreshLevel();
  const st = uacMonitor.state();
  const { LEVELS } = require('./uac');
  const status = st.busy ? 'Waiting for you to approve the change…'
    : st.waiting ? 'A UAC prompt is waiting' : st.open ? 'A UAC prompt is open' : `UAC: ${st.levelLabel}`;
  const tell = (title, body) => { if (notifyCenter) notifyCenter.add({ source: 'system', title, body, toast: true }); };
  const template = [
    { label: status, enabled: false },
    ...(st.waiting ? [{ label: 'Show the waiting prompt', click: () => uacMonitor.bringForward() }] : []),
    { type: 'separator' },
    { label: 'Prompt level (changing it asks for approval)', enabled: false },
    ...Object.entries(LEVELS).map(([id, L]) => ({
      label: L.label, type: 'radio', checked: st.level === id, enabled: !st.busy,
      click: () => {
        if (st.level === id) return;
        uacMonitor.setLevel(id).then((r) => {
          if (r.ok) tell('UAC level changed', `${L.label}.`);
          else if (!r.cancelled) tell('UAC level not changed', r.error || 'Windows did not apply the change.');
        });
      }
    })),
    { type: 'separator' },
    { label: 'Open Windows UAC settings…', click: () => { require('child_process').spawn('UserAccountControlSettings.exe', [], { detached: true, stdio: 'ignore' }).unref(); } }
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
  return true;
});

ipcMain.handle('tasks:list', async () => {
  const list = taskWindows ? await taskWindows.list()
    : linuxTasks ? await linuxTasks.list() : [];
  lastDockExes = new Set(list.map((w) => (w.exe || '').toLowerCase()).filter(Boolean));
  return list;
});

ipcMain.handle('dock:launch', (_e, exe) => {
  if (!dockKnowsExe(exe)) return false;
  try { require('./recent').recordLaunch(store, String(exe || '')); } catch { /* not important */ }
  if (linuxTasks) return linuxTasks.launch(exe);
  try { return spawnDetached(exe); } catch { return false; }
});

function spawnDetached(exe) {
  if (!require('fs').existsSync(exe)) return false;
  // ShellExecute semantics, not a raw CreateProcess: Windows 11 system apps
  // (Notepad, Paint, ...) are trampolines to Store packages and exit silently
  // when spawned directly; openPath resolves them the way double-clicking does.
  shell.openPath(exe).then((err) => {
    if (err) console.warn(`dock launch failed for ${exe}: ${err}`);
  });
  return true;
}

// The dock tile's right-click menu: the app's windows, pin control, launch,
// and bulk window management - the taskbar replacement surface.
ipcMain.handle('dock:menu', (_e, tile) => new Promise((resolve) => {
  if (!tile || typeof tile !== 'object') { resolve(null); return; }
  const windows = (Array.isArray(tile.windows) ? tile.windows : []).slice(0, 12)
    .map((w) => ({ hwnd: Number(w.hwnd), title: String(w.title || '').slice(0, 60), min: !!w.min }))
    .filter((w) => Number.isSafeInteger(w.hwnd) && w.hwnd > 0);
  const exe = typeof tile.exe === 'string' ? tile.exe : null;
  const name = String(tile.name || '').slice(0, 40) || 'App';
  const pinned = (store.get('appDock') || {}).pinned || [];
  const done = (r) => resolve(r);

  const template = [{ label: name, enabled: false }, { type: 'separator' }];
  for (const w of windows) {
    template.push({
      label: (w.min ? '  ' : '') + w.title,
      click: () => { taskWindows && taskWindows.action('activate', w.hwnd); done('activate'); }
    });
  }
  if (windows.length) template.push({ type: 'separator' });
  if (exe && dockKnowsExe(exe)) {
    template.push({
      label: windows.length ? 'New window' : `Open ${name}`,
      click: () => { try { spawnDetached(exe); } catch { /* gone */ } done('launch'); }
    });
  }
  if (exe) {
    template.push({
      label: isPinned(pinned, exe) ? 'Unpin from dock' : 'Pin to dock',
      click: () => {
        const dock = store.get('appDock') || {};
        dock.pinned = togglePinned(dock.pinned || [], exe, name);
        store.get().appDock = dock;
        store.save();
        if (win) sendSettings();
        done('pin');
      }
    });
  }
  if (windows.length) {
    template.push({ type: 'separator' });
    template.push({
      label: 'Minimize all',
      click: () => { for (const w of windows) taskWindows && taskWindows.action('minimize', w.hwnd); done('minimize-all'); }
    });
    template.push({
      label: windows.length > 1 ? `Close all ${windows.length} windows` : 'Close window',
      click: () => { for (const w of windows) taskWindows && taskWindows.action('close', w.hwnd); done('close-all'); }
    });
  }
  Menu.buildFromTemplate(template).popup({ window: win, callback: () => done(null) });
}));

// Save the scratchpad to a file of the user's choosing. The renderer sends the
// live textarea text so nothing is lost to the store's debounce.
// The user clicked Proceed on a certificate gate: pin this exact certificate.
ipcMain.handle('certs:trust', (_e, host, fingerprint) => {
  if (typeof host !== 'string' || !/^[a-z0-9.\-]+:\d+$/i.test(host)) return listCertTrust();
  if (typeof fingerprint !== 'string' || !/^sha256\//.test(fingerprint)) return listCertTrust();
  const trust = { ...(store.get('certTrust') || {}) };
  trust[host] = fingerprint;
  store.get().certTrust = trust;   // assign: merge could never replace a changed pin
  store.save();
  return listCertTrust();
});
ipcMain.handle('certs:revoke', (_e, host) => {
  const trust = { ...(store.get('certTrust') || {}) };
  delete trust[host];
  store.get().certTrust = trust;
  store.save();
  return listCertTrust();
});
ipcMain.handle('certs:list', () => listCertTrust());

function listCertTrust() {
  const trust = store.get('certTrust') || {};
  return Object.entries(trust).map(([host, fingerprint]) => ({ host, fingerprint }));
}

// Export / import the whole settings file (layout included) as a plain JSON
// save file the user owns.
// ---------------------------------------------------------------- Updates
const UPDATE_REPO = updater.repoSlug(require('../../package.json').repository);

// The installed Windows build can replace itself: electron-updater downloads
// the new installer in the background, verifies its hash against latest.yml
// on the release, and reruns it silently. Portable exes and the Linux tarball
// have nothing to overwrite in place, so they fall back to a notification.
function canAutoUpdate() {
  return process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
}

let autoUpdaterReady = null;
function getAutoUpdater() {
  if (autoUpdaterReady) return autoUpdaterReady;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  const push = (status) => {
    lastUpdateStatus = { ...status, checkedAt: Date.now(), repo: UPDATE_REPO };
    if (win) win.webContents.send('updates:status', lastUpdateStatus);
  };
  autoUpdater.on('checking-for-update', () => push({ state: 'checking' }));
  autoUpdater.on('update-not-available', (info) => push({
    state: 'current', release: info && { version: `v${info.version}` }
  }));
  autoUpdater.on('update-available', (info) => push({
    state: 'downloading', release: { version: `v${info.version}` }, percent: 0
  }));
  let lastPct = -1;
  autoUpdater.on('download-progress', (pr) => {
    const pct = Math.floor(pr.percent);
    if (pct !== lastPct) { lastPct = pct; push({ ...lastUpdateStatus, state: 'downloading', percent: pct }); }
  });
  autoUpdater.on('update-downloaded', (info) => {
    push({ state: 'restarting', release: { version: `v${info.version}` } });
    if (notifyCenter) notifyCenter.add({ source: 'system', title: `Updating to v${info.version}`, body: 'Installing and restarting...', toast: false });
    if (SysNotification.isSupported()) {
      new SysNotification({
        title: `Updating BE-Aero Desktop to v${info.version}`,
        body: 'Installing and restarting...',
        icon: loadIcon()
      }).show();
    }
    // The close handler hides instead of quitting unless isQuitting is set,
    // which would strand the installer waiting on a window that never closes.
    setTimeout(() => { isQuitting = true; autoUpdater.quitAndInstall(true, true); }, 1500);
  });
  autoUpdater.on('error', (err) => push({ state: 'error', message: String(err && err.message || err) }));
  autoUpdaterReady = autoUpdater;
  return autoUpdater;
}

async function runUpdateCheck({ manual = false } = {}) {
  const u0 = store.get('updates') || {};
  if (u0.auto !== false && canAutoUpdate()) {
    try {
      await getAutoUpdater().checkForUpdates();
      return lastUpdateStatus;
    } catch (err) {
      // Feed trouble (offline, no latest.yml on the release): fall through to
      // the plain API check so the user still gets an answer.
      lastUpdateStatus = { state: 'error', message: String(err && err.message || err), checkedAt: Date.now(), repo: UPDATE_REPO };
      if (win) win.webContents.send('updates:status', lastUpdateStatus);
    }
  }

  const result = await updater.checkLatest(UPDATE_REPO, app.getVersion());
  lastUpdateStatus = { ...result, checkedAt: Date.now(), repo: UPDATE_REPO };
  if (win) win.webContents.send('updates:status', lastUpdateStatus);

  if (result.state === 'update') {
    const u = store.get('updates') || {};
    const alreadyTold = u.notifiedVersion === result.release.version;
    if ((manual || (u.notify && !alreadyTold)) && SysNotification.isSupported()) {
      const n = new SysNotification({
        title: `BE-Aero Desktop ${result.release.version} is available`,
        ...(notifyCenter && notifyCenter.add({ source: 'system', title: `${result.release.version} is available`, body: 'Open the release page to download it.', url: result.release.url, toast: false }) ? {} : {}),
        body: 'Click to open the release page and download it.',
        icon: loadIcon()
      });
      n.on('click', () => shell.openExternal(result.release.url));
      n.show();
      store.set({ updates: { notifiedVersion: result.release.version } });
    }
  }
  return lastUpdateStatus;
}

ipcMain.handle('updates:check', () => runUpdateCheck({ manual: true }));
ipcMain.handle('updates:status', () => lastUpdateStatus);
ipcMain.handle('updates:open', () => {
  if (lastUpdateStatus.release) shell.openExternal(lastUpdateStatus.release.url);
});

ipcMain.handle('settings:export', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export BE-Aero Desktop settings',
    defaultPath: path.join(app.getPath('documents'), 'be-aero-settings.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { saved: false };
  try {
    require('fs').writeFileSync(filePath, JSON.stringify(store.get(), null, 2), 'utf8');
    return { saved: true, filePath };
  } catch (err) { return { saved: false, error: err.message }; }
});

ipcMain.handle('settings:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import BE-Aero Desktop settings',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths || !filePaths[0]) return { imported: false };
  try {
    const raw = JSON.parse(require('fs').readFileSync(filePaths[0], 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { imported: false, error: 'not a settings file' };
    }
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Import settings',
      message: 'Replace all current settings with this file?',
      detail: 'Layout, pins, themes, trusted certificates and paired apps are replaced. The app restarts afterwards.',
      buttons: ['Replace and restart', 'Cancel'],
      defaultId: 1, cancelId: 1, noLink: true
    });
    if (response !== 0) return { imported: false };
    store.replaceAll(raw);
    store.flush();
    app.relaunch();
    app.exit(0);
    return { imported: true };
  } catch (err) { return { imported: false, error: err.message }; }
});

ipcMain.handle('scratchpad:save-as', async (_e, text) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save note',
    defaultPath: path.join(app.getPath('documents'), 'note.md'),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (canceled || !filePath) return { saved: false };
  try {
    require('fs').writeFileSync(filePath, String(text ?? ''), 'utf8');
    return { saved: true, filePath };
  } catch (err) {
    return { saved: false, error: err.message };
  }
});

ipcMain.on('window:ignore-mouse', (_e, ignore) => {
  // With a shaped input region the shape already decides who gets clicks.
  if (linuxShapeInput()) return;
  setIgnoreMouse(ignore);
});
ipcMain.on('window:hide', () => { if (win) { win.hide(); rebuildTrayMenu(); } });
ipcMain.on('app:quit', () => { isQuitting = true; app.quit(); });
ipcMain.on('search:open', (_e, q) => { if (spotlight) spotlight.show(typeof q === 'string' ? q : ''); });
ipcMain.handle('search:hotkey', () => (spotlight ? spotlight.hotkey : null));
ipcMain.on('shell:open', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

// ---------------------------------------------------------------- Lifecycle
// Links a widget page opens (target=_blank and friends) belong in the real
// browser, never in a new app window.
// Right-click menu for any page we host (the sidebar's own inputs and the
// web widgets): spelling suggestions first, then the usual edit verbs, link
// and image actions, and navigation for guests.
function showContextMenu(contents, params, isGuest) {
  const tpl = [];
  if (params.misspelledWord) {
    for (const sgg of (params.dictionarySuggestions || []).slice(0, 6)) {
      tpl.push({ label: sgg, click: () => contents.replaceMisspelling(sgg) });
    }
    if (!params.dictionarySuggestions || !params.dictionarySuggestions.length) tpl.push({ label: 'No suggestions', enabled: false });
    tpl.push({ label: 'Add to dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    tpl.push({ type: 'separator' });
  }
  if (params.isEditable) {
    tpl.push({ label: 'Undo', role: 'undo' }, { label: 'Redo', role: 'redo' }, { type: 'separator' },
      { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut }, { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }, { label: 'Select all', role: 'selectAll' });
  } else if (params.selectionText) {
    tpl.push({ label: 'Copy', role: 'copy' });
    tpl.push({ label: `Search the web for “${params.selectionText.trim().slice(0, 30)}${params.selectionText.trim().length > 30 ? '…' : ''}”`,
      click: () => shell.openExternal(require('./spotlight').webSearchUrl((store.get('search') || {}).webEngine, params.selectionText.trim())) });
  }
  if (params.linkURL) {
    if (tpl.length) tpl.push({ type: 'separator' });
    tpl.push({ label: 'Open link in browser', click: () => shell.openExternal(params.linkURL) });
    tpl.push({ label: 'Copy link address', click: () => require('electron').clipboard.writeText(params.linkURL) });
  }
  if (params.hasImageContents && params.srcURL) {
    if (tpl.length) tpl.push({ type: 'separator' });
    tpl.push({ label: 'Copy image address', click: () => require('electron').clipboard.writeText(params.srcURL) });
    tpl.push({ label: 'Open image in browser', click: () => shell.openExternal(params.srcURL) });
  }
  if (isGuest) {
    if (tpl.length) tpl.push({ type: 'separator' });
    tpl.push({ label: 'Back', enabled: contents.navigationHistory ? contents.navigationHistory.canGoBack() : contents.canGoBack(), click: () => (contents.navigationHistory ? contents.navigationHistory.goBack() : contents.goBack()) });
    tpl.push({ label: 'Forward', enabled: contents.navigationHistory ? contents.navigationHistory.canGoForward() : contents.canGoForward(), click: () => (contents.navigationHistory ? contents.navigationHistory.goForward() : contents.goForward()) });
    tpl.push({ label: 'Reload', click: () => contents.reload() });
    tpl.push({ label: 'Open page in browser', click: () => shell.openExternal(contents.getURL()) });
  }
  if (!tpl.length) return;
  Menu.buildFromTemplate(tpl).popup({ window: win || undefined });
}

function applySpellcheck() {
  const sc = store.get('spellcheck') || {};
  const langs = Array.isArray(sc.languages) && sc.languages.length ? sc.languages : [app.getLocale() || 'en-US'];
  for (const ses of [session.defaultSession, session.fromPartition('persist:webwidgets')]) {
    try {
      ses.setSpellCheckerEnabled(sc.enabled !== false);
      if (process.platform !== 'darwin') ses.setSpellCheckerLanguages(langs.filter((l) => ses.availableSpellCheckerLanguages.includes(l)).length ? langs.filter((l) => ses.availableSpellCheckerLanguages.includes(l)) : ['en-US']);
    } catch (err) { console.warn('spellcheck setup:', err.message); }
  }
}

app.on('web-contents-created', (_e, contents) => {
  const isGuest = contents.getType() === 'webview';
  contents.on('context-menu', (_ev, params) => showContextMenu(contents, params, isGuest));
  if (!isGuest) return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

// Self-signed certificates are handled the way a browser handles them: the
// first time a web widget hits one, the pane shows a gated warning with the
// certificate's details, and only an explicit "Proceed" pins that EXACT
// certificate (host:port -> fingerprint) in settings. A later fingerprint
// change at the same host blocks again with a sterner warning. Nothing the
// app itself fetches (weather, geocoding, plugins) is ever exempted.
app.on('certificate-error', (event, _webContents, url, error, certificate, callback) => {
  const key = hostKey(url);
  if (!key || !store) { callback(false); return; }

  const trust = store.get('certTrust') || {};
  const fingerprint = certificate ? certificate.fingerprint : null;
  if (fingerprint && trust[key] === fingerprint) {
    event.preventDefault();
    callback(true);
    return;
  }

  callback(false);
  // Raise the gate only for addresses the user added as web widgets.
  const widgets = store.get('webWidgets') || [];
  if (win && widgets.some((w) => w && w.url && sameSite(w.url, url))) {
    win.webContents.send('webwidget:cert', {
      url,
      host: key,
      error: String(error || ''),
      fingerprint,
      subject: certificate ? certificate.subjectName : '',
      issuer: certificate ? certificate.issuerName : '',
      expiry: certificate && certificate.validExpiry ? certificate.validExpiry * 1000 : null,
      changed: !!(trust[key] && fingerprint && trust[key] !== fingerprint)
    });
  }
});

// One-time migration from the app's previous identity: productName moved from
// "Aero Widgets" to "BE-Aero Desktop", which moves the userData folder - and
// with it settings, pinned apps, paired API apps, plugins and the web
// widgets' login partition. Copy them forward the first time the new name
// boots so nobody loses their setup to a rename.
function migrateFromAeroWidgets() {
  const fs = require('fs');
  const newDir = app.getPath('userData');
  const oldDir = path.join(path.dirname(newDir), 'Aero Widgets');
  try {
    if (fs.existsSync(path.join(newDir, 'settings.json'))) return;   // already migrated or fresh new-name install
    if (!fs.existsSync(path.join(oldDir, 'settings.json'))) return;  // nothing to migrate
    for (const item of ['settings.json', 'plugins', 'Partitions']) {
      const from = path.join(oldDir, item);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(newDir, item), { recursive: true });
    }
    console.log(`Migrated settings from "${oldDir}"`);
  } catch (err) {
    console.warn('Migration from Aero Widgets failed (starting fresh):', err.message);
  }
}

app.whenReady().then(() => {
  if (DOCTOR) return; // the diagnostics handler owns this run
  if (process.platform === 'linux') {
    // One greppable line saying what the app decided about this session.
    console.log(`[linux] session=${process.env.XDG_SESSION_TYPE || '?'} desktop=${process.env.XDG_CURRENT_DESKTOP || '?'} ozone=${OZONE_X11 ? 'x11(argv)' : 'default'} (run --doctor for the full report)`);
  }
  migrateFromAeroWidgets();
  store = new Store();

  // The layout and every other preference live in settings.json under the
  // user profile - app updates never touch it. On each healthy start, keep a
  // backup copy beside it so a corrupted write can never cost the layout.
  try {
    require('fs').writeFileSync(
      path.join(app.getPath('userData'), 'settings.backup.json'),
      JSON.stringify(store.get(), null, 2), 'utf8');
  } catch (err) { console.warn('settings backup failed:', err.message); }
  createWindow();
  createTray();
  startTelemetry();
  // Heal launch-at-startup on every boot: the registered path rots whenever
  // the exe moves (reinstall, rename, dev->installed), so re-assert it and
  // drop any stale entries instead of trusting a one-time registration.
  setLaunchAtStartup();
  globalShortcut.register(TOGGLE_SHORTCUT, toggleWindow);
  spotlight = new Spotlight({ store, root: ROOT });
  spotlight.init();
  applyDockHotkey((store.get('appDock') || {}).hotkey);
  { const vh = ((store.get('ai') || {}).voice || {}).hotkey; applyVoiceHotkey(vh === undefined ? 'Control+Alt+M' : vh); }

  PLUGINS_DIR = path.join(app.getPath('userData'), 'plugins');
  require('fs').mkdirSync(PLUGINS_DIR, { recursive: true });
  panes = new PaneRegistry({ onChange: broadcastPanes });
  // Peer identity and the window worker speak Win32; on other platforms the
  // API runs without binary binding and the dock shows only parked widgets.
  if (process.platform === 'win32') peerResolver = new PeerResolver();
  apiServer = new ApiServer({
    panes,
    store,
    userDataDir: app.getPath('userData'),
    getTelemetry: () => telemetry.sample(telemetryOpts()),
    onPair: confirmPairing,
    onAppsChanged: () => broadcastApi(),
    peer: peerResolver,
    onLog: (msg) => console.log(`[api] ${msg}`)
  });
  registerPluginProtocol();
  // aero-visual://<id>/ - an assistant visual, with its locked-down CSP.
  protocol.handle('aero-visual', (request) => {
    const id = new URL(request.url).hostname;
    const page = aiService && aiService.visuals ? aiService.visuals.page(id) : null;
    if (!page) return new Response('no such visual', { status: 404 });
    const { VISUAL_CSP } = require('./ai/visuals');
    return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': VISUAL_CSP, 'cache-control': 'no-store' } });
  });
  // aero-widget://<id>/ - an AI widget, with a CSP that opens only the
  // sites the user approved for it.
  protocol.handle('aero-widget', (request) => {
    const u = new URL(request.url);
    const id = u.hostname;
    const w = aiService && aiService.widgets;
    // Its own files (a stylesheet, images) - same CSP, from its folder only.
    if (w && u.pathname && u.pathname !== '/' && !/^\/index\.html?$/i.test(u.pathname)) {
      const file = w.asset(id, u.pathname);
      if (!file) return new Response('not found', { status: 404 });
      const ext = path.extname(file).toLowerCase();
      const type = PLUGIN_MIME[ext] || 'application/octet-stream';
      return new Response(require('fs').readFileSync(file), { headers: { 'content-type': type, 'content-security-policy': w.csp(id), 'cache-control': 'no-store' } });
    }
    const page = w ? w.page(id) : null;
    if (!page) return new Response('no such widget', { status: 404 });
    return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': w.csp(id), 'cache-control': 'no-store' } });
  });
  refreshPlugins();
  startApi();

  if (process.platform === 'win32') taskWindows = new TaskWindows({ ownExePath: process.execPath });
  // UAC shield: prompt status and the prompt level, for the dock tile.
  if (taskWindows) {
    uacMonitor = new (require('./uac').UacMonitor)({
      taskWindows,
      onChange: (st) => { if (win && !win.isDestroyed()) win.webContents.send('uac:update', st); }
    });
    if ((store.get('appDock') || {}).uacShield !== false) uacMonitor.start();
  }
  // Recycle Bin / Trash tile on the dock.
  trash = new (require('./trash').Trash)({
    tw: taskWindows,
    onChange: (st) => { if (win && !win.isDestroyed()) win.webContents.send('trash:update', st); }
  });
  if ((store.get('appDock') || {}).trash !== false) trash.start();
  // Linux cannot list other apps' windows (Wayland policy), but /proc shows
  // which applications RUN - the dock mirrors that instead.
  if (process.platform === 'linux') linuxTasks = new (require('./tasks-linux').LinuxTasks)();

  // Notification center + AI assistant. Both lean on the window, store,
  // spotlight and task source, so they come last.
  notifyCenter = new (require('./notifications').NotificationCenter)({
    file: path.join(app.getPath('userData'), 'notifications.json'),
    getWindow: () => win,
    openApp: (launch) => openNotificationApp(launch),
    toast: (title, body, onClick) => {
      if (!(store.get('notifications') || {}).toast || !SysNotification.isSupported()) return;
      const n = new SysNotification({ title, body, icon: loadIcon() });
      n.on('click', onClick);
      n.show();
    }
  });
  // Linux: every app's desktop notifications, mirrored into the center
  // (read-only bus monitor; the desktop still shows its own popups).
  if (process.platform === 'linux') {
    linuxNotify = new (require('./linux-notifications').LinuxNotificationWatcher)({
      onNotification: (n) => { if (notifyCenter) notifyCenter.add({ source: 'os', sourceName: n.app || 'An app', title: n.title || n.app || 'Notification', body: n.body, toast: false, launch: { appId: n.appId || '', name: n.app || '' } }); },
      log: (m) => console.log('[notifications]', m)
    });
    if ((store.get('notifications') || {}).captureSystem !== false) linuxNotify.start();
  }
  // Windows: other apps' toasts, read from Windows' own notification list
  // (read-only; Windows still shows its pop-ups). Same switch as Linux.
  if (process.platform === 'win32') {
    linuxNotify = new (require('./win-notifications').WinNotificationWatcher)({
      ownIds: ['com.beaero.desktop'],
      nameFor: (id) => { const e = spotlight && spotlight.index.entries.find((x) => x.aumid && x.aumid.toLowerCase() === String(id).toLowerCase()); return e ? e.name : null; },
      onNotification: (n) => { if (notifyCenter) notifyCenter.add({ source: 'os', sourceName: n.app || 'An app', title: n.title || n.app || 'Notification', body: n.body, toast: false, launch: { aumid: n.appId || '', uri: n.uri || '', name: n.app || '' } }); },
      log: (m) => console.log('[notifications]', m)
    });
    if ((store.get('notifications') || {}).captureSystem !== false) linuxNotify.start();
  }
  ipcMain.handle('notifications:list', () => notifyCenter.list());
  ipcMain.handle('notifications:read', (_e, id) => notifyCenter.markRead(id || null));
  ipcMain.handle('notifications:remove', (_e, id) => notifyCenter.remove(id));
  ipcMain.handle('notifications:clear', () => notifyCenter.clear());
  ipcMain.handle('notifications:open', (_e, id) => notifyCenter.open(id));
  ipcMain.on('notifications:from-web', (_e, { id, name, title, body, icon }) => {
    notifyCenter.add({ source: 'web', sourceId: String(id || ''), sourceName: String(name || ''), title, body, icon });
  });

  // OS-wide media controller (widget + AI tools) and offline voice input.
  mediaCtl = new (require('./media').MediaController)();
  // Media and the sound mixer, here or on another of my devices (dev = its id).
  const remoteThumbs = new Map();     // device id -> { key, thumb }: album art is sent once
  ipcMain.handle('media:devices', () => controlDevices());
  ipcMain.handle('media:info', async (_e, dev) => {
    if (!dev) return mediaCtl.info();
    try {
      const memo = remoteThumbs.get(dev) || {};
      const r = await meshCall(String(dev), 'media.info', { thumbKey: memo.key || '' }, 8000);
      if (r && r.thumbSame) r.thumb = memo.thumb || '';
      else if (r) remoteThumbs.set(dev, { key: r.thumbKey || '', thumb: r.thumb || '' });
      return r;
    } catch (err) { return { available: false, status: 'none', remote: true, hint: String(err && err.message || err) }; }
  });
  ipcMain.handle('media:action', (_e, name, dev) => (dev ? meshCall(String(dev), 'media.action', { name: String(name || '') }).catch(() => false) : mediaCtl.action(String(name || ''))));
  ipcMain.handle('media:seek', (_e, seconds, dev) => (dev ? meshCall(String(dev), 'media.seek', { seconds: Number(seconds) }).catch(() => false) : mediaCtl.seek(Number(seconds))));
  whisper = new (require('./whisper').Whisper)({ dir: path.join(app.getPath('userData'), 'whisper') });
  piper = new (require('./piper').Piper)({ dir: path.join(app.getPath('userData'), 'piper') });
  voice = new (require('./voice').Voice)({
    emit: (ev) => { if (win && !win.isDestroyed()) win.webContents.send('ai:voice', ev); },
    whisper,
    piper,
    settings: () => ((store.get('ai') || {}).voice || {})
  });
  ipcMain.handle('ai:whisper-status', () => whisper.status());
  ipcMain.handle('ai:whisper-install', async (_e, model) => {
    try {
      return await whisper.install(String(model || 'base.en'), (p) => { if (win && !win.isDestroyed()) win.webContents.send('ai:whisper-progress', p); });
    } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('ai:whisper-remove', (_e, model) => whisper.removeModel(String(model || '')));
  ipcMain.handle('ai:piper-status', () => piper.status());
  ipcMain.handle('ai:piper-catalog', () => piper.catalog());
  ipcMain.handle('ai:piper-install', async (_e, key) => {
    try {
      return await piper.install(key ? String(key) : null, (p) => { if (win && !win.isDestroyed()) win.webContents.send('ai:piper-progress', p); });
    } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('ai:piper-remove', (_e, key) => piper.removeVoice(String(key || '')));
  ipcMain.handle('ai:voice-available', () => voice.available());
  ipcMain.handle('ai:voice-start', () => voice.start());
  ipcMain.handle('ai:voice-stop', () => voice.stop());
  ipcMain.on('ai:voice-feed', (_e, bytes) => { if (bytes && bytes.byteLength) voice.feed(Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength)); });
  ipcMain.handle('ai:voice-voices', () => voice.voices());
  ipcMain.handle('ai:voice-speak', async (_e, text, opts) => {
    try { return await voice.speak(String(text || ''), opts || {}); } catch (err) { return { error: err.message }; }
  });

  // File browser + File Pool (src/main/files.js).
  const smbService = new (require('./smb').SmbService)();
  // Other devices' shared folders (step 3): served and browsed over the mesh.
  const remoteFiles = new (require('./remote-files').RemoteFiles)({
    getMesh: () => (deviceService && deviceService.mesh) || null,
    poolDir: () => fileService.poolDir(),
    cacheDir: path.join(app.getPath('userData'), 'remote-cache'),
    shareStore: { get: (peerId) => { const m = deviceService && deviceService.mesh; const p = m && m.peers.get(peerId); return (p && p.shares) || []; } }
  });
  const fileService = new (require('./files').FileService)({ getPath: (n) => app.getPath(n), store, shell, nativeImage, smb: smbService, remote: remoteFiles });
  const fileCall = (fn) => async (...args) => { try { return { ok: true, result: await fn(...args) }; } catch (err) { return { error: String(err && err.message || err) }; } };
  ipcMain.handle('files:places', fileCall(() => fileService.places()));
  ipcMain.handle('files:search-remote', fileCall((_e, q) => (String(q || '').trim().length < 2 ? [] : remoteFiles.search(String(q).trim()))));
  ipcMain.handle('files:list', async (_e, dir) => {
    try { return { ok: true, result: await fileService.list(dir) }; } catch (err) {
      return { error: String(err && err.message || err), needsConnect: err && err.code === 'NEEDS_CONNECT' };
    }
  });
  ipcMain.handle('files:open', fileCall(async (_e, p) => { const err = await fileService.open(p); if (err) throw new Error(err); return true; }));
  ipcMain.handle('files:reveal', fileCall((_e, p) => fileService.reveal(p)));
  ipcMain.handle('files:mkdir', fileCall((_e, dir, name) => fileService.mkdir(dir, name)));
  ipcMain.handle('files:rename', fileCall((_e, p, name) => fileService.rename(p, name)));
  ipcMain.handle('files:trash', fileCall((_e, paths) => fileService.trash(paths)));
  ipcMain.handle('files:transfer', fileCall((_e, paths, dest, move) => fileService.transfer(paths, dest, { move: !!move })));
  // Copy / move jobs with progress, pause, resume and stop (transfers.js).
  const transfers = new (require('./transfers').Transfers)({
    remote: remoteFiles,
    trash: (p) => shell.trashItem(p),
    onChange: (list) => {
      for (const w of [win, ...filesWindows]) if (w && !w.isDestroyed()) w.webContents.send('transfers:update', list);
    }
  });
  ipcMain.handle('transfers:start', fileCall((_e, paths, dest, move) => transfers.start(paths, dest, { move: !!move })));
  ipcMain.handle('transfers:list', () => transfers.list());
  ipcMain.handle('transfers:pause', (_e, id) => transfers.pause(String(id)));
  ipcMain.handle('transfers:resume', (_e, id) => transfers.resume(String(id)));
  ipcMain.handle('transfers:cancel', (_e, id) => transfers.cancel(String(id)));
  ipcMain.handle('transfers:clear', (_e, id) => transfers.clear(String(id)));
  ipcMain.handle('files:to-pool', fileCall(async (_e, paths) => fileService.transfer(paths, await fileService.ensurePool())));
  ipcMain.handle('files:preview', fileCall((_e, p) => fileService.preview(p)));
  ipcMain.handle('files:icon', async (_e, p, size) => fileService.icon(p, size));
  ipcMain.handle('files:pool', fileCall(() => fileService.ensurePool()));
  // The folder the file browser shows is watched; any change (made here,
  // by another app, or by File Pool sync) refreshes it.
  // One watch per window (the desktop's widget and each file browser window).
  const viewWatches = new Map();   // webContents id -> { watch, timer }
  ipcMain.handle('files:watch', (e, dir) => {
    const wc = e.sender;
    const old = viewWatches.get(wc.id);
    if (old) { clearTimeout(old.timer); try { old.watch.close(); } catch { /* closed */ } viewWatches.delete(wc.id); }
    else wc.once('destroyed', () => { const v = viewWatches.get(wc.id); if (v) { try { v.watch.close(); } catch { /* */ } viewWatches.delete(wc.id); } });
    const d = String(dir || '');
    if (!d || /^(\\\\|smb:|aero:)/i.test(d)) return false;        // network and device folders: no watching
    try {
      const v = { watch: null, timer: null };
      v.watch = require('fs').watch(d, () => {
        clearTimeout(v.timer);
        v.timer = setTimeout(() => { if (!wc.isDestroyed()) wc.send('files:changed', { dir: d }); }, 300);
      });
      v.watch.on('error', () => { try { v.watch.close(); } catch { /* */ } if (viewWatches.get(wc.id) === v) viewWatches.delete(wc.id); });
      viewWatches.set(wc.id, v);
      return true;
    } catch { return false; }
  });
  ipcMain.handle('files:new-window', (_e, start) => openFilesWindow(start ? String(start) : ''));
  // Search bar drop-down: recent files and recent apps (recent.js).
  const recentService = new (require('./recent').RecentService)({ store, shell, indexEntries: () => (spotlight ? spotlight.index.entries : []) });
  ipcMain.handle('search:recent', async () => { try { return await recentService.recent(); } catch { return { files: [], apps: [] }; } });
  ipcMain.handle('search:recent-icon', async (_e, p, kind) => {
    try {
      if (kind === 'app' && spotlight) { const r = await spotlight.icon(p); if (r) return r; }
      return await fileService.icon(p, 'normal');
    } catch { return null; }
  });
  ipcMain.handle('search:open-recent', async (_e, p, kind) => {
    if (kind === 'app' && spotlight) { await spotlight.open({ path: p, kind: 'app' }); return true; }
    const err = await shell.openPath(String(p || ''));
    return !err;
  });

  // Network drives (SMB): connect / disconnect through the OS (smb.js).
  ipcMain.handle('files:net-connect', fileCall((_e, opts) => smbService.connect(opts || {})));
  ipcMain.handle('files:net-disconnect', fileCall((_e, target) => smbService.disconnect(target)));
  ipcMain.handle('files:net-letters', fileCall(() => smbService.freeLetters()));
  ipcMain.handle('files:net-menu', (_e, place) => new Promise((resolve) => {
    let chosen = null;
    Menu.buildFromTemplate([
      { label: `${(place && place.status) || 'Connected'}: ${(place && place.remote) || ''}`, enabled: false },
      { type: 'separator' },
      { label: 'Disconnect', click: () => { chosen = 'disconnect'; } }
    ]).popup({ window: win, callback: () => setImmediate(() => resolve(chosen)) });
  }));
  // The file browser's search: the same index and ranking as Spotlight,
  // files and folders only.
  ipcMain.handle('files:search', fileCall((_e, q) => {
    const text = String(q || '').trim();
    if (text.length < 2 || !spotlight) return { results: [], indexing: !!(spotlight && !spotlight.index.stats) };
    const { search } = require('./search');
    const entries = spotlight.index.entries.filter((e) => e.kind === 'file' || e.kind === 'folder');
    const r = search(text, entries, { limit: 60, perCategory: 60, launchCounts: (store.get('search') || {}).launchCounts || {} });
    const seen = new Set();
    const flat = (r.groups ? r.groups.flatMap((g) => g.items) : r.results || []).filter((x) => x && x.path && !seen.has(x.path) && seen.add(x.path));
    return { results: flat.slice(0, 60).map((x) => ({ name: x.name, path: x.path, kind: x.kind })), indexing: !spotlight.index.stats };
  }));
  // Right-click menu: native, like the rest of the app. Resolves with the
  // chosen action id (or null), the renderer carries it out.
  // "Shared index": a folder my other devices may search and open (the
  // per-device shares of Settings > Devices > Shared with it).
  const samePath = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
  function shareMenu(dir) {
    if (!dir || /^aero:/i.test(dir) || /^(\\|smb:)/i.test(dir) || !path.isAbsolute(dir)) return [];
    const mesh = deviceService && deviceService.mesh;
    const peers = mesh ? [...mesh.peers.values()].filter((p) => p.role !== 'relay') : [];
    if (!peers.length) return [{ type: 'separator' }, { label: 'Shared index', submenu: [{ label: mesh ? 'No paired devices yet (Settings > Devices)' : 'Turn on device connections in Settings > Devices', enabled: false }] }];
    const has = (p) => (p.shares || []).some((s) => samePath(s.path, dir));
    const set = (p, on) => {
      const rest = (p.shares || []).filter((s) => !samePath(s.path, dir));
      mesh.setShares(p.id, on ? [...rest, { path: dir, name: path.basename(dir) || dir }] : rest);
      remoteFiles.nameIndex.delete(dir);
    };
    const all = peers.every(has);
    return [{ type: 'separator' }, { label: `Shared index${peers.some(has) ? ' ✓' : ''}`, submenu: [
      { label: `${path.basename(dir) || dir} - searchable and openable from:`, enabled: false },
      { type: 'separator' },
      { label: 'All my devices', type: 'checkbox', checked: all, click: () => peers.forEach((p) => set(p, !all)) },
      { type: 'separator' },
      ...peers.map((p) => ({ label: p.label || p.name || p.id.slice(0, 7), type: 'checkbox', checked: has(p), click: () => set(p, !has(p)) }))
    ] }];
  }
  ipcMain.handle('files:menu', (_e, ctx) => new Promise((resolve) => {
    const c = ctx || {};
    const one = c.count === 1;
    let chosen = null;
    const item = (label, id, extra = {}) => ({ label, click: () => { chosen = id; }, ...extra });
    const template = c.count ? [
      item(one && c.dir ? 'Open' : 'Open', 'open'),
      ...(one && c.dir ? [item('Open in new window', 'new-window')] : []),
      item(process.platform === 'win32' ? 'Show in Explorer' : 'Show in Files', 'reveal', { enabled: one && !c.readOnly }),
      { type: 'separator' },
      item('Copy', 'copy'), item('Cut', 'cut'),
      item('Paste here', 'paste', { enabled: !!c.canPaste && one && c.dir }),
      ...(c.inPool ? [] : [item('Copy to File Pool', 'to-pool')]),
      { type: 'separator' },
      item('Rename…', 'rename', { enabled: one && !c.readOnly }),
      item(process.platform === 'win32' ? 'Delete (Recycle Bin)' : 'Move to Trash', 'trash', { enabled: !c.readOnly }),
      { type: 'separator' },
      item('Copy path', 'copy-path', { enabled: one }),
      ...(one && c.html && !c.readOnly ? [item('Create widget', 'html-widget')] : []),
      ...(one && c.dir ? shareMenu(c.path) : [])
    ] : [
      item('New folder', 'mkdir', { enabled: !c.readOnly }),
      item('Paste', 'paste', { enabled: !!c.canPaste }),
      { type: 'separator' },
      item(process.platform === 'win32' ? 'Open in Explorer' : 'Open in Files', 'reveal-here'),
      item('Open in new window', 'new-window-here'),
      item(c.showHidden ? 'Hide hidden files' : 'Show hidden files', 'toggle-hidden'),
      ...shareMenu(c.here)
    ];
    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(_e.sender) || win, callback: () => setImmediate(() => resolve(chosen)) });
  }));
  // Drag files out of the browser into other apps (Explorer, mail, editors).
  ipcMain.on('files:drag', (e, paths) => {
    const list = [].concat(paths || []).filter((p) => typeof p === 'string');
    if (!list.length) return;
    try { e.sender.startDrag({ file: list[0], files: list, icon: nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png')).resize({ width: 32 }) }); } catch { /* drag cancelled */ }
  });
  ipcMain.handle('files:copy-path', (_e, p) => { require('electron').clipboard.writeText(String(p || '')); return true; });
  // An .html file -> a desktop widget (a copy, in AI Folder/AI Widgets).
  ipcMain.handle('files:html-widget', async (_e, p) => {
    try {
      if (!aiService) throw new Error('turn on the AI assistant first (widgets live in its folder)');
      const r = await aiService.widgets.createFromFile(String(p || ''));
      return { ok: true, ...r };
    } catch (err) { return { error: String(err && err.message || err) }; }
  });

  // Devices: identity, pairing and the mesh (src/main/mesh). Off by default.
  // State sync (state-sync.js): notes, theme, pins, synced conversations,
  // tasks and web widgets, the same on every paired device allowing
  // "Synced state". Each category can be turned off in Settings > Devices.
  const syncOn = () => ({ theme: true, notes: false, pins: false, conversations: false, tasks: false, ...((store.get('devices') || {}).sync || {}) });
  const categoryOf = (key) => (key === 'scratchpad' ? 'notes' : key === 'theme' ? 'theme' : key.startsWith('pins:') ? 'pins' : key.startsWith('task:') ? 'tasks' : key.startsWith('conv:') ? 'conversations' : null);
  // A shared web widget syncs what it IS (name and address), never how it
  // sits on this screen (minimized, size, zoom, position).
  const webShared = (w) => ({ id: w.id, name: w.name || '', url: w.url });
  relayClient = new (require('./relay-client').RelayClient)({
    handlers: {
      state: async (data, from, key) => { stateSync.applyIncoming(key, data && data.entry, data && data.value, from.name); },
      bus: async (data, from) => { if (!aiService) throw new Error('the assistant is not running'); await aiService.bus.receive(data && data.msg, from); },
      clipboard: (data, from) => receiveClipboard(data, from),
      widget: (data, from) => receiveWidget(data, from),
      drivekey: (data) => { if (relayDrive) relayDrive.receiveKeys(data && data.keys); }
    },
    log: (m) => console.log('[relay]', m)
  });
  const stateSync = new (require('./state-sync').StateSync)({
    // Changes here, for my devices that are offline but reachable through
    // a relay (the newest version per item waits there).
    onChanged: (items) => {
      const mesh = deviceService && deviceService.mesh;
      if (!mesh || !relayClient) return;
      for (const p of mesh.peers.values()) {
        if (p.role === 'relay' || !(p.perms && p.perms.state) || !relayClient.reachable(p.id)) continue;
        for (const it of items) {
          if (!it.entry) continue;
          relayClient.send(p.id, 'state', it.key, { entry: it.entry, value: it.entry.deleted ? null : it.value }).catch((err) => console.log('[relay] state:', err.message));
        }
      }
    },
    indexFile: path.join(app.getPath('userData'), 'mesh', 'state-index.json'),
    collect: () => {
      // Not before the AI service is up: a scan without its conversations and
      // tasks would read as deletes and remove them on the other devices.
      if (!aiService) throw new Error('not ready');
      const on = syncOn();
      const m = new Map();
      if (on.notes) {
        const list = store.get('scratchNotes');
        m.set('scratchpad', { text: store.get('scratchpad') || '', ...(Array.isArray(list) && list.length > 1 ? { notes: list } : {}) });
      }
      if (on.theme) m.set('theme', store.get('theme') || {});
      if (on.pins) m.set(`pins:${process.platform}`, ((store.get('appDock') || {}).pinned) || []);
      for (const w of store.get('webWidgets') || []) if (w.shared) m.set(`web:${w.id}`, webShared(w));
      if (aiService && on.tasks) for (const t of aiService.syncableTasks()) m.set(`task:${t.id}`, t);
      if (aiService && on.conversations) for (const c of aiService.syncableConversations()) m.set(`conv:${c.id}`, c);
      return m;
    },
    tracked: (key) => {
      if (key.startsWith('web:')) {
        // Shared one at a time: a widget here that is not shared stays out.
        const w = (store.get('webWidgets') || []).find((x) => x.id === key.slice(4));
        return !w || !!w.shared;
      }
      const cat = categoryOf(key);
      if (!cat || !syncOn()[cat]) return false;
      if (key.startsWith('pins:') && key !== `pins:${process.platform}`) return false;       // another OS's pins
      if (key.startsWith('conv:') && aiService && aiService.isLocalConversation(key.slice(5))) return false;
      if (key.startsWith('task:')) { const t = ((store.get('ai') || {}).tasks || []).find((x) => x.id === key.slice(5)); if (t && t.local) return false; }
      return true;
    },
    apply: (key, value, from) => {
      if (key === 'scratchpad') {
        const list = value && Array.isArray(value.notes) && value.notes.length ? value.notes.map(String).slice(0, 200) : null;
        if (list) {
          const i = Math.max(0, Math.min(list.length - 1, Number(store.get('scratchIndex')) || 0));
          updateSettings({ scratchNotes: list, scratchIndex: i, scratchpad: list[i] });
        } else updateSettings({ scratchpad: String((value && value.text) || ''), scratchNotes: [String((value && value.text) || '')], scratchIndex: 0 });
      }
      else if (key === 'theme') updateSettings({ theme: value || {} });
      else if (key === `pins:${process.platform}`) updateSettings({ appDock: { pinned: Array.isArray(value) ? value : [] } });
      else if (key.startsWith('web:')) {
        if (!value || !/^https?:\/\//i.test(String(value.url || ''))) throw new Error('not a web widget');
        const list = (store.get('webWidgets') || []).slice();
        const i = list.findIndex((x) => x.id === value.id);
        const v = { name: String(value.name || '').slice(0, 40), url: String(value.url), shared: true };
        if (i >= 0) list[i] = { ...list[i], ...v }; else list.push({ id: String(value.id).slice(0, 40), height: 300, ...v });
        updateSettings({ webWidgets: list });
      }
      else if (key.startsWith('task:') && aiService) aiService.applySyncedTask(value);
      else if (key.startsWith('conv:') && aiService) aiService.applySyncedConversation(value, from);
    },
    remove: (key) => {
      if (key.startsWith('web:')) updateSettings({ webWidgets: (store.get('webWidgets') || []).filter((x) => x.id !== key.slice(4)) });
      else if (key.startsWith('task:') && aiService) aiService.removeSyncedTask(key.slice(5));
      else if (key.startsWith('conv:') && aiService) aiService.removeSyncedConversation(key.slice(5));
    },
    log: (m) => console.log('[state]', m)
  });

  // Send to device, receiving side: onto this clipboard, and say so.
  async function receiveClipboard(a, from) {
    if (!clipboardOn()) throw new Error(`clipboard sharing is turned off on ${store.get('devices').name || require('os').hostname()}`);
    const { clipboard } = require('electron');
    const what = require('./clip-send').writeClip(clipboard, nativeImage, a);
    if (notifyCenter) notifyCenter.add({ source: 'system', title: `Clipboard from ${from.name || 'another device'}`, body: what, toast: true });
    return { ok: true };
  }
  function attachClipboard(mesh) {
    mesh.handle('clipboard.put', 'clipboard', receiveClipboard);
    // Devices coming and going: the "Send clipboard to" list follows.
    let t = null;
    mesh.on('change', () => { clearTimeout(t); t = setTimeout(rebuildTrayMenu, 500); });
    rebuildTrayMenu();
  }

  // A web widget sent to one device: a copy there, not kept in sync.
  const toast = (title, body) => { try { if (Notification.isSupported()) new Notification({ title, body, icon: loadIcon() }).show(); } catch { /* no toasts */ } };
  async function receiveWidget(a, from) {
    const w = a && a.widget;
    if (!w || !/^https?:\/\//i.test(String(w.url || ''))) throw new Error('not a web widget');
    const list = (store.get('webWidgets') || []).slice();
    if (!list.some((x) => x.url === w.url)) {
      list.push({ id: `w${Date.now().toString(36)}`, name: String(w.name || '').slice(0, 40), url: String(w.url), height: 300 });
      updateSettings({ webWidgets: list });
    }
    toast('Web widget received', `${from.name || 'Another device'} sent "${w.name || w.url}".`);
    return { ok: true };
  }
  function attachWidgetSend(mesh) {
    mesh.handle('widget.receive', 'state', receiveWidget);
  }

  // Right-click a widget: lock it in place (free-form), and for a web
  // widget, share it with all my devices or send a copy to one.
  ipcMain.handle('widget:menu', (_e, info) => new Promise((resolve) => {
    info = info || {};
    const key = String(info.key || '');
    let chosen = null;
    const tpl = [];
    if (info.free) tpl.push({ label: info.allLocked ? 'Lock in place (all widgets are locked)' : 'Lock in place', type: 'checkbox', checked: !!info.locked || !!info.allLocked, enabled: !info.allLocked, click: () => { chosen = info.locked ? 'unlock' : 'lock'; } });
    else tpl.push({ label: 'Lock in place (in the free-form layout)', enabled: false });
    const m = /^web:(.+)$/.exec(key);
    const w = m && (store.get('webWidgets') || []).find((x) => x.id === m[1]);
    if (w) {
      const mesh = deviceService && deviceService.mesh;
      const online = mesh ? [...mesh.conns.keys()].map((id) => ({ id, p: mesh.peers.get(id) })).filter((x) => x.p) : [];
      const setShared = (on) => {
        updateSettings({ webWidgets: (store.get('webWidgets') || []).map((x) => (x.id === w.id ? { ...x, shared: on } : x)) });
        stateSync.touch();
      };
      const targets = sendTargets();
      tpl.push({ type: 'separator' },
        { label: 'Share with all my devices', type: 'checkbox', checked: !!w.shared, enabled: !!mesh, click: () => setShared(!w.shared) },
        { label: 'Send to', enabled: targets.length > 0, submenu: targets.length ? targets.map(({ id, p, relayed }) => ({
          label: `${p.label || p.name || id.slice(0, 7)}${relayed ? '  (via relay)' : ''}`,
          click: () => (relayed ? relayClient.send(id, 'widget', '', { widget: webShared(w) }) : mesh.request(id, 'widget.receive', { widget: webShared(w) }, 10000))
            .then(() => toast('Web widget sent', `"${w.name || w.url}" is on ${p.label || p.name} now.`))
            .catch((err) => toast('Web widget not sent', /allowed/.test(err.message) ? `${p.label || p.name} has not allowed "Synced state" for this device.` : err.message))
        })) : [{ label: 'No paired devices online', enabled: false }] });
      if (!mesh) tpl.push({ label: 'Turn on device connections in Settings > Devices to share', enabled: false });
    }
    Menu.buildFromTemplate(tpl).popup({ window: win, callback: () => setImmediate(() => resolve(chosen)) });
  }));

  // File Pool sync rides on the mesh: it runs while device connections are on.
  const poolListeners = [];
  const poolSync = new (require('./pool-sync').PoolSync)({
    poolDir: () => fileService.poolDir(),
    indexFile: path.join(app.getPath('userData'), 'mesh', 'pool-index.json'),
    deviceName: () => String((store.get('devices') || {}).name || require('os').hostname()),
    trash: (p) => shell.trashItem(p),
    log: (m) => console.log('[pool]', m),
    onChange: (info) => {
      for (const f of poolListeners) { try { f(info); } catch { /* a listener's problem */ } }
      if (!info || info.local || !notifyCenter) return;
      const n = (info.received || []).length;
      const parts = [];
      if (n) parts.push(`${n} file${n === 1 ? '' : 's'} received`);
      if ((info.deleted || []).length) parts.push(`${info.deleted.length} removed`);
      if ((info.conflicts || []).length) parts.push(`${info.conflicts.length} kept as conflict copies`);
      if (parts.length) notifyCenter.add({ source: 'system', sourceName: 'File Pool', title: `File Pool: ${parts.join(', ')} from ${info.from}`, body: (info.received || []).slice(0, 5).join(', '), toast: false });
    }
  });
  relayDrive = new (require('./relay-drive').RelayDrive)({
    getMesh: () => (deviceService && deviceService.mesh) || null,
    deviceName: () => String((store.get('devices') || {}).name || require('os').hostname()),
    relayClient,
    keyring: new (require('./mesh/drive-crypto').DriveKeyring)({
      file: path.join(app.getPath('userData'), 'mesh', 'drive-keys.enc'),
      protect: { available: () => require('electron').safeStorage.isEncryptionAvailable(), encrypt: (t) => require('electron').safeStorage.encryptString(String(t)), decrypt: (b) => require('electron').safeStorage.decryptString(b) }
    }),
    pool: { dir: () => fileService.poolDir(), index: () => poolSync.index, onChange: (cb) => poolListeners.push(cb) },
    log: (m) => console.log('[relay storage]', m)
  });
  remoteFiles.drive = relayDrive;
  deviceService = new (require('./mesh/service').DeviceService)({
    userDataDir: app.getPath('userData'), store, getWindow: () => win,
    onStart: (mesh) => {
      poolSync.attach(mesh); poolSync.start(); remoteFiles.attach(mesh); stateSync.attach(mesh); stateSync.start(); attachWidgetSend(mesh); attachClipboard(mesh); attachMedia(mesh);
      relayClient.attach(mesh);
      relayDrive.attach(mesh);
      // A relay only stores and forwards: it gets none of a device's permissions.
      const lockRelays = () => { for (const p of mesh.peers.values()) if (p.role === 'relay' && Object.values(p.perms || {}).some(Boolean)) mesh.setPerms(p.id, Object.fromEntries(Object.keys(p.perms).map((k) => [k, false]))); };
      mesh.on('change', lockRelays);
      lockRelays();
      if (aiService) { aiService.bus.attach(mesh); aiService.shared.attach(mesh); aiService.bus.relay = relayClient; }
    },
    onStop: () => { poolSync.stop(); poolSync.mesh = null; stateSync.stop(); relayClient.stop(); relayDrive.stop(); }
  });
  deviceService.registerIpc();
  if ((store.get('devices') || {}).enabled) deviceService.start();
  app.on('before-quit', () => { if (deviceService) deviceService.stop(); });

  aiService = new (require('./ai').AiService)({
    deviceId: () => { try { return deviceService.ensureIdentity().id; } catch { return ''; } },
    stateChanged: () => stateSync.touch(),
    getMesh: () => (deviceService && deviceService.mesh) || null,
    deviceName: () => String((store.get('devices') || {}).name || require('os').hostname()),
    userDataDir: app.getPath('userData'),
    store,
    updateSettings,
    getWindow: () => win,
    spotlight,
    plugins: () => pluginList,
    telemetry: () => telemetry.sample(telemetryOpts()),
    media: { info: () => mediaCtl.info(), action: (name) => mediaCtl.action(name) },
    speak: (text) => { if (win && !win.isDestroyed()) { win.webContents.send('ai:speak', String(text || '')); return true; } return false; },
    tasks: {
      list: () => (taskWindows ? taskWindows.list() : linuxTasks ? linuxTasks.list() : Promise.resolve([])),
      action: (name, id) => (taskWindows ? taskWindows.action(name, id) : linuxTasks ? linuxTasks.action(name, id) : false)
    },
    notify: (title, body) => notifyCenter.add({ source: 'ai', sourceName: 'AI assistant', title, body }),
    openWebSearch: (q) => shell.openExternal(require('./spotlight').webSearchUrl(store.get('search').webEngine, q)),
    clipboard: {
      read: () => require('electron').clipboard.readText(),
      write: (t) => require('electron').clipboard.writeText(String(t || ''))
    },
    runCommand: (cmd) => require('./spotlight').runCommand(cmd),
    sendKeys: (args) => sendKeysToForeground(args),
    execCapture: (cmd, timeoutSec) => new Promise((resolve) => {
      require('child_process').exec(String(cmd || ''), { timeout: timeoutSec * 1000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          timedOut: !!(err && err.killed),
          stdout: String(stdout || '').slice(0, 20000),
          stderr: String(stderr || '').slice(0, 4000)
        }));
    }),
    setPinned: (on) => {
      if (!win) return;
      if (on) { liftFromDesktop(); win.setAlwaysOnTop(true, 'screen-saver'); win.show(); }
      else if (!store.get('alwaysOnTop')) { win.setAlwaysOnTop(false); sinkToDesktop(); }
    }
  });
  aiService.bus.relay = relayClient;
  if (deviceService && deviceService.mesh) { aiService.bus.attach(deviceService.mesh); aiService.shared.attach(deviceService.mesh); }
  spotlight.aiEnabled = () => aiService.enabled();
  spotlight.askAi = (q) => aiService.askFromSearch(q);

  // Release checks: shortly after startup (never blocking it), then a few
  // times a day. Notify-only by design.
  setTimeout(() => runUpdateCheck(), 30 * 1000);
  updateTimer = setInterval(() => runUpdateCheck(), updater.CHECK_EVERY_MS);

  // Settle into the desktop layer once the worker exists, and re-settle on
  // every event that raises a window: being (re)shown, and losing focus after
  // the user interacted with a widget. show() raises in Win32, so the startup
  // show would otherwise undo a one-time sink.
  sinkToDesktop();
  if (win) {
    win.on('blur', () => { if (dockSummoned) unsummonDock(); else sinkToDesktop(); });
    win.on('show', () => setTimeout(sinkToDesktop, 50));
    setTimeout(sinkToDesktop, 1500);   // after the first paint settles
  }
  // The window was created before the Win32 worker existed, so a free-mode
  // span across mixed-DPI displays has not been enforced yet - do it now.
  applyBounds();

  // Downloads started inside web widgets land in the user's Downloads folder
  // under a non-clobbering name, with a notification when they finish. Without
  // this handler they would silently stall in a frameless app.
  applySpellcheck();
  const widgetSession = session.fromPartition('persist:webwidgets');
  // Guest pages notify through the host's shim (notification center), so the
  // OS-level permission is refused - otherwise every site would toast twice.
  widgetSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission !== 'notifications'));
  widgetSession.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads');
    const base = (item.getFilename() || 'download').replace(/[\\/:*?"<>|]/g, '_');
    let target = path.join(dir, base);
    for (let n = 1; require('fs').existsSync(target); n++) {
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      target = path.join(dir, `${stem} (${n})${ext}`);
    }
    item.setSavePath(target);
    item.once('done', (_ev, state) => {
      if (notifyCenter) notifyCenter.add({ source: 'system', title: state === 'completed' ? 'Download complete' : 'Download failed', body: state === 'completed' ? target : `${base}: ${state}`, toast: false });
      if (!SysNotification.isSupported()) return;
      new SysNotification({
        title: state === 'completed' ? 'Download complete' : 'Download failed',
        body: state === 'completed' ? target : `${base}: ${state}`,
        icon: loadIcon()
      }).show();
    });
  });

  rebuildTrayMenu();

  // Monitors coming, going or rescaling re-flow the window, the renderer's
  // display map, and the tray's display list.
  const redock = () => {
    applyBounds();
    if (win) sendSettings();
    rebuildTrayMenu();
  };
  screen.on('display-metrics-changed', redock);
  screen.on('display-added', redock);
  screen.on('display-removed', redock);
});

app.on('before-quit', () => {
  clearInterval(updateTimer);
  clearInterval(mousePollTimer);
  isQuitting = true;
  if (mediaCtl) mediaCtl.destroy();
  if (voice) voice.stop();
  if (whisper) whisper.shutdown();
  if (piper) piper.shutdown();
  clearInterval(telemetryTimer);
  clearInterval(updateTimer);
  if (apiServer) apiServer.stop();
  if (peerResolver) peerResolver.destroy();
  if (taskWindows) taskWindows.destroy();
  if (spotlight) spotlight.destroy();
  globalShortcut.unregisterAll();
  if (store) store.flush();
});

// Tray app: closing the window never quits.
app.on('window-all-closed', (e) => e.preventDefault());
