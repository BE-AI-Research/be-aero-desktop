// BE-Aero Desktop - host for third-party content.
//
// Two kinds of extension end up in the sidebar:
//   plugin widgets - a local folder's HTML, rendered in a sandboxed iframe
//   app panes      - structured status pushed in over the local API
//
// The iframe is sandboxed without allow-same-origin, so a plugin runs in an
// opaque origin: it cannot touch this document, its storage or its cookies. The
// only way out is postMessage, and every message is matched to the iframe it
// came from before the host will act on it.
(function () {
  'use strict';

  let aero = null;
  let hooks = {};
  let plugins = [];
  let panes = [];
  const frames = new Map();     // plugin id -> iframe element
  let telemetrySubscribers = new Set();

  const el = (tag, cls, parent, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  };

  const sidebar = () => document.getElementById('sidebar');

  // ------------------------------------------------------------ plugin panes
  // Last settings snapshot pushed to each frame, so only real changes emit.
  const lastSettings = new Map();

  function renderPlugins(list) {
    plugins = Array.isArray(list) ? list : [];

    // Tell a plugin when the user edits its settings in the panel.
    for (const p of plugins) {
      const frame = frames.get(p.id);
      const snapshot = JSON.stringify(p.settingsValues || {});
      if (frame && frame.contentWindow && lastSettings.get(p.id) !== snapshot) {
        frame.contentWindow.postMessage({ __aero: 1, event: 'settings', payload: p.settingsValues || {} }, '*');
      }
      lastSettings.set(p.id, snapshot);
    }

    // A revoked permission must stop the live push stream too, not just block
    // the next explicit call.
    for (const id of [...telemetrySubscribers]) {
      const p = plugins.find((x) => x.id === id);
      const granted = p && p.permissionState.some((x) => x.name === 'telemetry' && x.state === 'granted');
      if (!granted) telemetrySubscribers.delete(id);
    }

    // Let each plugin know where it stands so it can re-subscribe when a
    // permission comes back, or hide a feature when one goes away.
    for (const p of plugins) {
      const frame = frames.get(p.id);
      if (!frame || !frame.contentWindow) continue;
      frame.contentWindow.postMessage({
        __aero: 1,
        event: 'permissions',
        payload: Object.fromEntries(p.permissionState.map((x) => [x.name, x.state]))
      }, '*');
    }

    const wanted = new Set(plugins.filter((p) => p.enabled).map((p) => p.id));

    // Drop panes for plugins that went away or were switched off.
    for (const [id, frame] of frames) {
      if (!wanted.has(id)) {
        const host = frame.closest('[data-widget]');
        if (host) host.remove();
        frames.delete(id);
      }
    }

    for (const p of plugins) {
      if (!p.enabled || frames.has(p.id)) continue;
      const section = el('section', 'widget widget-hit plugin-widget');
      section.dataset.widget = `plugin:${p.id}`;
      section.dataset.pluginId = p.id;
      section.style.height = `${p.height}px`;

      const head = el('div', 'plugin-head', section);
      el('h3', 'widget-title', head, p.name.toUpperCase());
      const badge = el('span', 'badge', head, 'PLUGIN');
      badge.title = `${p.name} ${p.version}${p.author ? ` by ${p.author}` : ''}\n`
        + `${p.description || ''}\n`
        + `Permissions: ${p.permissions.length ? p.permissions.join(', ') : 'none'}`;

      const frame = document.createElement('iframe');
      frame.className = 'plugin-frame';
      // No allow-same-origin: the plugin gets an opaque origin and cannot
      // reach this page. allow-scripts is what makes it a widget at all.
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.src = p.entryUrl;
      section.appendChild(frame);
      frames.set(p.id, frame);

      sidebar().appendChild(section);
      if (hooks.onWidgetAdded) hooks.onWidgetAdded(section);
    }
  }

  // ------------------------------------------------------------ web widgets
  // User-created panes that embed a web page. Each one is a <webview> guest:
  // its own top-level page, so sites that refuse to be iframed still render,
  // logins keep first-party cookies, and zoom/reload are native. Guests are
  // hardened in main (will-attach-webview) and share one persistent storage
  // partition so dashboards keep their logins across restarts.
  const webFrames = new Map();   // id -> entry

  const ZOOM_STEPS = [0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

  function clampZoom(z) {
    const n = Number(z);
    if (!Number.isFinite(n)) return 1;
    return Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], n));
  }

  function stepZoom(z, dir) {
    if (dir > 0) return ZOOM_STEPS.find((v) => v > z + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
    return [...ZOOM_STEPS].reverse().find((v) => v < z - 0.001) ?? ZOOM_STEPS[0];
  }

  function applyZoom(entry, z) {
    entry.zoom = clampZoom(z);
    if (entry.ready) { try { entry.view.setZoomFactor(entry.zoom); } catch { /* guest gone */ } }
    entry.zoomLabel.textContent = `${Math.round(entry.zoom * 100)}%`;
  }

  async function persistZoom(id, zoom) {
    const current = (await aero.getSettings()).webWidgets || [];
    await aero.setSettings({
      webWidgets: current.map((w) => (w.id === id ? { ...w, zoom } : w))
    });
  }

  // Browser-style certificate warning: gated, detailed, and only an explicit
  // Proceed pins the certificate. A changed certificate warns harder.
  function showCertGate(entry, info) {
    entry.certGate = true;
    entry.overlay.textContent = '';
    entry.overlay.classList.add('cert');
    el('div', 'webw-cert-icon', entry.overlay, info.changed ? '⚠' : '🔒');
    el('div', 'webw-cert-title', entry.overlay,
      info.changed ? 'Certificate has CHANGED' : 'Your connection is not private');
    el('div', 'webw-error-msg', entry.overlay, info.changed
      ? `The certificate for ${info.host} is different from the one you accepted before. This can mean the device was reinstalled - or that something is intercepting the connection. Do not continue unless you know why it changed.`
      : `${info.host} is using a certificate this computer does not trust (${info.error || 'certificate error'}). This is normal for LAN devices with self-signed certificates.`);

    const meta = el('div', 'webw-cert-meta', entry.overlay);
    const addRow = (k, v) => {
      if (!v) return;
      const d = el('div', '', meta);
      el('span', '', d, k);
      el('span', '', d, v);
    };
    addRow('Issued to', info.subject);
    addRow('Issued by', info.issuer);
    addRow('Expires', info.expiry ? new Date(info.expiry).toLocaleDateString() : '');
    addRow('SHA-256', info.fingerprint ? info.fingerprint.replace(/^sha256\//, '').slice(0, 24) + '…' : '');

    const rowEl = el('div', 'pane-actions', entry.overlay);
    const back = el('button', 'btn', rowEl, 'Go back');
    back.addEventListener('click', () => { hideWebError(entry); });
    const go = el('button', `btn ${info.changed ? 'btn-danger' : ''}`, rowEl,
      info.changed ? 'Accept new certificate' : 'Proceed (accept certificate)');
    go.addEventListener('click', async () => {
      await aero.trustCert(info.host, info.fingerprint);
      hideWebError(entry);
      entry.view.src = entry.url;
    });
    entry.overlay.classList.add('on');
  }

  function onWebWidgetCert(info) {
    const entries = [...webFrames.values()];
    let hit = entries.filter((e) => AeroWebUrl.sameSite(e.url, info.url));
    if (!hit.length && entries.length === 1) hit = entries;
    for (const entry of hit) showCertGate(entry, info);
  }

  function showWebError(entry, message) {
    // The certificate gate carries more information than the generic failure
    // the same load also produces; never let the latter replace it.
    if (entry.certGate && entry.overlay.classList.contains('on')) return;
    entry.overlay.textContent = '';
    const msg = el('div', 'webw-error-msg', entry.overlay, message);
    msg.title = entry.url;
    const retry = el('button', 'btn', entry.overlay, 'Retry');
    retry.addEventListener('click', () => { hideWebError(entry); entry.view.src = entry.url; });
    entry.overlay.classList.add('on');
  }

  function hideWebError(entry) {
    entry.certGate = false;
    entry.overlay.classList.remove('on', 'cert');
  }

  function renderWebWidgets(list) {
    const wanted = new Map((Array.isArray(list) ? list : [])
      .filter((w) => w && w.id && !w.hidden && /^https?:\/\//i.test(w.url || ''))
      .map((w) => [w.id, w]));

    for (const [id, entry] of webFrames) {
      if (!wanted.has(id)) { entry.section.remove(); webFrames.delete(id); }
    }

    for (const w of wanted.values()) {
      const existing = webFrames.get(w.id);
      if (existing) {
        // The guest stays alive while minimized, so a dashboard is current the
        // moment it is restored.
        existing.section.classList.toggle('minimized', !!w.minimized);
        continue;
      }
      const section = el('section', 'widget widget-hit plugin-widget web-widget');
      section.dataset.widget = `web:${w.id}`;
      section.style.height = `${Math.max(120, Math.min(1200, w.height || 300))}px`;

      const head = el('div', 'plugin-head', section);
      const title = el('h3', 'widget-title', head, (w.name || hostOf(w.url)).toUpperCase());
      title.title = w.url;

      const controls = el('div', 'webw-controls', head);
      const zoomOut = el('button', 'icon-btn webw-btn', controls, '−');
      zoomOut.title = 'Zoom out';
      const zoomLabel = el('button', 'icon-btn webw-btn webw-zoom', controls, '100%');
      zoomLabel.title = 'Reset zoom to 100%';
      const zoomIn = el('button', 'icon-btn webw-btn', controls, '+');
      zoomIn.title = 'Zoom in';
      const reload = el('button', 'icon-btn webw-btn', controls, '↻');
      reload.title = 'Reload page';
      const mini = el('button', 'icon-btn webw-btn', controls, '▁');
      mini.title = 'Minimize into the Task switcher';

      const badge = el('span', 'badge', head, 'WEB');
      badge.title = w.url;

      const wrap = el('div', 'web-zoom', section);
      const view = document.createElement('webview');
      view.className = 'plugin-frame';
      view.setAttribute('partition', 'persist:webwidgets');
      view.setAttribute('allowpopups', '');   // window.open -> default browser (main decides)
      view.src = w.url;
      wrap.appendChild(view);

      const overlay = el('div', 'webw-error', section);
      const entry = { section, view, zoomLabel, overlay, url: w.url, zoom: clampZoom(w.zoom ?? 1), ready: false };
      zoomLabel.textContent = `${Math.round(entry.zoom * 100)}%`;

      view.addEventListener('dom-ready', () => {
        entry.ready = true;
        applyZoom(entry, entry.zoom);
        // Page notifications -> the notification center (see webops.js).
        if (window.AeroWebOps) view.executeJavaScript(AeroWebOps.NOTIFICATION_SHIM, true).catch(() => {});
      });
      view.addEventListener('console-message', (e) => {
        const n = window.AeroWebOps && AeroWebOps.parseNotifyMessage(e.message);
        if (n) aero.notifyFromWeb({ id: w.id, name: w.name || w.url, title: n.title, body: n.body, icon: n.icon });
      });
      // The guest reports its own failures; -3 is Chromium's routine abort
      // noise on redirects and is not an error a user should see.
      view.addEventListener('did-fail-load', (e) => {
        if (!e.isMainFrame || e.errorCode === -3) return;
        const message = AeroWebUrl.describeLoadError(e.errorCode, e.errorDescription);
        if (message) showWebError(entry, message);
      });
      view.addEventListener('did-finish-load', () => { if (!entry.certGate) hideWebError(entry); });
      view.addEventListener('page-favicon-updated', (e) => {
        const icon = (e.favicons || []).find((u) => /^https?:/i.test(u)) || null;
        if (icon !== entry.favicon) { entry.favicon = icon; pushMinimizedToDock(); }
      });

      const setZoom = (z) => { applyZoom(entry, z); persistZoom(w.id, entry.zoom); };
      zoomOut.addEventListener('click', () => setZoom(stepZoom(entry.zoom, -1)));
      zoomIn.addEventListener('click', () => setZoom(stepZoom(entry.zoom, +1)));
      zoomLabel.addEventListener('click', () => setZoom(1));
      reload.addEventListener('click', () => {
        hideWebError(entry);
        try { entry.view.reload(); } catch { entry.view.src = entry.url; }
      });
      mini.addEventListener('click', () => setWidgetMinimized(w.id, true));

      section.classList.toggle('minimized', !!w.minimized);
      webFrames.set(w.id, entry);
      sidebar().appendChild(section);
      if (hooks.onWidgetAdded) hooks.onWidgetAdded(section);
    }

    lastWebWidgets = [...wanted.values()];
    pushMinimizedToDock();
  }

  // The dock shows each parked web app with its real favicon once the page
  // has reported one (the guest keeps running while minimized, so it does).
  function pushMinimizedToDock() {
    if (!window.AeroTasks) return;
    const parked = lastWebWidgets.filter((w) => w.minimized && !w.hidden).map((w) => {
      const entry = webFrames.get(w.id);
      return { id: w.id, name: w.name, url: w.url, favicon: (entry && entry.favicon) || null };
    });
    // The AI chat parks in the dock too, under a sparkle.
    if (aiMinimized) parked.push({ id: '__ai__', name: 'AI assistant', url: '', favicon: null, glyph: '\u2728' });
    // Built-in widgets the user minimized.
    for (const p of parkedBuiltins) parked.push({ id: `__w:${p.id}`, name: p.name, url: '', favicon: null, glyph: p.glyph });
    window.AeroTasks.setMinimizedWidgets(parked);
  }
  let lastWebWidgets = [];
  let aiMinimized = false;
  let parkedBuiltins = [];
  function setParkedWidgets(list) {
    const next = Array.isArray(list) ? list : [];
    if (JSON.stringify(next) === JSON.stringify(parkedBuiltins)) return;
    parkedBuiltins = next;
    pushMinimizedToDock();
  }
  function setAiMinimized(on) {
    if (aiMinimized === !!on) return;
    aiMinimized = !!on;
    pushMinimizedToDock();
  }

  async function setWidgetMinimized(id, minimized) {
    const current = (await aero.getSettings()).webWidgets || [];
    await aero.setSettings({
      webWidgets: current.map((w) => (w.id === id ? { ...w, minimized } : w))
    });
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch { return 'web widget'; }
  }

  // ------------------------------------------------------------- app panes
  function renderPanes(list) {
    panes = Array.isArray(list) ? list : [];
    const wanted = new Set(panes.map((p) => p.id));

    for (const node of [...document.querySelectorAll('[data-pane-id]')]) {
      if (!wanted.has(node.dataset.paneId)) node.remove();
    }

    for (const pane of panes) {
      let section = document.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"]`);
      const isNew = !section;
      if (isNew) {
        section = el('section', 'widget widget-hit app-pane');
        section.dataset.widget = `pane:${pane.id}`;
        section.dataset.paneId = pane.id;
        sidebar().appendChild(section);
      }
      drawPane(section, pane);
      if (isNew && hooks.onWidgetAdded) hooks.onWidgetAdded(section);
    }
  }

  // Everything here is written with textContent: pane content arrives from
  // another process over a socket and is never treated as markup.
  function drawPane(section, pane) {
    section.innerHTML = '';
    if (pane.accent) section.style.setProperty('--pane-accent', pane.accent);

    const head = el('div', 'pane-head', section);
    el('h3', 'widget-title', head, `${pane.icon ? `${pane.icon} ` : ''}${pane.title}`.toUpperCase());
    if (pane.subtitle) el('span', 'pane-sub', head, pane.subtitle);

    const body = el('div', 'pane-body', section);

    if (pane.progress !== null && pane.progress !== undefined) {
      const track = el('div', 'pane-progress', body);
      const fill = el('div', 'pane-progress-fill', track);
      fill.style.width = `${pane.progress}%`;
    }

    for (const line of pane.lines || []) el('div', 'pane-line', body, line);

    if ((pane.metrics || []).length) {
      const grid = el('div', 'pane-metrics', body);
      for (const m of pane.metrics) {
        const cell = el('div', 'pane-metric', grid);
        const top = el('div', 'pane-metric-top', cell);
        el('span', 'pane-metric-label', top, m.label);
        el('span', 'pane-metric-value', top, m.value);
        if (m.percent !== null && m.percent !== undefined) {
          const track = el('div', 'pane-metric-track', cell);
          const fill = el('div', 'pane-metric-fill', track);
          fill.style.width = `${m.percent}%`;
          if (m.color) fill.style.background = m.color;
        }
      }
    }

    if ((pane.actions || []).length) {
      const row = el('div', 'pane-actions', body);
      for (const a of pane.actions) {
        const btn = el('button', 'btn', row, a.label);
        btn.addEventListener('click', () => aero.openExternal(a.url));
      }
    }

    // Always name the program behind a pane: the user should never have to
    // guess which app put something on their desktop.
    const foot = el('div', 'pane-foot', section);
    const when = pane.updatedAt ? new Date(pane.updatedAt).toLocaleTimeString() : '';
    foot.textContent = [pane.ownerName, when && `updated ${when}`].filter(Boolean).join(' · ');
    if (pane.ownerName) foot.title = `Pushed by "${pane.ownerName}" via the local app API`;
  }

  // --------------------------------------------------------- iframe bridge
  // A plugin calls window.parent.postMessage({__aero:1, id, method, params}).
  // We answer with {__aero:1, id, ok, result|error}. The plugin id is taken
  // from the frame the message physically came from - never from the message
  // body - so one plugin cannot act as another.
  function pluginIdFor(source) {
    for (const [id, frame] of frames) {
      if (frame.contentWindow === source) return id;
    }
    return null;
  }

  const METHODS = {
    'storage.get': (id) => aero.pluginStorageGet(id),
    'storage.set': (id, params) => aero.pluginStorageSet(id, params && params.patch),
    'telemetry.get': (id) => aero.pluginTelemetry(id),
    'theme.get': (id) => aero.pluginTheme(id),
    'shell.openExternal': (id, params) => aero.pluginOpenExternal(id, params && params.url),
    'notifications.show': (id, params) => aero.pluginNotify(id, params),
    'permissions.query': (id, params) => aero.pluginPermissionQuery(id, params && params.name),
    // Manifest-declared settings are the plugin's own user-edited config, so
    // reading them needs no permission grant (unlike free-form storage).
    'settings.get': (id) => {
      const p = plugins.find((x) => x.id === id);
      return (p && p.settingsValues) || {};
    },
    'permissions.request': (id, params) => aero.pluginPermissionRequest(id, params && params.name),
    // Subscribing is a privileged call in its own right: without this the push
    // stream would be a way around the permission gate.
    'telemetry.subscribe': async (id) => {
      await aero.pluginTelemetry(id);
      telemetrySubscribers.add(id);
      return true;
    },
    'telemetry.unsubscribe': (id) => { telemetrySubscribers.delete(id); return true; },
    'host.info': (id) => {
      const p = plugins.find((x) => x.id === id);
      return {
        id,
        name: p ? p.name : id,
        requested: p ? p.permissions : [],
        granted: p ? p.permissionState.filter((x) => x.state === 'granted').map((x) => x.name) : [],
        api: 1
      };
    }
  };

  async function onMessage(event) {
    const msg = event.data;
    if (!msg || msg.__aero !== 1 || typeof msg.method !== 'string') return;
    const id = pluginIdFor(event.source);
    if (!id) return;                       // not from a plugin frame we host
    const frame = frames.get(id);
    const reply = (payload) => frame.contentWindow.postMessage({ __aero: 1, ...payload }, '*');

    const handler = METHODS[msg.method];
    if (!handler) { reply({ id: msg.id, ok: false, error: `unknown method "${msg.method}"` }); return; }
    try {
      const result = await handler(id, msg.params || {});
      reply({ id: msg.id, ok: true, result });
    } catch (err) {
      reply({ id: msg.id, ok: false, error: String(err && err.message ? err.message : err) });
    }
  }

  // Push events out to plugins that asked for them.
  function emit(method, payload, onlyIds) {
    for (const [id, frame] of frames) {
      if (onlyIds && !onlyIds.has(id)) continue;
      if (!frame.contentWindow) continue;
      frame.contentWindow.postMessage({ __aero: 1, event: method, payload }, '*');
    }
  }

  function onTelemetry(sample) {
    if (telemetrySubscribers.size) emit('telemetry', sample, telemetrySubscribers);
  }

  function onTheme(vars) {
    emit('theme', vars);
  }

  // ------------------------------------------------------------------ init
  async function init(opts) {
    aero = opts.aero;
    hooks = opts;
    window.addEventListener('message', onMessage);
    aero.onPluginsChanged(renderPlugins);
    aero.onPanesChanged(renderPanes);
    aero.onWebWidgetCert(onWebWidgetCert);
    // The AI assistant operates web widgets through the host.
    aero.onAiWebOp(async (req) => {
      const result = window.AeroWebOps
        ? await AeroWebOps.handle(webFrames.get(req.id), req)
        : { ok: false, error: 'web operations unavailable' };
      aero.aiWebOpResult(req.opId, result);
    });
    renderPlugins(await aero.listPlugins());
    renderPanes(await aero.listPanes());
  }

  // Bring a web widget into view (and back from the dock if minimized).
  function focusWebWidget(id) {
    const entry = webFrames.get(id);
    if (entry && entry.section) { entry.section.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return true; }
    return false;
  }

  window.AeroExtensions = {
    focusWebWidget,
    setAiMinimized,
    setParkedWidgets,
    init, renderPlugins, renderPanes, renderWebWidgets, onTelemetry, onTheme,
    plugins: () => plugins,
    panes: () => panes
  };
})();
