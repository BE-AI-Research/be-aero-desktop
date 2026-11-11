// BE-Aero Desktop - renderer logic (clock, weather, telemetry, scratchpad, settings).
(async function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const aero = window.aero;
  let settings = await aero.getSettings();

  // ---------------------------------------------------------------
  // Click-through: transparent areas pass clicks to the desktop.
  // Mouse capture is enabled only while the pointer is over a widget.
  // ---------------------------------------------------------------
  let capturing = false;
  let dragging = false;
  function setCapture(on) {
    if (on === capturing) return;
    capturing = on;
    aero.setIgnoreMouse(!on);
  }
  document.addEventListener('mousemove', (e) => {
    if (dragging) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    setCapture(!!(el && el.closest('.widget-hit')));
  });
  document.addEventListener('mouseleave', () => { if (!dragging) setCapture(false); });
  // Linux fallback (no X11 SHAPE support): main polls the cursor while
  // click-through and sends window-relative probe points instead.
  if (aero.onMouseProbe) aero.onMouseProbe(({ x, y }) => {
    if (dragging || capturing) return;
    const el = document.elementFromPoint(x, y);
    if (el && el.closest('.widget-hit')) setCapture(true);
  });
  // Linux input shape: in free-form mode the window takes input only inside
  // the widget rects it reports here (padded so grips and glows stay live).
  // While a gesture runs the whole window is the hit region.
  if (aero.platform === 'linux' && aero.setInputShape) {
    let lastShape = '';
    setInterval(() => {
      if (!document.body.classList.contains('free')) { lastShape = ''; return; }
      const rects = dragging
        ? [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }]
        : [...document.querySelectorAll('.widget-hit')].map((el) => {
            const r = el.getBoundingClientRect();
            return {
              x: Math.max(0, Math.floor(r.left - 24)), y: Math.max(0, Math.floor(r.top - 24)),
              width: Math.ceil(r.width + 48), height: Math.ceil(r.height + 48)
            };
          }).filter((r) => r.width > 48 && r.height > 48);
      const key = JSON.stringify(rects);
      if (key !== lastShape) { lastShape = key; aero.setInputShape(rects); }
    }, 300);
  }

  // Layout: resize grips everywhere, drag-to-move in free-form mode.
  // While a gesture runs, keep capturing mouse input even off the widget.
  AeroTasks.init({
    aero,
    onRestoreWidget: async (id) => {
      if (typeof id === 'string' && id.startsWith('__w:')) {
        const wid = id.slice(4);
        await aero.setSettings({ widgetMinimized: { [wid]: false } });
        const el = document.querySelector(`.widget[data-widget="${wid}"]`);
        if (el) setTimeout(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 100);
        return;
      }
      if (id === '__ai__') {
        await aero.setSettings({ ai: { minimized: false } });
        const w = document.querySelector('.ai-widget');
        if (w) setTimeout(() => w.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 100);
        return;
      }
      const cur = (await aero.getSettings()).webWidgets || [];
      await aero.setSettings({ webWidgets: cur.map((w) => (w.id === id ? { ...w, minimized: false } : w)) });
    }
  });

  AeroLayout.init({
    aero,
    setDragging(on) { dragging = on; if (on) setCapture(true); }
  });

  // Plugin widgets and app panes are real widgets: as each one appears, hand it
  // to the layout system so it gets a resize grip and remembered geometry.
  if (window.AeroAi) AeroAi.init({ aero });
  if (window.AeroMedia) AeroMedia.init({ aero });
  if (window.AeroPower) AeroPower.init({ aero });
  if (window.AeroUac) AeroUac.init({ aero });
  if (window.AeroTrash) AeroTrash.init({ aero });
  if (window.AeroDevices) AeroDevices.init({ aero });
  if (window.AeroFiles) AeroFiles.init({ aero });
  if (window.AeroNotify) AeroNotify.init({
    aero,
    focusWebWidget: (id) => {
      // A minimized web widget lives in the dock; restore it first.
      aero.getSettings().then((s) => {
        const w = (s.webWidgets || []).find((x) => x.id === id);
        if (w && w.minimized) {
          aero.setSettings({ webWidgets: s.webWidgets.map((x) => (x.id === id ? { ...x, minimized: false } : x)) })
            .then(() => setTimeout(() => AeroExtensions.focusWebWidget(id), 300));
        } else AeroExtensions.focusWebWidget(id);
      });
    }
  });
  await AeroExtensions.init({
    aero,
    onWidgetAdded(section) { AeroLayout.adopt(section); }
  });
  if (window.AeroVisuals) AeroVisuals.init({ aero, onWidgetAdded(section) { AeroLayout.adopt(section); } });
  if (window.AeroAiWidgets) AeroAiWidgets.init({ aero, onWidgetAdded(section) { AeroLayout.adopt(section); } });

  // ---------------------------------------------------------------
  // Clock (faces live in clock.js) and telemetry (telemetry-view.js)
  // ---------------------------------------------------------------
  const clockKey = (s) => JSON.stringify([s.clock, s.use24h]);
  const telKey = (s) => JSON.stringify(s.telemetry);
  let lastClockKey = null;
  let lastTelKey = null;
  aero.onTelemetry((t) => { AeroTelemetry.update(t); AeroExtensions.onTelemetry(t); });

  // ---------------------------------------------------------------
  // Weather (Open-Meteo: free, no API key)
  // ---------------------------------------------------------------
  const WMO = {
    0: ['Clear', 'clear'], 1: ['Mostly Clear', 'clear'], 2: ['Partly Cloudy', 'partly'], 3: ['Overcast', 'cloudy'],
    45: ['Fog', 'fog'], 48: ['Freezing Fog', 'fog'],
    51: ['Light Drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Heavy Drizzle', 'rain'],
    56: ['Freezing Drizzle', 'rain'], 57: ['Freezing Drizzle', 'rain'],
    61: ['Light Rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy Rain', 'rain'],
    66: ['Freezing Rain', 'rain'], 67: ['Freezing Rain', 'rain'],
    71: ['Light Snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy Snow', 'snow'], 77: ['Snow Grains', 'snow'],
    80: ['Rain Showers', 'rain'], 81: ['Rain Showers', 'rain'], 82: ['Violent Showers', 'rain'],
    85: ['Snow Showers', 'snow'], 86: ['Snow Showers', 'snow'],
    95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm, Hail', 'storm'], 99: ['Thunderstorm, Hail', 'storm']
  };

  // Compact glyphs for the 7-day strip (the big animated art is separate).
  const KIND_GLYPH = { clear: '☀', partly: '⛅', cloudy: '☁',
    rain: '🌧', snow: '❄', storm: '⛈', fog: '🌫' };

  let lastDaily = null;

  // The strip is also gated by a CSS container query, so this only decides
  // whether the setting allows it - the widget's height decides the rest.
  function renderForecast(daily) {
    const el = $('weather-forecast');
    el.classList.toggle('on', settings.weather.forecast !== false);
    if (!daily || !daily.time) { el.innerHTML = ''; return; }
    let html = '';
    for (let i = 0; i < daily.time.length && i < 7; i++) {
      const label = i === 0 ? 'Today'
        : new Date(`${daily.time[i]}T00:00`).toLocaleDateString(undefined, { weekday: 'short' });
      const [, kind] = WMO[daily.weather_code ? daily.weather_code[i] : 3] || ['', 'partly'];
      html += `<div class="fc-day"><div class="fc-name">${label}</div>` +
        `<div class="fc-ico">${KIND_GLYPH[kind] || '⛅'}</div>` +
        `<div class="fc-temp"><span class="fc-hi">${Math.round(daily.temperature_2m_max[i])}°</span>` +
        `<span class="fc-lo">${Math.round(daily.temperature_2m_min[i])}°</span></div></div>`;
    }
    el.innerHTML = html;
  }

  function renderWeatherArt(kind, isDay) {
    const art = $('weather-art');
    const atm = $('weather-atmosphere');
    const orb = isDay ? '<div class="weather-sun"></div>' : '<div class="weather-moon"></div>';
    const drops = (cls, n) => Array.from({ length: n }, (_, i) =>
      `<div class="${cls}" style="right:${22 + i * 12}px;bottom:${16 + (i % 2) * 6}px;animation-delay:${(i * 0.27).toFixed(2)}s"></div>`
    ).join('');

    const scenes = {
      clear: orb,
      partly: orb + '<div class="weather-cloud"></div>',
      cloudy: '<div class="weather-cloud big"></div><div class="weather-cloud"></div>',
      fog: '<div class="weather-cloud"></div>' +
        [0, 1, 2].map((i) => `<div class="weather-fog" style="bottom:${18 + i * 10}px;animation-delay:${i}s"></div>`).join(''),
      rain: '<div class="weather-cloud dark big"></div>' + drops('weather-drop', 5),
      snow: '<div class="weather-cloud big"></div>' + drops('weather-flake', 5),
      storm: '<div class="weather-cloud dark big"></div><div class="weather-bolt"></div>' + drops('weather-drop', 4)
    };
    art.innerHTML = scenes[kind] || scenes.partly;

    atm.className = 'weather-atmosphere';
    if (kind === 'storm') atm.classList.add('storm');
    else if (kind === 'rain' || kind === 'snow') atm.classList.add('rain');
    else if (!isDay) atm.classList.add('night');
  }

  let weatherTimer = null;
  async function updateWeather() {
    clearTimeout(weatherTimer);
    const w = settings.weather;
    $('weather-location').textContent = w.label;
    const params = new URLSearchParams({
      latitude: w.latitude,
      longitude: w.longitude,
      current: 'temperature_2m,weather_code,is_day',
      daily: 'temperature_2m_max,temperature_2m_min,weather_code',
      temperature_unit: w.unit,
      timezone: 'auto',
      forecast_days: '7'
    });
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const code = data.current.weather_code;
      const [desc, kind] = WMO[code] || ['Unknown', 'partly'];
      $('weather-temp').textContent = `${Math.round(data.current.temperature_2m)}°`;
      $('weather-desc').textContent = desc;
      $('weather-hilo').textContent =
        `H: ${Math.round(data.daily.temperature_2m_max[0])}° L: ${Math.round(data.daily.temperature_2m_min[0])}°`;
      renderWeatherArt(kind, data.current.is_day === 1);
      lastDaily = data.daily;
      renderForecast(lastDaily);
      weatherTimer = setTimeout(updateWeather, 15 * 60 * 1000);
    } catch (err) {
      console.warn('Weather update failed:', err);
      $('weather-desc').textContent = 'Offline - retrying';
      weatherTimer = setTimeout(updateWeather, 60 * 1000);
    }
  }
  updateWeather();
  window.addEventListener('online', updateWeather);

  // ---------------------------------------------------------------
  // Scratchpad (persisted to disk via settings store)
  // ---------------------------------------------------------------
  const textarea = $('scratchpad');
  $('btn-scratch-save').addEventListener('click', async () => {
    const status = $('scratch-status');
    const res = await aero.saveScratchpad(textarea.value);
    status.textContent = res.saved ? 'SAVED \u2713' : res.error ? 'FAILED' : '.MD';
    if (res.error) console.warn('Scratchpad save failed:', res.error);
    setTimeout(() => { status.textContent = '.MD'; }, 1600);
  });
  textarea.value = settings.scratchpad || '';
  let saveTimer = null;
  textarea.addEventListener('input', () => {
    $('scratch-status').textContent = '...';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await aero.setSettings({ scratchpad: textarea.value });
      $('scratch-status').textContent = 'SAVED';
      setTimeout(() => { $('scratch-status').textContent = '.MD'; }, 1200);
    }, 500);
  });
  // Tab inserts indentation instead of leaving the textarea.
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end');
      textarea.dispatchEvent(new Event('input'));
    }
  });

  // ---------------------------------------------------------------
  // Search widget: typing hands off to the Spotlight launcher window
  // ---------------------------------------------------------------
  const WIDGET_GLYPH = { search: '\uD83D\uDD0D', clock: '\uD83D\uDD52', weather: '\u26C5', telemetry: '\uD83D\uDCCA', media: '\uD83C\uDFB5', scratchpad: '\uD83D\uDCDD', files: '\uD83D\uDCC1' };
  const WIDGET_NAME = { search: 'Search', clock: 'Chronometer', weather: 'Weather', telemetry: 'System telemetry', media: 'Media controller', scratchpad: 'Scratchpad', files: 'Files' };
  let voiceNames = null;   // TTS voices, filled lazily (used by applySettings before the voice section below)
  const searchInput = $('search-input');
  async function refreshHotkeyLabel() {
    const hk = await aero.searchHotkey();
    $('search-kbd').textContent = hk ? hk.replace('Control', 'Ctrl').replace('Super', 'Win') : '';
  }
  function openSearch() {
    aero.openSearch(searchInput.value);
    // Deliberately NOT cleared here: the Spotlight window takes the OS focus
    // a few frames from now, and any keys typed in that gap still land in
    // this input - each one resends the full text, so nothing is dropped.
  }
  searchInput.addEventListener('input', () => { if (searchInput.value) openSearch(); });
  // Once focus actually leaves this window (Spotlight owns it now), reset.
  window.addEventListener('blur', () => { searchInput.value = ''; searchInput.blur(); });
  // A Linux dock-type window may never blur, so that reset cannot be the
  // only one: once the handoff gap has safely passed, clear regardless.
  if (aero.platform === 'linux') {
    let resetTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => { searchInput.value = ''; searchInput.blur(); }, 900);
    });
  }
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openSearch();
    if (e.key === 'Escape') { closeRecent(); searchInput.blur(); }
  });
  document.querySelector('.search-widget').addEventListener('click', (e) => {
    if (e.target === searchInput) { if (!searchInput.value) openRecent(); return; }
    openSearch();
  });

  // Click into the empty search bar: recent files (newest first, with when)
  // and recent apps below. Typing goes to Spotlight as before.
  let recentEl = null;
  function when(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (ms >= today.getTime()) return `Today ${t}`;
    if (ms >= today.getTime() - 86400000) return `Yesterday ${t}`;
    if (Date.now() - ms < 6 * 86400000) return `${d.toLocaleDateString([], { weekday: 'long' })} ${t}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })} ${t}`;
  }
  function closeRecent() { if (recentEl) { recentEl.remove(); recentEl = null; } }
  async function openRecent() {
    if (recentEl) return;
    const box = document.querySelector('.search-widget').getBoundingClientRect();
    recentEl = document.createElement('div');
    recentEl.className = 'recent-panel widget-hit';
    recentEl.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - 368))}px`;
    recentEl.style.width = `${Math.max(320, Math.min(520, box.width))}px`;
    recentEl.style.top = `${box.bottom + 6}px`;
    recentEl.innerHTML = '<div class="recent-head">RECENT FILES</div><div class="recent-list recent-files"><div class="recent-empty">Loading…</div></div><div class="recent-head">RECENT APPS</div><div class="recent-list recent-apps"></div>';
    document.body.appendChild(recentEl);
    const panel = recentEl;
    const r = await aero.searchRecent();
    if (panel !== recentEl) return;
    const fill = (sel, items, kind, empty) => {
      const list = panel.querySelector(sel);
      list.innerHTML = '';
      if (!items.length) { list.innerHTML = `<div class="recent-empty">${empty}</div>`; return; }
      for (const it of items) {
        const row = document.createElement('button');
        row.className = 'recent-row';
        row.title = it.path;
        row.innerHTML = `<span class="ri"></span><span class="rn"></span><span class="rt"></span>`;
        row.querySelector('.rn').textContent = it.name;
        row.querySelector('.rt').textContent = when(it.time);
        row.addEventListener('mousedown', (e) => e.preventDefault());       // keep focus in the search bar
        row.addEventListener('click', () => { closeRecent(); aero.searchOpenRecent(it.path, kind); });
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); if (kind === 'file') { closeRecent(); aero.filesReveal(it.path); } });
        list.appendChild(row);
        aero.searchRecentIcon(it.path, kind).then((url) => { if (url) row.querySelector('.ri').innerHTML = `<img src="${url}" alt="">`; });
      }
    };
    fill('.recent-files', (r && r.files) || [], 'file', 'No recent files.');
    fill('.recent-apps', (r && r.apps) || [], 'app', 'Apps you open will appear here.');
  }
  searchInput.addEventListener('input', () => closeRecent());
  searchInput.addEventListener('blur', () => setTimeout(closeRecent, 150));
  document.addEventListener('mousedown', (e) => { if (recentEl && !recentEl.contains(e.target) && e.target !== searchInput) closeRecent(); });
  refreshHotkeyLabel();
  // Spotlight registers its hotkey shortly after startup.
  setTimeout(refreshHotkeyLabel, 1500);

  // ---------------------------------------------------------------
  // Settings panel
  // ---------------------------------------------------------------
  const panel = $('settings');
  let recordingHotkey = false;
  let recordingDockHotkey = false;   // declared early: applySettings reads it
  let recordingVoiceHotkey = false;
  const weatherKey = (w) => JSON.stringify([w.latitude, w.longitude, w.unit]);

  function applySettings(s) {
    const prevWeather = weatherKey(settings.weather);
    settings = s;
    for (const [k, v] of Object.entries(s.themeVars || {})) document.documentElement.style.setProperty(k, v);
    AeroExtensions.onTheme(s.themeVars || {});
    for (const el of document.querySelectorAll('[data-widget]')) {
      el.classList.toggle('hidden', s.widgets[el.dataset.widget] === false);
    }
    AeroExtensions.renderWebWidgets(s.webWidgets || []);
    AeroTasks.update(s);
    AeroLayout.update(s);
    if (clockKey(s) !== lastClockKey) { lastClockKey = clockKey(s); AeroClock.render($('clock-face'), s); }
    if (telKey(s) !== lastTelKey) { lastTelKey = telKey(s); AeroTelemetry.render(s); }
    syncPanel(s);
    $('weather-location').textContent = s.weather.label;
    renderForecast(lastDaily);
    if (weatherKey(s.weather) !== prevWeather) updateWeather();
  }

  // Reflect settings into the panel controls (skipping the one being edited).
  const themes = await aero.listThemes();
  const swatchBox = $('theme-swatches');
  for (const t of themes) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.preset = t.id;
    b.textContent = t.name.replace(' (default)', '');
    b.style.background = `linear-gradient(135deg, rgba(255,255,255,${t.glow}), transparent 60%), ` +
      `rgba(${parseInt(t.tint.slice(1, 3), 16)}, ${parseInt(t.tint.slice(3, 5), 16)}, ${parseInt(t.tint.slice(5, 7), 16)}, ${Math.max(0.35, t.tintAlpha)})`;
    b.style.color = t.text;
    b.style.borderRadius = `${Math.min(12, t.radius)}px`;
    b.style.setProperty('--sw-accent', t.accent);
    b.addEventListener('click', () => aero.replaceSettings('theme', { preset: t.id, custom: null }));
    swatchBox.appendChild(b);
  }
  const resolvedTheme = (s) => ({ ...(themes.find((t) => t.id === s.theme.preset) || themes[0]), ...(Object.fromEntries(
    Object.entries(s.theme.custom || {}).filter(([, v]) => v !== null && v !== '' && v !== undefined))) });
  const setVal = (el, v) => { if (el && document.activeElement !== el) el.value = v; };

  function syncPanel(s) {
    setVal($('set-unit'), s.weather.unit);
    setVal($('set-dock'), s.dock);
    if ($('set-dock-display').options.length) {
      setVal($('set-dock-display'), String(s.dockDisplay ?? $('set-dock-display').dataset.primary));
    }
    setVal($('set-opacity'), Math.round(s.opacity * 100));
    $('opacity-val').textContent = `${Math.round(s.opacity * 100)}%`;
    $('set-24h').checked = s.use24h;
    $('set-top').checked = s.alwaysOnTop;
    $('set-snap').checked = !!s.snapToGrid;
    $('set-locked').checked = !!s.locked;
    setVal($('set-dock-align'), (s.dock && s.dock.align) || 'center');
    $('set-dock-uac').checked = !s.appDock || s.appDock.uacShield !== false;
    $('set-dock-trash').checked = !s.appDock || s.appDock.trash !== false;
    $('set-uac-row').classList.toggle('hidden', !navigator.userAgent.includes('Windows'));
    $('set-startup').checked = s.launchAtStartup;
    const aiCfg = s.ai || {};
    const aiEl = document.querySelector('.ai-widget');
    if (aiEl) aiEl.classList.toggle('hidden', s.widgets.ai === false || aiCfg.enabled === false || !!aiCfg.minimized);
    if (aiEl) aiEl.style.setProperty('--ai-zoom', String(Math.max(0.8, Math.min(1.6, Number(aiCfg.zoom) || 1))));
    // Built-in widgets parked in the dock.
    const parkedIds = Object.entries(s.widgetMinimized || {}).filter(([, v]) => v).map(([k]) => k);
    for (const el of document.querySelectorAll('#sidebar > .widget[data-widget]')) {
      const wid = el.dataset.widget;
      if (wid === 'ai') continue;
      if (parkedIds.includes(wid) && s.widgets[wid] !== false) el.classList.add('hidden');
    }
    if (window.AeroExtensions && AeroExtensions.setParkedWidgets) {
      AeroExtensions.setParkedWidgets(parkedIds.filter((id) => s.widgets[id] !== false && WIDGET_GLYPH[id]).map((id) => ({ id, name: WIDGET_NAME[id] || id, glyph: WIDGET_GLYPH[id] })));
    }
    $('set-spellcheck').checked = (s.spellcheck || {}).enabled !== false;
    const pm = s.powerMenu || {};
    $('set-power-enabled').checked = pm.enabled !== false;
    $('set-power-side').value = pm.side === 'left' ? 'left' : 'right';
    $('set-power-side').disabled = pm.enabled === false;
    if (window.AeroPower) AeroPower.update(s);
    $('scratchpad').spellcheck = (s.spellcheck || {}).enabled !== false;
    if (window.AeroExtensions && AeroExtensions.setAiMinimized) AeroExtensions.setAiMinimized(!!aiCfg.minimized && aiCfg.enabled !== false && s.widgets.ai !== false);
    $('set-ai-enabled').checked = aiCfg.enabled !== false;
    if (document.activeElement !== $('set-ai-persona')) $('set-ai-persona').value = aiCfg.systemPrompt || '';
    $('set-ai-permission').value = aiCfg.permission || 'ask';
    if (document.activeElement !== $('set-ai-steps')) $('set-ai-steps').value = Number(aiCfg.maxSteps) || 12;
    if (document.activeElement !== $('set-ai-context')) $('set-ai-context').value = Number(aiCfg.contextTokens) || '';
    $('set-ai-compact').checked = aiCfg.compactWithModel !== false;
    $('set-ai-toolcalls').value = aiCfg.toolCalls || 'auto';
    $('set-ai-unload').value = aiCfg.unloadAfter || '1m';
    $('set-ai-evict').value = aiCfg.evictBlocking || 'ask';
    $('set-ai-browser').value = aiCfg.browserMode || 'main';
    $('set-ai-bus-desktop').checked = !!aiCfg.busOperateDesktop;
    $('set-ai-follow-shared').checked = aiCfg.followSharedModel !== false;
    fillBrowsers(aiCfg.browser || '');
    $('set-ai-memory').checked = aiCfg.memoryEnabled !== false;
    const vc = aiCfg.voice || {};
    if (window.__applyVoiceSettings) window.__applyVoiceSettings(vc);
    if (window.AeroAi && AeroAi.setVoice) AeroAi.setVoice(vc);
    $('set-notify-toast').checked = (s.notifications || {}).toast !== false;
    $('set-notify-capture').checked = (s.notifications || {}).captureSystem !== false;
    if (aero.notifyCaptureStatus) aero.notifyCaptureStatus().then(showCapture).catch(() => {});
    refreshAiStatus();
    if (!recordingDockHotkey && s.appDock && s.appDock.hotkey) {
      aero.dockHotkey().then((hk) => { $('set-dock-hotkey').value = AeroHotkey.pretty(hk || s.appDock.hotkey); });
    }
    $('set-update-auto').checked = (s.updates || {}).auto !== false;
    $('set-update-notify').checked = (s.updates || {}).notify !== false;
    if (!recordingHotkey) $('set-hotkey').value = AeroHotkey.pretty(s.search.hotkey) || s.search.hotkey;
    setVal($('set-web-engine'), s.search.webEngine || 'bing');
    for (const cb of document.querySelectorAll('[data-toggle]')) cb.checked = s.widgets[cb.dataset.toggle];
    setVal($('set-city'), s.weather.city);
    $('set-forecast').checked = s.weather.forecast !== false;

    const th = resolvedTheme(s);
    for (const el of document.querySelectorAll('[data-theme]')) setVal(el, th[el.dataset.theme]);
    for (const b of swatchBox.children) b.classList.toggle('active', b.dataset.preset === s.theme.preset && !s.theme.custom);

    const c = s.clock;
    setVal($('set-clock-style'), c.style);
    $('set-clock-digital').checked = c.digital;
    $('set-clock-digital').disabled = !['analog', 'classic', 'minimal'].includes(c.style);
    $('set-clock-seconds').checked = c.showSeconds;
    $('set-clock-date').checked = c.showDate;
    $('set-clock-smooth').checked = c.smooth;
    setVal($('set-clock-accent'), c.accent || th.accent);

    const t = s.telemetry;
    setVal($('set-tel-style'), t.style);
    for (const cb of document.querySelectorAll('[data-metric]')) cb.checked = !!t.metrics[cb.dataset.metric];
    for (const el of document.querySelectorAll('[data-metric-color]')) setVal(el, t.colors[el.dataset.metricColor]);
    setVal($('set-tel-drive'), t.drive);
    $('set-tel-cores').checked = t.showCores;
    $('set-tel-values').checked = t.showValues;
    $('set-tel-footer').checked = t.showFooter;
    setVal($('set-tel-interval'), String(t.interval));
    setVal($('set-tel-history'), t.history);
    $('tel-history-val').textContent = `${t.history} samples`;
    setVal($('set-tel-warn'), t.warnAt);
    $('tel-warn-val').textContent = `${t.warnAt}%`;
    setVal($('set-tel-thickness'), t.thickness);
    $('tel-thick-val').textContent = `${t.thickness}px`;
  }

  applySettings(settings);
  aero.onSettingsChanged(applySettings);

  function openSettings(section) {
    panel.classList.remove('hidden');
    $('toolbar').classList.add('pinned');
    AeroLayout.positionSettings();
    if (typeof section === 'string') {
      // 'webwidget' is a deep link to the creation field inside Extensions.
      const target = section === 'webwidget' ? 'extensions' : section;
      const d = panel.querySelector(`details[data-section="${target}"]`);
      if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); }
      if (section === 'webwidget') {
        const url = $('webw-url');
        url.scrollIntoView({ block: 'center' });
        url.focus();
      }
    }
  }
  function closeSettings() {
    panel.classList.add('hidden');
    $('toolbar').classList.remove('pinned');
    $('city-results').innerHTML = '';
  }
  aero.onOpenSettings(openSettings);
  $('btn-settings').addEventListener('click', () => panel.classList.contains('hidden') ? openSettings() : closeSettings());

  // Every built-in widget can be parked in the dock (the AI chat and web
  // widgets have their own buttons; the dock itself stays).
  for (const el of document.querySelectorAll('#sidebar > .widget[data-widget]')) {
    const wid = el.dataset.widget;
    if (wid === 'ai' || wid === 'tasks' || wid === 'media' || !WIDGET_GLYPH[wid]) continue;
    const b = document.createElement('button');
    b.className = 'icon-btn widget-min';
    b.title = 'Minimize to the dock';
    b.textContent = '\u2014';
    b.addEventListener('click', (e) => { e.stopPropagation(); aero.setSettings({ widgetMinimized: { [wid]: true } }); });
    // A widget with its own header row (the file browser) gets the button
    // as the last one in that row, not floating over its other buttons.
    const head = el.querySelector(':scope > .files-head');
    if (head) head.appendChild(b); else el.appendChild(b);
  }

  // AI chat text zoom.
  const aiZoom = async (delta) => {
    const cur = Number(((await aero.getSettings()).ai || {}).zoom) || 1;
    const next = Math.round(Math.max(0.8, Math.min(1.6, cur + delta)) * 10) / 10;
    aero.setSettings({ ai: { zoom: next } });
  };
  const zi = document.querySelector('.ai-zoom-in'); const zo = document.querySelector('.ai-zoom-out');
  if (zi) zi.addEventListener('click', () => aiZoom(0.1));
  if (zo) zo.addEventListener('click', () => aiZoom(-0.1));
  $('set-spellcheck').addEventListener('change', (e) => aero.setSettings({ spellcheck: { enabled: e.target.checked } }));
  $('set-power-enabled').addEventListener('change', (e) => aero.setSettings({ powerMenu: { enabled: e.target.checked } }));
  $('set-power-side').addEventListener('change', (e) => aero.setSettings({ powerMenu: { side: e.target.value } }));

  // Linux: say which window source the dock runs on and offer the GNOME helper.
  async function refreshDockHelper() {
    if (aero.platform !== 'linux' || !aero.taskSource) return;
    const st = await aero.taskSource();
    const row = $('dock-helper-row');
    row.classList.remove('hidden');
    const words = { shell: 'GNOME Shell helper (windows, focus, minimize)', x11: 'X11 window list (wmctrl)', proc: 'running applications only (no window list on Wayland without the helper)' };
    $('dock-helper-status').textContent = `Dock window source: ${words[st.source] || st.source}.`
      + (st.source === 'proc' && st.gnome ? (st.helperInstalled ? ' Helper installed - enable it in Extensions and log out and back in.' : ' Install the helper to mirror real windows.') : '');
    $('btn-dock-helper').classList.toggle('hidden', st.source === 'shell' || !st.gnome);
    $('btn-dock-helper').textContent = st.helperInstalled ? 'Reinstall GNOME dock helper' : 'Install GNOME dock helper';
  }
  $('btn-dock-helper').addEventListener('click', async () => {
    const r = await aero.installDockHelper();
    $('dock-helper-status').textContent = r.ok
      ? `Helper copied to ${r.dest}. ${r.enabled ? 'Enabled.' : 'Enable "BE-Aero Dock helper" in the Extensions app.'} On Wayland, log out and back in for GNOME Shell to load it.`
      : `Could not install the helper: ${r.error}`;
  });
  refreshDockHelper();
  // The full app menu, in-window: desktops without a tray (stock GNOME)
  // would otherwise lose every tray-only control.
  $('btn-menu').addEventListener('click', () => aero.openMenu());
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('btn-hide').addEventListener('click', () => { closeSettings(); setCapture(false); aero.hide(); });
  $('btn-quit').addEventListener('click', () => aero.quit());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

  $('set-unit').addEventListener('change', (e) => aero.setSettings({ weather: { unit: e.target.value } }));
  $('set-dock').addEventListener('change', (e) => aero.setSettings({ dock: e.target.value }));
  $('set-dock-display').addEventListener('change', (e) => aero.setSettings({ dockDisplay: Number(e.target.value) }));
  $('set-opacity').addEventListener('input', (e) => aero.setSettings({ opacity: Number(e.target.value) / 100 }));
  // Hotkey recorder: click the box, press any modifier combination.
  const hotkeyInput = $('set-hotkey');
  const hotkeyStatus = $('hotkey-status');
  const HOTKEY_IDLE = 'Click the box and press any combination, e.g. Ctrl + Alt + K.';

  async function saveHotkey(accel) {
    const s = await aero.setSettings({ search: { hotkey: accel } });
    const actual = await aero.searchHotkey();
    hotkeyInput.value = AeroHotkey.pretty(actual || s.search.hotkey);
    refreshHotkeyLabel();
    if (actual && AeroHotkey.normalize(actual) !== AeroHotkey.normalize(accel)) {
      // Another app already owns it, so Spotlight fell back to a free one.
      hotkeyStatus.textContent =
        `${AeroHotkey.pretty(accel)} is already taken by another app - using ${AeroHotkey.pretty(actual)} instead.`;
    } else if (!actual) {
      hotkeyStatus.textContent = `Could not register ${AeroHotkey.pretty(accel)} - try another combination.`;
    } else {
      hotkeyStatus.textContent = `Search opens with ${AeroHotkey.pretty(actual)}.`;
    }
  }

  // Start on click as well as focus: this window is click-through until the
  // pointer is over a widget, so the focus event alone is not dependable.
  function startRecording() {
    if (recordingHotkey) return;
    recordingHotkey = true;
    hotkeyInput.classList.add('recording');
    hotkeyStatus.textContent = 'Listening - press a combination, or Esc to cancel.';
  }
  hotkeyInput.addEventListener('focus', startRecording);
  hotkeyInput.addEventListener('click', () => { hotkeyInput.focus(); startRecording(); });
  hotkeyInput.addEventListener('blur', () => {
    if (!recordingHotkey) return;
    recordingHotkey = false;
    hotkeyInput.classList.remove('recording');
    hotkeyInput.value = AeroHotkey.pretty(settings.search.hotkey) || settings.search.hotkey;
    if (hotkeyStatus.textContent.startsWith('Listening')) hotkeyStatus.textContent = HOTKEY_IDLE;
  });
  hotkeyInput.addEventListener('keydown', async (e) => {
    if (!recordingHotkey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { hotkeyInput.blur(); return; }
    if (AeroHotkey.isModifierCode(e.code)) {
      // Show the combination building up as modifiers are held.
      const held = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win']
        .filter(Boolean).join(' + ');
      hotkeyInput.value = held ? `${held} + ...` : '';
      return;
    }
    const accel = AeroHotkey.fromEvent(e);
    if (!accel) {
      hotkeyStatus.textContent = 'That needs at least one modifier (Ctrl, Alt, Shift or Win).';
      return;
    }
    recordingHotkey = false;
    hotkeyInput.blur();
    await saveHotkey(accel);
  });
  $('btn-hotkey-reset').addEventListener('click', () => saveHotkey('Alt+Space'));

  // ---- AI assistant settings ----
  let aiPresets = [];
  async function refreshAiStatus() {
    const st = await aero.aiStatus();
    if (!st) return;
    aiPresets = st.presets || [];
    const sel = $('set-ai-provider');
    if (!sel.options.length) {
      for (const p of aiPresets) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; sel.appendChild(o); }
    }
    sel.value = st.provider;
    const preset = aiPresets.find((p) => p.id === st.provider) || {};
    if (document.activeElement !== $('set-ai-url')) $('set-ai-url').value = st.baseUrl || '';
    $('set-ai-url').disabled = st.provider === 'anthropic';
    $('set-ai-url').placeholder = st.provider === 'anthropic' ? 'Default Anthropic endpoint' : st.provider === 'becode' ? 'unix://~/.be-code/api/api.sock' : st.provider === 'ollamalan' ? 'Server address (e.g. 192.168.1.20)' : 'Server URL (e.g. http://localhost:11434/v1)';
    if (document.activeElement !== $('set-ai-model')) $('set-ai-model').value = st.model || '';
    fillTaskProvider(st);
    fillTaskModel(st.model || '');
    $('set-ai-key').placeholder = st.hasKey ? 'API key saved (enter a new one to replace)' : (preset.needsKey ? 'API key (required)' : 'API key (optional)');
    const line = !st.enabled ? 'AI assistant is disabled.'
      : (preset.needsKey && !st.hasKey) ? `${st.presetLabel}: add an API key to start.`
      : !st.model ? `${st.presetLabel}: choose a model (Fetch models lists what is available).`
      : `Ready: ${st.presetLabel} · ${st.model}${st.permission === 'allow' ? ' · acts without asking' : st.permission === 'deny' ? ' · read-only' : ''}`;
    $('ai-status').textContent = line;
    $('ai-provider-hint').textContent = st.hint || '';
    $('ai-context-hint').textContent = `Current budget: ${Number(st.contextBudget || 0).toLocaleString()} tokens${st.contextTokens ? '' : ' (automatic for this provider)'}. Old tool output is trimmed first, then the older conversation is summarized and carried forward; the chat history itself is never deleted. Type /compact in a chat to do it now.`;
  }
  $('set-ai-context').addEventListener('change', (e) => aero.setSettings({ ai: { contextTokens: Math.max(0, Number(e.target.value) || 0) } }).then(refreshAiStatus));
  $('set-ai-compact').addEventListener('change', (e) => aero.setSettings({ ai: { compactWithModel: e.target.checked } }));
  $('set-ai-toolcalls').addEventListener('change', (e) => aero.setSettings({ ai: { toolCalls: e.target.value } }));
  $('set-ai-unload').addEventListener('change', (e) => aero.setSettings({ ai: { unloadAfter: e.target.value } }));
  $('set-ai-evict').addEventListener('change', (e) => aero.setSettings({ ai: { evictBlocking: e.target.value } }));
  $('set-ai-browser').addEventListener('change', (e) => aero.setSettings({ ai: { browserMode: e.target.value } }));
  $('set-ai-bus-desktop').addEventListener('change', (e) => aero.setSettings({ ai: { busOperateDesktop: e.target.checked } }));
  $('set-ai-follow-shared').addEventListener('change', (e) => aero.setSettings({ ai: { followSharedModel: e.target.checked } }));

  // "Browser the assistant uses": the installed browsers (listed once).
  var browserList = null;   // var: fillBrowsers can run before this line
  async function fillBrowsers(saved) {
    const sel = $('set-ai-browser-app');
    if (!browserList) { try { browserList = await aero.aiBrowsers(); } catch { browserList = []; } }
    sel.innerHTML = '';
    const d = document.createElement('option'); d.value = ''; d.textContent = 'My default browser'; sel.appendChild(d);
    for (const b of browserList) { const o = document.createElement('option'); o.value = b.key; o.textContent = b.name; sel.appendChild(o); }
    sel.value = browserList.some((b) => b.key === saved) ? saved : '';
    const cur = browserList.find((b) => b.key === sel.value);
    $('ai-browser-hint').textContent = cur && !cur.cdp
      ? `${cur.name} opens pages; when the assistant has to click or type it uses ${(browserList.find((b) => b.cdp) || { name: 'a Chromium browser' }).name}, because ${cur.name} cannot be automated.`
      : 'Pages open in this browser with your normal profile. To click or type for you, the assistant uses a separate profile of a Chromium browser (Chrome, Edge, Brave).';
  }
  $('set-ai-browser-app').addEventListener('change', async (e) => { await aero.setSettings({ ai: { browser: e.target.value } }); fillBrowsers(e.target.value); });

  // "Model for scheduled tasks": the server's models (fetched once per
  // section open), plus whatever is saved even if the list is unavailable.
  let serverModels = null;
  let taskProviderSet = false;
  async function fillTaskModel(chatModel) {
    const sel = $('set-ai-task-model');
    const saved = ((await aero.getSettings()).ai || {}).taskModel || '';
    let err = '';
    if (serverModels === null) {
      serverModels = [];
      try { const r = await aero.aiModels('task'); if (r && Array.isArray(r.models)) serverModels = r.models; else if (r && r.error) err = r.error; } catch { /* offline */ }
    }
    const list = [...new Set([...serverModels, ...(saved ? [saved] : [])])];
    sel.innerHTML = '';
    const d = document.createElement('option'); d.value = '';
    d.textContent = taskProviderSet ? (list.length ? 'Choose a model' : `No models listed${err ? ` (${err})` : ''}`) : `Same as the chat model${chatModel ? ` (${chatModel})` : ''}`;
    sel.appendChild(d);
    for (const m of list) { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); }
    sel.value = saved;
  }
  $('set-ai-task-model').addEventListener('change', (e) => aero.setSettings({ ai: { taskModel: e.target.value } }));

  // "Provider for scheduled tasks": '' = the chat provider; otherwise its own
  // address and key, so chat and tasks can use different servers at once.
  function fillTaskProvider(st) {
    const sel = $('set-ai-task-provider');
    const chatLabel = (aiPresets.find((p) => p.id === st.provider) || {}).label || st.provider;
    sel.innerHTML = '';
    const d = document.createElement('option'); d.value = ''; d.textContent = `Same as chat (${chatLabel})`; sel.appendChild(d);
    for (const p of aiPresets) { if (p.id === 'becode') continue; const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; sel.appendChild(o); }
    sel.value = st.taskProvider || '';
    taskProviderSet = !!st.taskProvider;
    const preset = aiPresets.find((p) => p.id === st.taskProvider) || {};
    const url = $('set-ai-task-url');
    url.classList.toggle('hidden', !st.taskProvider || st.taskProvider === 'anthropic');
    if (document.activeElement !== url) url.value = st.taskBaseUrl || '';
    url.placeholder = st.taskProvider === 'ollamalan' ? 'Server address (e.g. 192.168.1.20)' : (preset.baseUrl || 'Server URL');
    url.title = st.taskEndpointUrl ? `Tasks connect to ${st.taskEndpointUrl}` : '';
    $('ai-task-key-row').classList.toggle('hidden', !st.taskProvider || !preset.needsKey);
    $('set-ai-task-key').placeholder = st.hasTaskKey ? 'API key saved (enter a new one to replace)' : 'API key for tasks (required)';
    $('ai-task-hint').textContent = st.taskProvider
      ? `Tasks run on ${preset.label}${st.taskEndpointUrl ? ` at ${st.taskEndpointUrl}` : ''}, separately from chat (${chatLabel}). A task can still pick its own model.`
      : 'Tasks run on this model unless a task picks its own. Using the same model as another program on the same server avoids swapping models in and out.';
  }
  $('set-ai-task-provider').addEventListener('change', async (e) => {
    const preset = aiPresets.find((p) => p.id === e.target.value) || {};
    // A model id from another provider would not exist on this one.
    await aero.setSettings({ ai: { taskProvider: e.target.value, taskBaseUrl: e.target.value ? (preset.baseUrl || '') : '', taskModel: '' } });
    serverModels = null;
    refreshAiStatus();
  });
  $('set-ai-task-url').addEventListener('change', async (e) => {
    await aero.setSettings({ ai: { taskBaseUrl: e.target.value.trim(), taskModel: '' } });
    serverModels = null;
    refreshAiStatus();
  });
  $('btn-ai-task-key').addEventListener('click', async () => {
    await aero.aiSetTaskKey($('set-ai-task-key').value);
    $('set-ai-task-key').value = '';
    serverModels = null;
    refreshAiStatus();
  });
  $('btn-ai-models').addEventListener('click', () => { serverModels = null; setTimeout(() => fillTaskModel($('set-ai-model').value), 1200); });
  $('set-ai-enabled').addEventListener('change', (e) => aero.setSettings({ ai: { enabled: e.target.checked } }));
  let personaTimer = null;
  $('set-ai-persona').addEventListener('input', (e) => {
    clearTimeout(personaTimer);
    personaTimer = setTimeout(() => aero.setSettings({ ai: { systemPrompt: e.target.value } }), 500);
  });
  $('set-ai-provider').addEventListener('change', async (e) => {
    const preset = aiPresets.find((p) => p.id === e.target.value) || {};
    await aero.setSettings({ ai: { provider: e.target.value, baseUrl: preset.baseUrl || '', model: preset.model || '' } });
    refreshAiStatus();
  });
  $('set-ai-url').addEventListener('change', (e) => aero.setSettings({ ai: { baseUrl: e.target.value.trim() } }).then(refreshAiStatus));
  $('set-ai-model').addEventListener('change', (e) => aero.setSettings({ ai: { model: e.target.value.trim() } }).then(refreshAiStatus));
  $('btn-ai-key').addEventListener('click', async () => {
    const v = $('set-ai-key').value;
    await aero.aiSetKey(v);
    $('set-ai-key').value = '';
    refreshAiStatus();
  });
  $('btn-ai-models').addEventListener('click', async () => {
    $('ai-status').textContent = 'Fetching models…';
    const r = await aero.aiModels();
    const sel = $('set-ai-model-select');
    sel.innerHTML = '';
    if (r && r.models && r.models.length) {
      const ph = document.createElement('option');
      ph.value = ''; ph.textContent = `Choose a model (${r.models.length} available)`;
      sel.appendChild(ph);
      for (const m of r.models) { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); }
      const cur = $('set-ai-model').value.trim();
      sel.value = r.models.includes(cur) ? cur : '';
      sel.classList.remove('hidden');
      $('ai-status').textContent = `${r.models.length} models available - choose one.`;
      if (!cur && r.models.length === 1) { sel.value = r.models[0]; $('set-ai-model').value = r.models[0]; aero.setSettings({ ai: { model: r.models[0] } }).then(refreshAiStatus); }
    } else if (r && r.models) {
      $('ai-status').textContent = 'The provider returned no models.';
    } else {
      $('ai-status').textContent = `Could not list models: ${r && r.error || 'unknown error'}`;
    }
  });
  $('set-ai-model-select').addEventListener('change', (e) => {
    if (!e.target.value) return;
    $('set-ai-model').value = e.target.value;
    aero.setSettings({ ai: { model: e.target.value } }).then(refreshAiStatus);
  });
  $('set-ai-permission').addEventListener('change', (e) => aero.setSettings({ ai: { permission: e.target.value } }).then(refreshAiStatus));
  async function renderMemory() {
    const list = await aero.aiMemory();
    const box = $('ai-memory-list');
    box.innerHTML = '';
    if (!list.length) { const e = document.createElement('div'); e.className = 'hint-text'; e.textContent = 'Nothing remembered yet.'; box.appendChild(e); return; }
    for (const m of list) {
      const row = document.createElement('div');
      row.className = 'plugin-row';
      row.innerHTML = `<span class="plugin-name" title="${new Date(m.updatedAt).toLocaleString()}">${m.text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}${m.tags && m.tags.length ? ` <small>[${m.tags.join(', ')}]</small>` : ''}</span><button class="icon-btn" title="Forget">\u2715</button>`;
      row.querySelector('button').addEventListener('click', async () => { await aero.aiMemoryForget(m.id); renderMemory(); });
      box.appendChild(row);
    }
  }
  $('set-ai-memory').addEventListener('change', (e) => aero.setSettings({ ai: { memoryEnabled: e.target.checked } }));
  // Voice input + text to speech. Devices are the renderer's (getUserMedia),
  // engines and voices come from main.
  const voiceSet = (patch) => aero.setSettings({ ai: { voice: patch } });
  async function fillVoices(selected) {
    const sel = $('set-ai-voice-name');
    if (!voiceNames) {
      try { voiceNames = (await aero.aiVoiceVoices()).map((v) => ({ name: v.name, label: `${v.name}${v.lang ? ` (${v.lang})` : ''}` })); } catch { voiceNames = []; }
      if (!voiceNames.length && window.speechSynthesis) voiceNames = speechSynthesis.getVoices().map((v) => ({ name: v.name, label: `${v.name} (${v.lang})` }));
    }
    sel.innerHTML = '';
    const d = document.createElement('option'); d.value = ''; d.textContent = 'System default voice'; sel.appendChild(d);
    for (const v of voiceNames) { const o = document.createElement('option'); o.value = v.name; o.textContent = v.label; sel.appendChild(o); }
    sel.value = voiceNames.some((v) => v.name === selected) ? selected : '';
  }
  if (window.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', () => { if (voiceNames && !voiceNames.length) { voiceNames = null; fillVoices($('set-ai-voice-name').value); } });
  function applyVoiceSettings(vc) {
    if (document.activeElement !== $('set-ai-autosend-delay')) $('set-ai-autosend-delay').value = Number(vc.autoSendDelay) || 3;
    $('set-ai-autosend').checked = !!vc.autoSend;
    $('set-ai-continuous').checked = !!vc.continuous;
    if (!recordingVoiceHotkey) aero.voiceHotkey().then((hk) => { $('set-voice-hotkey').value = hk ? AeroHotkey.pretty(hk) : (vc.hotkey === '' ? 'Off' : ''); });
    $('set-ai-engine').value = vc.engine || 'auto';
    $('set-ai-voice-speak').checked = !!vc.speak;
    $('set-ai-tts-interrupt').checked = vc.interrupt !== false;
    $('set-ai-voice-rate').value = Number(vc.rate) || 1;
    $('set-ai-tts-volume').value = vc.volume == null ? 100 : Number(vc.volume);
    $('set-ai-tts-pitch').value = Number(vc.pitch) || 0;
    $('tts-rate-val').textContent = `${Number($('set-ai-voice-rate').value).toFixed(1)}x`;
    $('tts-volume-val').textContent = `${$('set-ai-tts-volume').value}%`;
    const p = Number($('set-ai-tts-pitch').value);
    $('tts-pitch-val').textContent = p ? `${p > 0 ? '+' : ''}${p}%` : 'normal';
    fillVoices(vc.voiceName || '');
    const piperOn = vc.ttsEngine === 'piper';
    $('set-ai-tts-engine').value = piperOn ? 'piper' : 'system';
    $('tts-system-block').classList.toggle('hidden', piperOn);
    $('tts-piper-block').classList.toggle('hidden', !piperOn);
    $('tts-pitch-block').classList.toggle('hidden', piperOn);   // Piper voices have no pitch control
    const setR = (id, valId, v, fmt) => { if (document.activeElement !== $(id)) $(id).value = v; $(valId).textContent = fmt(Number($(id).value)); };
    setR('set-ai-piper-noise', 'piper-noise-val', vc.piperNoise == null ? 0.667 : vc.piperNoise, (x) => x.toFixed(2));
    setR('set-ai-piper-noisew', 'piper-noisew-val', vc.piperNoiseW == null ? 0.8 : vc.piperNoiseW, (x) => x.toFixed(2));
    setR('set-ai-piper-silence', 'piper-silence-val', vc.piperSentenceSilence == null ? 0.2 : vc.piperSentenceSilence, (x) => `${x.toFixed(2)} s`);
    if (piperOn && !piperCatalog) refreshPiper();
  }
  window.__applyVoiceSettings = applyVoiceSettings;

  // ---- Piper: catalog (bundled, 180 voices), language/quality filters,
  // download / remove, multi-speaker voices.
  let piperCatalog = null;
  let piperStatus = null;
  const mb = (n) => `${Math.round(n / 1048576)} MB`;
  async function refreshPiper() {
    try { [piperStatus, piperCatalog] = await Promise.all([aero.aiPiperStatus(), aero.aiPiperCatalog()]); } catch { return; }
    const cfg = ((await aero.getSettings()).ai || {}).voice || {};
    const cur = piperCatalog.find((v) => v.key === cfg.piperVoice) || piperCatalog.find((v) => v.key === 'en_US-lessac-medium') || piperCatalog[0];
    const langSel = $('piper-lang');
    if (!langSel.options.length) {
      const langs = [...new Map(piperCatalog.map((v) => [v.lang, `${v.language} (${v.country || v.lang})`])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
      const inst = document.createElement('option'); inst.value = '*installed'; inst.textContent = 'Installed voices'; langSel.appendChild(inst);
      for (const [code, label] of langs) { const o = document.createElement('option'); o.value = code; o.textContent = label; langSel.appendChild(o); }
      langSel.value = cur ? cur.lang : 'en_US';
    }
    fillPiperVoices(cur ? cur.key : '');
    if (!piperStatus.supported) {
      $('piper-info').textContent = 'Piper downloads are offered for Windows and Linux on x64.';
      $('btn-piper-install').disabled = true;
      return;
    }
    $('piper-info').textContent = piperStatus.engine
      ? `Piper is installed with ${piperStatus.installedVoices.length} voice${piperStatus.installedVoices.length === 1 ? '' : 's'}. Voices run on this computer.`
      : 'Download Piper (22 MB, one time) and a voice. Files come from the official Piper release and voice repository, checked against checksums shipped with BE-Aero.';
  }
  function fillPiperVoices(selected) {
    if (!piperCatalog) return;
    const lang = $('piper-lang').value;
    const q = $('piper-quality').value;
    const list = piperCatalog.filter((v) => (lang === '*installed' ? v.installed : v.lang === lang) && (!q || v.quality === q))
      .sort((a, b) => (b.installed - a.installed) || a.name.localeCompare(b.name) || a.quality.localeCompare(b.quality));
    const sel = $('set-ai-piper-voice');
    sel.innerHTML = '';
    if (!list.length) { const o = document.createElement('option'); o.value = ''; o.textContent = lang === '*installed' ? 'No voices installed yet' : 'No voices match'; sel.appendChild(o); }
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.key;
      o.textContent = `${v.installed ? '\u2713 ' : ''}${v.name} - ${v.quality.replace('_', ' ')}${v.speakers > 1 ? `, ${v.speakers} speakers` : ''} (${mb(v.size)})${v.supported === false ? ' - not supported yet' : ''}`;
      if (v.supported === false) o.disabled = true;
      sel.appendChild(o);
    }
    sel.value = list.some((v) => v.key === selected) ? selected : (list[0] ? list[0].key : '');
    syncPiperButtons();
  }
  async function syncPiperButtons() {
    const v = piperCatalog && piperCatalog.find((x) => x.key === $('set-ai-piper-voice').value);
    const ready = !!(v && v.installed && piperStatus && piperStatus.engine);
    $('btn-piper-install').disabled = !v || ready || !!(piperStatus && piperStatus.installing);
    $('btn-piper-install').textContent = piperStatus && piperStatus.installing ? 'Downloading…' : ready ? 'Installed' : 'Download';
    $('btn-piper-remove').disabled = !(v && v.installed);
    const spRow = $('piper-speaker-row');
    spRow.classList.toggle('hidden', !(v && v.speakers > 1));
    if (v && v.speakers > 1) {
      const cfg = ((await aero.getSettings()).ai || {}).voice || {};
      const sel = $('set-ai-piper-speaker');
      sel.innerHTML = '';
      const names = v.speakerIds ? Object.entries(v.speakerIds).sort((a, b) => a[1] - b[1]) : Array.from({ length: v.speakers }, (_, i) => [`Speaker ${i}`, i]);
      for (const [name, id] of names) { const o = document.createElement('option'); o.value = String(id); o.textContent = `${name} (#${id})`; sel.appendChild(o); }
      sel.value = String(Number(cfg.piperSpeaker) || 0);
    }
  }
  $('set-ai-tts-engine').addEventListener('change', async (e) => { await voiceSet({ ttsEngine: e.target.value }); if (e.target.value === 'piper') refreshPiper(); });
  $('piper-lang').addEventListener('change', () => fillPiperVoices(''));
  $('piper-quality').addEventListener('change', () => fillPiperVoices($('set-ai-piper-voice').value));
  $('set-ai-piper-voice').addEventListener('change', async (e) => {
    const v = piperCatalog && piperCatalog.find((x) => x.key === e.target.value);
    if (v && v.installed) await voiceSet({ piperVoice: v.key, piperSpeaker: 0 });
    syncPiperButtons();
  });
  $('set-ai-piper-speaker').addEventListener('change', (e) => voiceSet({ piperSpeaker: Number(e.target.value) || 0 }));
  $('btn-piper-install').addEventListener('click', async () => {
    const key = $('set-ai-piper-voice').value;
    if (!key) return;
    $('btn-piper-install').disabled = true; $('btn-piper-install').textContent = 'Downloading…';
    $('piper-progress').classList.remove('hidden');
    const r = await aero.aiPiperInstall(key);
    $('piper-progress').classList.add('hidden');
    if (r && r.error) $('piper-info').textContent = `Download failed: ${r.error}`;
    else await voiceSet({ piperVoice: key, piperSpeaker: 0, ttsEngine: 'piper' });
    await refreshPiper();
  });
  $('btn-piper-remove').addEventListener('click', async () => { await aero.aiPiperRemove($('set-ai-piper-voice').value); refreshPiper(); });
  if (aero.onAiPiperProgress) aero.onAiPiperProgress((p) => {
    const bar = $('piper-progress').firstElementChild;
    if (p.stage === 'unpack') { $('piper-info').textContent = 'Unpacking Piper…'; return; }
    if (p.stage === 'done') { bar.style.width = '100%'; return; }
    const pct = p.total ? Math.round((p.got / p.total) * 100) : 0;
    bar.style.width = `${pct}%`;
    $('piper-info').textContent = `Downloading ${p.stage === 'engine' ? 'Piper' : 'the voice'}: ${pct}% (${mb(p.got)} of ${mb(p.total || 0)})`;
  });
  const piperRange = (id, valId, key, fmt) => {
    $(id).addEventListener('input', (e) => { $(valId).textContent = fmt(Number(e.target.value)); });
    $(id).addEventListener('change', (e) => voiceSet({ [key]: Number(e.target.value) }));
  };
  piperRange('set-ai-piper-noise', 'piper-noise-val', 'piperNoise', (x) => x.toFixed(2));
  piperRange('set-ai-piper-noisew', 'piper-noisew-val', 'piperNoiseW', (x) => x.toFixed(2));
  piperRange('set-ai-piper-silence', 'piper-silence-val', 'piperSentenceSilence', (x) => `${x.toFixed(2)} s`);
  aero.getSettings().then((st) => applyVoiceSettings(((st.ai || {}).voice) || {}));   // first paint ran before this was defined
  async function fillDevices() {
    if (!window.AeroAi || !AeroAi.audioDevices) return;
    const cfg = ((await aero.getSettings()).ai || {}).voice || {};
    let devs = { mics: [], speakers: [] };
    try { devs = await AeroAi.audioDevices(); } catch { /* no permission or no devices */ }
    const fill = (sel, list, chosen, none) => {
      sel.innerHTML = '';
      const d = document.createElement('option'); d.value = ''; d.textContent = list.length ? 'System default' : none; sel.appendChild(d);
      for (const x of list) { const o = document.createElement('option'); o.value = x.id; o.textContent = x.label; sel.appendChild(o); }
      sel.value = list.some((x) => x.id === chosen) ? chosen : '';
    };
    fill($('set-ai-mic'), devs.mics, cfg.micId || '', 'No microphone found');
    fill($('set-ai-speaker'), devs.speakers, cfg.speakerId || '', 'No output device found');
  }
  async function refreshVoiceInfo() {
    try {
      const v = await aero.aiVoiceAvailable();
      $('ai-voice-info').textContent = v && v.stt
        ? `Dictation engine: ${v.engine}. Click the microphone in the chat and speak.`
        : `Dictation unavailable: ${v && v.reason || 'unknown'}`;
    } catch { /* fine */ }
  }
  async function refreshWhisper() {
    let st = null;
    try { st = await aero.aiWhisperStatus(); } catch { st = null; }
    const sel = $('set-ai-whisper-model');
    const cfg = ((await aero.getSettings()).ai || {}).voice || {};
    if (!st || !st.supported) {
      sel.innerHTML = '<option>Not available on this system</option>';
      $('btn-ai-whisper-install').disabled = true; $('btn-ai-whisper-remove').disabled = true;
      $('ai-whisper-info').textContent = 'Whisper downloads are offered for Windows and Linux on x64.';
      return;
    }
    sel.innerHTML = '';
    for (const m of st.models) { const o = document.createElement('option'); o.value = m.id; o.textContent = `${m.label}${m.installed ? ' - installed' : ''}`; sel.appendChild(o); }
    sel.value = cfg.whisperModel || 'base.en';
    const chosen = st.models.find((m) => m.id === sel.value) || st.models[0];
    $('btn-ai-whisper-install').disabled = st.installing || (chosen.installed && st.binary);
    $('btn-ai-whisper-install').textContent = st.installing ? 'Downloading…' : (chosen.installed && st.binary) ? 'Installed' : 'Download';
    $('btn-ai-whisper-remove').disabled = !chosen.installed;
    $('ai-whisper-info').textContent = st.installed
      ? `Whisper is installed${st.running ? ' and loaded' : ''}. It runs on this computer; nothing is sent anywhere.`
      : 'Download the Whisper engine and a model (one time). Files come from the official whisper.cpp releases and are checked against pinned checksums.';
    refreshVoiceInfo();
  }
  $('set-ai-whisper-model').addEventListener('change', (e) => voiceSet({ whisperModel: e.target.value }).then(refreshWhisper));
  $('btn-ai-whisper-install').addEventListener('click', async () => {
    const model = $('set-ai-whisper-model').value;
    $('btn-ai-whisper-install').disabled = true;
    $('ai-whisper-progress').classList.remove('hidden');
    const r = await aero.aiWhisperInstall(model);
    $('ai-whisper-progress').classList.add('hidden');
    if (r && r.error) $('ai-whisper-info').textContent = `Download failed: ${r.error}`;
    else await voiceSet({ whisperModel: model });
    refreshWhisper();
  });
  if (aero.onAiWhisperProgress) aero.onAiWhisperProgress((p) => {
    const bar = $('ai-whisper-progress').firstElementChild;
    if (p.stage === 'unpack') { $('ai-whisper-info').textContent = 'Unpacking the engine…'; return; }
    if (p.stage === 'done') { bar.style.width = '100%'; return; }
    const pct = p.total ? Math.round((p.got / p.total) * 100) : 0;
    bar.style.width = `${pct}%`;
    $('ai-whisper-info').textContent = `Downloading the ${p.stage === 'engine' ? 'engine' : 'model'}: ${pct}% (${Math.round(p.got / 1048576)} of ${Math.round((p.total || 0) / 1048576)} MB)`;
  });
  $('btn-ai-whisper-remove').addEventListener('click', async () => { await aero.aiWhisperRemove($('set-ai-whisper-model').value); refreshWhisper(); });
  $('set-ai-engine').addEventListener('change', (e) => voiceSet({ engine: e.target.value }).then(refreshVoiceInfo));
  $('set-ai-mic').addEventListener('change', (e) => voiceSet({ micId: e.target.value }));
  $('set-ai-speaker').addEventListener('change', (e) => voiceSet({ speakerId: e.target.value }));
  $('btn-ai-devices').addEventListener('click', fillDevices);
  $('btn-ai-mic-test').addEventListener('click', async () => {
    const bar = $('ai-mic-meter').firstElementChild;
    const btn = $('btn-ai-mic-test');
    btn.disabled = true; btn.textContent = 'Listening…';
    try {
      const peak = await AeroAi.micTest((l) => { bar.style.width = `${Math.round(l * 100)}%`; });
      $('ai-voice-info').textContent = peak > 0.05 ? `Microphone works (peak level ${Math.round(peak * 100)}%).` : 'No sound reached the microphone - check the device selected above and its Windows privacy setting.';
    } catch (err) { $('ai-voice-info').textContent = `Microphone test failed: ${err && err.message || err}`; }
    bar.style.width = '0%'; btn.disabled = false; btn.textContent = 'Test';
  });
  $('set-ai-autosend').addEventListener('change', (e) => voiceSet({ autoSend: e.target.checked }));
  $('set-ai-continuous').addEventListener('change', (e) => voiceSet({ continuous: e.target.checked }));

  // Voice hotkey recorder (same behaviour as the dock's).
  const vhInput = $('set-voice-hotkey');
  const vhStatus = $('voice-hotkey-status');
  const VH_IDLE = 'Starts and stops voice input from anywhere, with a short tone. Works while other apps have focus.';
  async function saveVoiceHotkey(accel) {
    await voiceSet({ hotkey: accel });
    const actual = await aero.voiceHotkey();
    vhInput.value = actual ? AeroHotkey.pretty(actual) : 'Off';
    if (accel === '') vhStatus.textContent = 'No voice hotkey. Use the microphone button in the chat.';
    else if (!actual) vhStatus.textContent = `Could not register ${AeroHotkey.pretty(accel)} - try another combination.`;
    else if (AeroHotkey.normalize(actual) !== AeroHotkey.normalize(accel)) vhStatus.textContent = `${AeroHotkey.pretty(accel)} is already taken - using ${AeroHotkey.pretty(actual)} instead.`;
    else vhStatus.textContent = `Voice input toggles with ${AeroHotkey.pretty(actual)}.`;
  }
  const startVhRecording = () => {
    if (recordingVoiceHotkey) return;
    recordingVoiceHotkey = true;
    vhInput.classList.add('recording');
    vhStatus.textContent = 'Listening - press a combination, or Esc to cancel.';
  };
  vhInput.addEventListener('focus', startVhRecording);
  vhInput.addEventListener('click', () => { vhInput.focus(); startVhRecording(); });
  vhInput.addEventListener('blur', () => {
    if (!recordingVoiceHotkey) return;
    recordingVoiceHotkey = false;
    vhInput.classList.remove('recording');
    aero.voiceHotkey().then((hk) => { vhInput.value = hk ? AeroHotkey.pretty(hk) : 'Off'; });
    if (vhStatus.textContent.startsWith('Listening')) vhStatus.textContent = VH_IDLE;
  });
  vhInput.addEventListener('keydown', async (e) => {
    if (!recordingVoiceHotkey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { vhInput.blur(); return; }
    if (AeroHotkey.isModifierCode(e.code)) {
      const held = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean).join(' + ');
      vhInput.value = held ? `${held} + ...` : '';
      return;
    }
    const accel = AeroHotkey.fromEvent(e);
    if (!accel) { vhStatus.textContent = 'That needs at least one modifier (Ctrl, Alt, Shift or Win).'; return; }
    recordingVoiceHotkey = false;
    vhInput.blur();
    await saveVoiceHotkey(accel);
  });
  $('btn-voice-hotkey-reset').addEventListener('click', () => saveVoiceHotkey('Control+Alt+M'));
  $('btn-voice-hotkey-off').addEventListener('click', () => saveVoiceHotkey(''));
  $('set-ai-autosend-delay').addEventListener('change', (e) => voiceSet({ autoSendDelay: Math.max(1, Math.min(30, Number(e.target.value) || 3)) }));
  $('set-ai-voice-speak').addEventListener('change', (e) => voiceSet({ speak: e.target.checked }));
  $('set-ai-tts-interrupt').addEventListener('change', (e) => voiceSet({ interrupt: e.target.checked }));
  $('set-ai-voice-name').addEventListener('change', (e) => voiceSet({ voiceName: e.target.value }));
  $('set-ai-voice-rate').addEventListener('input', (e) => { $('tts-rate-val').textContent = `${Number(e.target.value).toFixed(1)}x`; });
  $('set-ai-voice-rate').addEventListener('change', (e) => voiceSet({ rate: Number(e.target.value) || 1 }));
  $('set-ai-tts-volume').addEventListener('input', (e) => { $('tts-volume-val').textContent = `${e.target.value}%`; });
  $('set-ai-tts-volume').addEventListener('change', (e) => voiceSet({ volume: Number(e.target.value) }));
  $('set-ai-tts-pitch').addEventListener('input', (e) => { const p = Number(e.target.value); $('tts-pitch-val').textContent = p ? `${p > 0 ? '+' : ''}${p}%` : 'normal'; });
  $('set-ai-tts-pitch').addEventListener('change', (e) => voiceSet({ pitch: Number(e.target.value) }));
  $('btn-ai-speaker-test').addEventListener('click', async () => {
    const cfg = ((await aero.getSettings()).ai || {}).voice || {};
    if (window.AeroAi) { AeroAi.setVoice(cfg); AeroAi.stopSpeaking(); AeroAi.speak($('tts-test-text').value || 'Testing.'); }
  });
  $('btn-ai-tts-stop').addEventListener('click', () => { if (window.AeroAi) AeroAi.stopSpeaking(); });
  // Devices and engines are read when either voice section opens (needs the mic permission once).
  for (const sec of ['voice', 'tts']) {
    const d = document.querySelector(`details[data-section="${sec}"]`);
    if (d) d.addEventListener('toggle', () => { if (d.open) { fillDevices(); refreshWhisper(); if (sec === 'tts') refreshPiper(); } });
  }
  refreshVoiceInfo();
  $('btn-ai-memory-add').addEventListener('click', async () => {
    const v = $('ai-memory-new').value.trim();
    if (!v) return;
    await aero.aiMemoryAdd(v);
    $('ai-memory-new').value = '';
    renderMemory();
  });
  $('ai-memory-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-ai-memory-add').click(); });
  $('btn-ai-memory-clear').addEventListener('click', async () => { await aero.aiMemoryClear(); renderMemory(); });
  renderMemory();
  aero.aiBrowserInfo().then((b) => {
    $('ai-browser-info').textContent = b && b.available
      ? `${b.browser}${b.isDefault ? ' (your default browser)' : ''} will be driven through DevTools with a dedicated BE-Aero profile - sign in to sites there once.`
      : 'No Chromium-based browser (Chrome, Edge, Brave) found - browser tools are unavailable; web widgets still work.';
  }).catch(() => {});
  // Refresh the memory list when the assistant writes to it.
  aero.onAiEvent((ev) => { if (ev && ev.type === 'tool' && /^memory_/.test(ev.name || '')) renderMemory(); });
  $('set-ai-steps').addEventListener('change', (e) => {
    const n = Math.max(1, Math.min(500, Math.round(Number(e.target.value) || 12)));
    e.target.value = n;
    aero.setSettings({ ai: { maxSteps: n } });
  });
  $('set-notify-toast').addEventListener('change', (e) => aero.setSettings({ notifications: { toast: e.target.checked } }));
  function showCapture(st) {
    const on = !!(st && st.supported);
    $('set-notify-capture-row').classList.toggle('hidden', !on);
    $('notify-capture-hint').classList.toggle('hidden', !on);
    const win = aero.platform === 'win32';
    if (on) $('notify-capture-hint').textContent = st.running
      ? (win ? 'Reading the Windows notification list. Read-only: Windows still shows its own pop-ups.' : `Listening on the desktop bus (${st.tool}). Read-only: the desktop still shows its own pop-ups.`)
      : (!$('set-notify-capture').checked ? 'Off.' : win ? `Not running: ${st.error || 'the Windows notification list could not be read'}.` : 'Not running: neither busctl nor dbus-monitor is available.');
  }
  $('set-notify-capture').addEventListener('change', async (e) => {
    await aero.setSettings({ notifications: { captureSystem: e.target.checked } });
    showCapture(await aero.notifyCapture(e.target.checked));
  });

  // Dock hotkey: same recorder behaviour as the search one.
  const dockHotkeyInput = $('set-dock-hotkey');
  const dockHotkeyStatus = $('dock-hotkey-status');
  const DOCK_HOTKEY_IDLE = 'Brings the dock up over anything on screen - even a game. Press again or pick an app to dismiss.';
  async function saveDockHotkey(accel) {
    const s = await aero.setSettings({ appDock: { hotkey: accel } });
    const actual = await aero.dockHotkey();
    dockHotkeyInput.value = AeroHotkey.pretty(actual || s.appDock.hotkey);
    if (actual && AeroHotkey.normalize(actual) !== AeroHotkey.normalize(accel)) {
      dockHotkeyStatus.textContent =
        `${AeroHotkey.pretty(accel)} is already taken by another app - using ${AeroHotkey.pretty(actual)} instead.`;
    } else if (!actual) {
      dockHotkeyStatus.textContent = `Could not register ${AeroHotkey.pretty(accel)} - try another combination.`;
    } else {
      dockHotkeyStatus.textContent = `The dock comes up with ${AeroHotkey.pretty(actual)}.`;
    }
  }
  function startDockRecording() {
    if (recordingDockHotkey) return;
    recordingDockHotkey = true;
    dockHotkeyInput.classList.add('recording');
    dockHotkeyStatus.textContent = 'Listening - press a combination, or Esc to cancel.';
  }
  dockHotkeyInput.addEventListener('focus', startDockRecording);
  dockHotkeyInput.addEventListener('click', () => { dockHotkeyInput.focus(); startDockRecording(); });
  dockHotkeyInput.addEventListener('blur', () => {
    if (!recordingDockHotkey) return;
    recordingDockHotkey = false;
    dockHotkeyInput.classList.remove('recording');
    dockHotkeyInput.value = AeroHotkey.pretty((settings.appDock || {}).hotkey) || '';
    if (dockHotkeyStatus.textContent.startsWith('Listening')) dockHotkeyStatus.textContent = DOCK_HOTKEY_IDLE;
  });
  dockHotkeyInput.addEventListener('keydown', async (e) => {
    if (!recordingDockHotkey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { dockHotkeyInput.blur(); return; }
    if (AeroHotkey.isModifierCode(e.code)) {
      const held = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win']
        .filter(Boolean).join(' + ');
      dockHotkeyInput.value = held ? `${held} + ...` : '';
      return;
    }
    const accel = AeroHotkey.fromEvent(e);
    if (!accel) {
      dockHotkeyStatus.textContent = 'That needs at least one modifier (Ctrl, Alt, Shift or Win).';
      return;
    }
    recordingDockHotkey = false;
    dockHotkeyInput.blur();
    await saveDockHotkey(accel);
  });
  $('btn-dock-hotkey-reset').addEventListener('click', () => saveDockHotkey('Control+Alt+D'));
  aero.dockHotkey().then((hk) => { if (hk) dockHotkeyInput.value = AeroHotkey.pretty(hk); });

  // Summoned by the hotkey: make the dock the obvious thing on screen.
  aero.onDockSummon((on) => {
    const dockEl = document.querySelector('.tasks-widget');
    if (!dockEl) return;
    dockEl.classList.toggle('summoned', !!on);
    if (on) dockEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  $('set-forecast').addEventListener('change', (e) => aero.setSettings({ weather: { forecast: e.target.checked } }));
  $('set-web-engine').addEventListener('change', (e) => aero.setSettings({ search: { webEngine: e.target.value } }));
  $('set-24h').addEventListener('change', (e) => aero.setSettings({ use24h: e.target.checked }));
  $('set-top').addEventListener('change', (e) => aero.setSettings({ alwaysOnTop: e.target.checked }));
  $('set-startup').addEventListener('change', (e) => aero.setSettings({ launchAtStartup: e.target.checked }));
  $('set-update-auto').addEventListener('change', (e) => aero.setSettings({ updates: { auto: e.target.checked } }));
  $('set-update-notify').addEventListener('change', (e) => aero.setSettings({ updates: { notify: e.target.checked } }));

  function renderUpdateStatus(st) {
    const el2 = $('update-status');
    if (!st || st.state === 'idle') { el2.textContent = ''; return; }
    if (st.state === 'update') {
      el2.textContent = '';
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = `${st.release.version} is available - open the release page`;
      a.addEventListener('click', (e) => { e.preventDefault(); aero.openUpdate(); });
      el2.appendChild(a);
    } else if (st.state === 'checking') {
      el2.textContent = 'Checking...';
    } else if (st.state === 'downloading') {
      el2.textContent = `Downloading ${st.release ? st.release.version : 'update'}... ${st.percent || 0}%`;
    } else if (st.state === 'restarting') {
      el2.textContent = `Installing ${st.release ? st.release.version : 'update'} - restarting...`;
    } else if (st.state === 'current') {
      el2.textContent = `Up to date (latest release: ${st.release ? st.release.version : 'n/a'}).`;
    } else if (st.state === 'none') {
      el2.textContent = 'No published releases yet.';
    } else {
      el2.textContent = `Update check failed: ${st.message}`;
    }
  }
  aero.onUpdateStatus(renderUpdateStatus);
  aero.updateStatus().then(renderUpdateStatus);
  $('btn-check-updates').addEventListener('click', async () => {
    $('update-status').textContent = 'Checking...';
    renderUpdateStatus(await aero.checkUpdates());
  });
  for (const cb of document.querySelectorAll('[data-toggle]')) {
    cb.addEventListener('change', () => aero.setSettings({ widgets: { [cb.dataset.toggle]: cb.checked } }));
  }
  $('set-snap').addEventListener('change', (e) => aero.setSettings({ snapToGrid: e.target.checked }));
  $('set-locked').addEventListener('change', (e) => aero.setSettings({ locked: e.target.checked }));
  $('set-dock-align').addEventListener('change', (e) => aero.setSettings({ dock: { align: e.target.value } }));
  $('set-dock-uac').addEventListener('change', async (e) => {
    await aero.setSettings({ appDock: { uacShield: e.target.checked } });
    if (window.AeroUac) AeroUac.setState(await aero.uacEnable(e.target.checked));
  });
  $('set-dock-trash').addEventListener('change', async (e) => {
    await aero.setSettings({ appDock: { trash: e.target.checked } });
    if (window.AeroTrash) AeroTrash.setState(await aero.trashEnable(e.target.checked));
  });
  $('btn-reset-layout').addEventListener('click', () => AeroLayout.reset());
  $('btn-settings-export').addEventListener('click', () => aero.exportSettings());
  $('btn-settings-import').addEventListener('click', () => aero.importSettings());

  // Theme customisation: every edit becomes a custom override on the preset.
  for (const el of document.querySelectorAll('[data-theme]')) {
    el.addEventListener('input', () => {
      const v = el.type === 'range' ? Number(el.value) : el.value;
      aero.setSettings({ theme: { custom: { [el.dataset.theme]: v } } });
    });
  }
  $('btn-theme-reset').addEventListener('click', () =>
    aero.replaceSettings('theme', { preset: settings.theme.preset, custom: null }));

  // Clock options.
  const clockSet = (patch) => aero.setSettings({ clock: patch });
  $('set-clock-style').addEventListener('change', (e) => clockSet({ style: e.target.value }));
  $('set-clock-digital').addEventListener('change', (e) => clockSet({ digital: e.target.checked }));
  $('set-clock-seconds').addEventListener('change', (e) => clockSet({ showSeconds: e.target.checked }));
  $('set-clock-date').addEventListener('change', (e) => clockSet({ showDate: e.target.checked }));
  $('set-clock-smooth').addEventListener('change', (e) => clockSet({ smooth: e.target.checked }));
  $('set-clock-accent').addEventListener('input', (e) => clockSet({ accent: e.target.value }));
  $('btn-clock-accent-reset').addEventListener('click', () => clockSet({ accent: '' }));

  // Telemetry options.
  const telSet = (patch) => aero.setSettings({ telemetry: patch });
  $('set-tel-style').addEventListener('change', (e) => telSet({ style: e.target.value }));
  for (const cb of document.querySelectorAll('[data-metric]')) {
    cb.addEventListener('change', () => telSet({ metrics: { [cb.dataset.metric]: cb.checked } }));
  }
  for (const el of document.querySelectorAll('[data-metric-color]')) {
    el.addEventListener('change', () => telSet({ colors: { [el.dataset.metricColor]: el.value } }));
  }
  $('set-tel-drive').addEventListener('change', (e) => {
    const raw = e.target.value.trim();
    const v = raw.toUpperCase();
    if (/^[A-Z]:?$/.test(v)) telSet({ drive: v[0] + ':' });
    else if (raw.startsWith('/')) telSet({ drive: raw.replace(/\/+$/, '') || '/' });
  });
  if (aero.platform !== 'win32') { $('set-tel-drive').maxLength = 128; $('set-tel-drive').placeholder = '/'; }
  $('set-tel-cores').addEventListener('change', (e) => telSet({ showCores: e.target.checked }));
  $('set-tel-values').addEventListener('change', (e) => telSet({ showValues: e.target.checked }));
  $('set-tel-footer').addEventListener('change', (e) => telSet({ showFooter: e.target.checked }));
  $('set-tel-interval').addEventListener('change', (e) => telSet({ interval: Number(e.target.value) }));
  $('set-tel-history').addEventListener('change', (e) => telSet({ history: Number(e.target.value) }));
  $('set-tel-warn').addEventListener('change', (e) => telSet({ warnAt: Number(e.target.value) }));
  $('set-tel-thickness').addEventListener('change', (e) => telSet({ thickness: Number(e.target.value) }));
  AeroTelemetry.update(await aero.getTelemetry());

  // ---------------------------------------------------------------
  // Extensions panel: plugin list + local app API
  // ---------------------------------------------------------------
  function renderPluginList(list) {
    const box = $('plugin-list');
    box.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'hint-text';
      empty.textContent = 'No plugins installed yet.';
      box.appendChild(empty);
      return;
    }
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'plugin-row';

      const top = document.createElement('div');
      top.className = 'plugin-top';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = p.enabled;
      cb.title = 'Show this widget';
      cb.addEventListener('change', async () => {
        renderPluginList(await aero.setPluginEnabled(p.id, cb.checked));
      });
      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = `${p.name} ${p.version}`;
      if (p.needsReview) {
        const badge = document.createElement('span');
        badge.className = 'review-badge';
        badge.textContent = 'needs review';
        badge.title = 'This plugin has requested something you have not answered yet.';
        nm.appendChild(badge);
      }
      const ds = document.createElement('div');
      ds.className = 'ds';
      ds.textContent = p.description || (p.author ? `by ${p.author}` : '');
      meta.append(nm, ds);
      top.append(cb, meta);
      row.appendChild(top);

      // Per-permission consent. The user decides; the manifest only requested.
      if (p.permissionState.length) {
        const perms = document.createElement('div');
        perms.className = 'perm-list';
        for (const perm of p.permissionState) {
          const pr = document.createElement('div');
          pr.className = `perm-row risk-${perm.risk} state-${perm.state}`;

          const info = document.createElement('div');
          info.className = 'perm-info';
          const t = document.createElement('div');
          t.className = 'perm-title';
          t.textContent = perm.title;
          const d = document.createElement('div');
          d.className = 'perm-detail';
          d.textContent = perm.detail;
          info.append(t, d);
          if (perm.lastUsed) {
            const u = document.createElement('div');
            u.className = 'perm-used';
            u.textContent = `last used ${new Date(perm.lastUsed).toLocaleString()}`;
            info.appendChild(u);
          }

          const choice = document.createElement('div');
          choice.className = 'perm-choice';
          for (const [state, label] of [['granted', 'Allow'], ['denied', 'Block'], ['undecided', 'Ask']]) {
            const b = document.createElement('button');
            b.className = `chip${perm.state === state ? ' on' : ''}`;
            b.textContent = label;
            b.title = state === 'undecided' ? 'Forget this answer and ask again next time' : label;
            b.addEventListener('click', async () => {
              renderPluginList(await aero.setPermission(p.id, perm.name, state));
            });
            choice.appendChild(b);
          }
          pr.append(info, choice);
          perms.appendChild(pr);
        }
        row.appendChild(perms);

        const reset = document.createElement('button');
        reset.className = 'link-btn';
        reset.textContent = 'Forget all answers for this plugin';
        reset.addEventListener('click', async () => {
          renderPluginList(await aero.resetPermissions(p.id));
        });
        row.appendChild(reset);
      } else {
        const none = document.createElement('div');
        none.className = 'perms';
        none.textContent = 'Requests no permissions.';
        row.appendChild(none);
      }

      // Manifest-declared settings, editable in place. Values land in the
      // plugin's storage, so the plugin sees them via the SDK immediately.
      if (p.settings.length) {
        const box2 = document.createElement('div');
        box2.className = 'plugin-settings';
        for (const sc of p.settings) {
          const val = p.settingsValues[sc.key];
          const save = (v) => aero.setPluginSetting(p.id, sc.key, v).then(renderPluginList);
          let field;
          if (sc.type === 'checkbox') {
            const lbl = document.createElement('label');
            lbl.className = 'check';
            const cb2 = document.createElement('input');
            cb2.type = 'checkbox';
            cb2.checked = !!val;
            cb2.addEventListener('change', () => save(cb2.checked));
            lbl.append(cb2, document.createTextNode(` ${sc.label}`));
            box2.appendChild(lbl);
            continue;
          }
          const lbl = document.createElement('label');
          lbl.className = 'field-label';
          lbl.textContent = sc.label;
          box2.appendChild(lbl);
          if (sc.type === 'select') {
            field = document.createElement('select');
            for (const opt of sc.options || []) {
              const o = document.createElement('option');
              o.value = opt;
              o.textContent = opt;
              field.appendChild(o);
            }
            field.value = String(val ?? '');
            field.addEventListener('change', () => save(field.value));
          } else {
            field = document.createElement('input');
            field.type = sc.type === 'number' ? 'number' : sc.type === 'color' ? 'color' : 'text';
            field.value = String(val ?? '');
            field.addEventListener('change', () => save(field.value));
          }
          box2.appendChild(field);
        }
        row.appendChild(box2);
      }

      box.appendChild(row);
    }
  }

  function renderApiStatus(st) {
    $('set-api').checked = st.enabled;
    const tokenBox = $('api-token');
    const tokenBtn = $('btn-api-token');
    const appsBox = $('app-list');

    if (st.enabled && st.running) {
      $('api-status').textContent = `Listening on http://127.0.0.1:${st.port}. `
        + 'Programs ask to connect using the pairing code below, and you approve each one.';
      tokenBox.textContent = st.pairingToken || '';
      tokenBox.classList.remove('hidden');
      tokenBtn.classList.remove('hidden');
    } else if (st.enabled) {
      $('api-status').textContent = 'Enabled, but the port could not be opened - try another port or restart.';
      tokenBox.classList.add('hidden');
      tokenBtn.classList.add('hidden');
    } else {
      $('api-status').textContent = 'Off. Turn this on to let other programs on this PC push widget panes.';
      tokenBox.classList.add('hidden');
      tokenBtn.classList.add('hidden');
    }

    // Connected apps, each with its own capabilities and its own off switch.
    appsBox.innerHTML = '';
    const apps = st.apps || [];
    if (!st.enabled) return;
    if (!apps.length) {
      const empty = document.createElement('div');
      empty.className = 'hint-text';
      empty.textContent = 'No programs connected yet.';
      appsBox.appendChild(empty);
      return;
    }
    for (const app of apps) {
      const row = document.createElement('div');
      row.className = 'plugin-row';

      const top = document.createElement('div');
      top.className = 'plugin-top';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = app.name;
      const ds = document.createElement('div');
      ds.className = 'ds';
      ds.textContent = app.lastSeenAt
        ? `last seen ${new Date(app.lastSeenAt).toLocaleString()}`
        : 'never used';
      meta.append(nm, ds);
      // The identity that actually gates access: the program's executable.
      const exe = document.createElement('div');
      exe.className = 'perms';
      exe.textContent = app.exePath || 'not bound to a program (paired before binding)';
      if (app.publisher) {
        const pub = document.createElement('div');
        pub.className = 'perms';
        pub.textContent = app.publisher.startsWith('unsigned')
          ? 'Unsigned - pinned to its exact file fingerprint'
          : `Publisher: ${app.publisher}`;
        meta.appendChild(pub);
      }
      exe.title = app.exePath
        ? 'Only this program can use the access you granted.'
        : 'Disconnect and pair again to bind this app to its program.';
      meta.appendChild(exe);
      const kill = document.createElement('button');
      kill.className = 'btn btn-danger';
      kill.textContent = 'Disconnect';
      kill.title = 'Revoke this app’s access and remove its panes';
      kill.addEventListener('click', async () => renderApiStatus(await aero.revokeApp(app.id)));
      top.append(meta, kill);
      row.appendChild(top);

      const caps = document.createElement('div');
      caps.className = 'perm-list';
      for (const cap of app.capabilities) {
        const pr = document.createElement('div');
        pr.className = `perm-row risk-${cap.risk} state-${cap.state}`;
        const info = document.createElement('div');
        info.className = 'perm-info';
        const t = document.createElement('div');
        t.className = 'perm-title';
        t.textContent = cap.title;
        const d = document.createElement('div');
        d.className = 'perm-detail';
        d.textContent = cap.detail;
        info.append(t, d);

        const choice = document.createElement('div');
        choice.className = 'perm-choice';
        for (const [state, label] of [['granted', 'Allow'], ['denied', 'Block']]) {
          const b = document.createElement('button');
          b.className = `chip${cap.state === state ? ' on' : ''}`;
          b.textContent = label;
          b.addEventListener('click', async () =>
            renderApiStatus(await aero.setAppGrant(app.id, cap.name, state)));
          choice.appendChild(b);
        }
        pr.append(info, choice);
        caps.appendChild(pr);
      }
      row.appendChild(caps);
      appsBox.appendChild(row);
    }
  }

  // ---- Web widgets: create a pane from any web address ----
  function renderWebWidgetList(list) {
    const box = $('webw-list');
    box.innerHTML = '';
    for (const w of list) {
      const row = document.createElement('div');
      row.className = 'plugin-row';
      const top = document.createElement('div');
      top.className = 'plugin-top';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = w.name || w.url;
      const ds = document.createElement('div');
      ds.className = 'ds';
      ds.textContent = w.shared ? `${w.url}  ·  shared with your devices` : w.url;
      meta.append(nm, ds);
      const del = document.createElement('button');
      del.className = 'btn btn-danger';
      del.textContent = 'Remove';
      del.addEventListener('click', async () => {
        const next = (settings.webWidgets || []).filter((x) => x.id !== w.id);
        const st = await aero.setSettings({ webWidgets: next });
        renderWebWidgetList(st.webWidgets || []);
      });
      top.append(meta, del);
      row.appendChild(top);
      box.appendChild(row);
    }
  }

  async function addWebWidget() {
    const status = $('webw-status');
    let url = $('webw-url').value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try { new URL(url); } catch { status.textContent = 'That does not look like a valid address.'; return; }
    const name = $('webw-name').value.trim().slice(0, 40);
    const entry = { id: `w${Date.now().toString(36)}`, name, url, height: 300 };
    const st = await aero.setSettings({ webWidgets: [...(settings.webWidgets || []), entry] });
    $('webw-url').value = '';
    $('webw-name').value = '';
    status.textContent = 'Added. Drag its corner grip to resize; some sites refuse embedding and stay blank.';
    renderWebWidgetList(st.webWidgets || []);
  }
  $('btn-webw-add').addEventListener('click', addWebWidget);
  $('webw-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') addWebWidget(); });
  renderWebWidgetList(settings.webWidgets || []);

  renderPluginList(await aero.listPlugins());
  aero.onPluginsChanged(renderPluginList);
  renderApiStatus(await aero.apiStatus());
  aero.onApiChanged(renderApiStatus);
  $('btn-plugins-folder').addEventListener('click', () => aero.openPluginsFolder());
  $('btn-plugins-reload').addEventListener('click', async () => renderPluginList(await aero.reloadPlugins()));
  $('set-api').addEventListener('change', async (e) => renderApiStatus(await aero.setApiEnabled(e.target.checked)));
  $('btn-api-token').addEventListener('click', async () => renderApiStatus(await aero.regenerateApiToken()));

  // Multi-monitor: offer a dock-display choice only when there is a choice.
  async function refreshDisplayPicker() {
    const displays = await aero.listDisplays();
    const sel = $('set-dock-display');
    const row = $('dock-display-row');
    sel.innerHTML = '';
    for (const d of displays) {
      const o = document.createElement('option');
      o.value = String(d.id);
      o.textContent = d.label;
      sel.appendChild(o);
      if (d.primary) sel.dataset.primary = String(d.id);
    }
    row.classList.toggle('hidden', displays.length < 2);
    setVal(sel, String(settings.dockDisplay ?? sel.dataset.primary));
  }
  refreshDisplayPicker();
  aero.onSettingsChanged(() => refreshDisplayPicker());

  const info = await aero.appInfo();
  $('app-version').textContent = `BE-Aero Desktop v${info.version}`;
  if (!info.packaged) {
    $('set-startup').disabled = true;
    $('set-startup').parentElement.title = 'Available in the installed app';
  }

  // City search via Open-Meteo geocoding.
  async function findCity() {
    const q = $('set-city').value.trim();
    const box = $('city-results');
    if (!q) return;
    box.innerHTML = '<div class="msg">Searching...</div>';
    try {
      const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: '6', format: 'json' })}`);
      const data = await res.json();
      const results = data.results || [];
      if (!results.length) { box.innerHTML = '<div class="msg">No matches found.</div>'; return; }
      box.innerHTML = '';
      for (const r of results) {
        const region = [r.admin1, r.country].filter(Boolean).join(', ');
        const btn = document.createElement('button');
        btn.textContent = `${r.name}${region ? ' - ' + region : ''}`;
        btn.addEventListener('click', () => {
          const suffix = r.country_code === 'US' && r.admin1 ? r.admin1 : (r.country || '');
          aero.setSettings({
            weather: {
              city: r.name,
              latitude: r.latitude,
              longitude: r.longitude,
              label: `${r.name}${suffix ? ', ' + suffix : ''}`.toUpperCase()
            }
          });
          box.innerHTML = '';
        });
        box.appendChild(btn);
      }
    } catch (err) {
      box.innerHTML = '<div class="msg">Search failed - check your connection.</div>';
    }
  }
  $('btn-find-city').addEventListener('click', findCity);
  $('set-city').addEventListener('keydown', (e) => { if (e.key === 'Enter') findCity(); });
  console.log('BE-Aero Desktop UI ready');
})().catch((err) => console.error('BE-Aero Desktop UI failed to start:', err));
