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
let aiService = null;
let notifyCenter = null;
let dockHotkey = null;       // the accelerator actually registered for the dock
let dockSummoned = false;    // sidebar lifted above everything by the dock hotkey
let lastUpdateStatus = { state: 'idle' };
let updateTimer = null;
let taskWindows = null;
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
}]);

// Only one sidebar at a time: a second launch just shows the existing one.
// `be-aero-desktop --doctor` prints platform diagnostics and exits - the
// first thing to ask for when a Linux desktop misbehaves. It must run even
// while the app itself is running, so it skips the single-instance lock.
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
  if (process.platform !== 'win32' || !win || !taskWindows) return;
  if (store.get('alwaysOnTop') || (aiService && aiService.isPinned())) return;
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
        win.webContents.send('settings:changed', publicSettings());
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

function applyInputModel() {
  if (!win) return;
  if (!linuxShapeInput()) { setIgnoreMouse(true); return; }
  win.setIgnoreMouseEvents(false);
  if (store.get('dock') !== 'free') {
    // Docked: the whole strip is interactive. The docs say an empty list
    // reverts to rectangular, but an implementation that reads it as an
    // empty REGION would make the window deaf - pass the full rect instead.
    const b = win.getBounds();
    win.setShape([{ x: 0, y: 0, width: b.width, height: b.height }]);
  }
  // free: the renderer's rect reports (window:input-shape) take over
}

ipcMain.on('window:input-shape', (_e, rects) => {
  if (!linuxShapeInput() || store.get('dock') !== 'free') return;
  try {
    win.setShape((Array.isArray(rects) ? rects : [])
      .map((r) => ({ x: r.x | 0, y: r.y | 0, width: r.width | 0, height: r.height | 0 }))
      .filter((r) => r.width > 0 && r.height > 0));
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
  if (!store.get('alwaysOnTop')) win.setAlwaysOnTop(true, 'screen-saver');
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
    win.webContents.send('settings:changed', publicSettings());
  }
  if (patch.telemetry && ('interval' in patch.telemetry || 'metrics' in patch.telemetry)) startTelemetry();
  if (spotlight && patch.theme) spotlight.applyTheme && spotlight.applyTheme(s.theme);
  if (patch.dock && typeof patch.dock === 'object' && 'hotkey' in patch.dock) {
    applyDockHotkey(s.dock.hotkey);
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
    { type: 'separator' },
    { label: 'Widgets', submenu: [
      widgetItem('Search bar', 'search'),
      widgetItem('Chronometer', 'clock'),
      widgetItem('Weather', 'weather'),
      widgetItem('System telemetry', 'telemetry'),
      widgetItem(`Application dock${dockHotkey ? '\t' + dockHotkey.replace('Control', 'Ctrl') : ''}`, 'tasks'),
      { label: 'Dock alignment', submenu: ['left', 'center', 'right'].map((a) => ({
        label: a[0].toUpperCase() + a.slice(1), type: 'radio',
        checked: ((store.get('dock') || {}).align || 'center') === a,
        click: () => updateSettings({ dock: { align: a } })
      })) },
      widgetItem('Scratchpad', 'scratchpad'),
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
  return { ...s, themeVars: themeVars(s.theme), ...displayGeometry() };
}

ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('themes:list', () => Object.entries(PRESETS).map(([id, p]) => ({ id, ...p })));
ipcMain.handle('settings:set', (_e, patch) => updateSettings(patch || {}));
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

// ---------------------------------------------------------------- App dock
ipcMain.handle('tasks:action', (_e, name, hwnd) => {
  if (taskWindows) return taskWindows.action(name, hwnd);
  if (linuxTasks) return linuxTasks.action(name, hwnd);
  return false;
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
  const pinned = (store.get('dock') || {}).pinned || [];
  return isPinned(pinned, exe) || lastDockExes.has(exe.toLowerCase());
}
let lastDockExes = new Set();

ipcMain.handle('tasks:list', async () => {
  const list = taskWindows ? await taskWindows.list()
    : linuxTasks ? await linuxTasks.list() : [];
  lastDockExes = new Set(list.map((w) => (w.exe || '').toLowerCase()).filter(Boolean));
  return list;
});

ipcMain.handle('dock:launch', (_e, exe) => {
  if (!dockKnowsExe(exe)) return false;
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
  const pinned = (store.get('dock') || {}).pinned || [];
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
        const dock = store.get('dock') || {};
        dock.pinned = togglePinned(dock.pinned || [], exe, name);
        store.get().dock = dock;
        store.save();
        if (win) win.webContents.send('settings:changed', publicSettings());
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
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
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
  applyDockHotkey((store.get('dock') || {}).hotkey);

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
  refreshPlugins();
  startApi();

  if (process.platform === 'win32') taskWindows = new TaskWindows({ ownExePath: process.execPath });
  // Linux cannot list other apps' windows (Wayland policy), but /proc shows
  // which applications RUN - the dock mirrors that instead.
  if (process.platform === 'linux') linuxTasks = new (require('./tasks-linux').LinuxTasks)();

  // Notification center + AI assistant. Both lean on the window, store,
  // spotlight and task source, so they come last.
  notifyCenter = new (require('./notifications').NotificationCenter)({
    file: path.join(app.getPath('userData'), 'notifications.json'),
    getWindow: () => win,
    toast: (title, body, onClick) => {
      if (!(store.get('notifications') || {}).toast || !SysNotification.isSupported()) return;
      const n = new SysNotification({ title, body, icon: loadIcon() });
      n.on('click', onClick);
      n.show();
    }
  });
  ipcMain.handle('notifications:list', () => notifyCenter.list());
  ipcMain.handle('notifications:read', (_e, id) => notifyCenter.markRead(id || null));
  ipcMain.handle('notifications:remove', (_e, id) => notifyCenter.remove(id));
  ipcMain.handle('notifications:clear', () => notifyCenter.clear());
  ipcMain.handle('notifications:open', (_e, id) => notifyCenter.open(id));
  ipcMain.on('notifications:from-web', (_e, { id, name, title, body, icon }) => {
    notifyCenter.add({ source: 'web', sourceId: String(id || ''), sourceName: String(name || ''), title, body, icon });
  });

  aiService = new (require('./ai').AiService)({
    userDataDir: app.getPath('userData'),
    store,
    updateSettings,
    getWindow: () => win,
    spotlight,
    plugins: () => pluginList,
    telemetry: () => telemetry.sample(telemetryOpts()),
    tasks: {
      list: () => (taskWindows ? taskWindows.list() : linuxTasks ? linuxTasks.list() : Promise.resolve([])),
      action: (name, id) => (taskWindows ? taskWindows.action(name, id) : linuxTasks ? linuxTasks.action(name, id) : false)
    },
    notify: (title, body) => notifyCenter.add({ source: 'ai', sourceName: 'AI assistant', title, body }),
    setPinned: (on) => {
      if (!win) return;
      if (on) { win.setAlwaysOnTop(true, 'screen-saver'); win.show(); }
      else if (!store.get('alwaysOnTop')) { win.setAlwaysOnTop(false); sinkToDesktop(); }
    }
  });
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
    if (win) win.webContents.send('settings:changed', publicSettings());
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
