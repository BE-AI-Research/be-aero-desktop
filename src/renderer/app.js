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
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') openSearch(); });
  document.querySelector('.search-widget').addEventListener('click', (e) => {
    if (e.target !== searchInput) openSearch();
  });
  refreshHotkeyLabel();
  // Spotlight registers its hotkey shortly after startup.
  setTimeout(refreshHotkeyLabel, 1500);

  // ---------------------------------------------------------------
  // Settings panel
  // ---------------------------------------------------------------
  const panel = $('settings');
  let recordingHotkey = false;
  let recordingDockHotkey = false;   // declared early: applySettings reads it
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
    $('set-startup').checked = s.launchAtStartup;
    const aiCfg = s.ai || {};
    const aiEl = document.querySelector('.ai-widget');
    if (aiEl) aiEl.classList.toggle('hidden', s.widgets.ai === false || aiCfg.enabled === false);
    $('set-ai-enabled').checked = aiCfg.enabled !== false;
    if (document.activeElement !== $('set-ai-persona')) $('set-ai-persona').value = aiCfg.systemPrompt || '';
    $('set-ai-permission').value = aiCfg.permission || 'ask';
    if (document.activeElement !== $('set-ai-steps')) $('set-ai-steps').value = Number(aiCfg.maxSteps) || 12;
    $('set-notify-toast').checked = (s.notifications || {}).toast !== false;
    refreshAiStatus();
    if (!recordingDockHotkey && s.dock && s.dock.hotkey) {
      aero.dockHotkey().then((hk) => { $('set-dock-hotkey').value = AeroHotkey.pretty(hk || s.dock.hotkey); });
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
    $('set-ai-url').placeholder = st.provider === 'anthropic' ? 'Default Anthropic endpoint' : 'Server URL (e.g. http://localhost:11434/v1)';
    if (document.activeElement !== $('set-ai-model')) $('set-ai-model').value = st.model || '';
    $('set-ai-key').placeholder = st.hasKey ? 'API key saved (enter a new one to replace)' : (preset.needsKey ? 'API key (required)' : 'API key (optional)');
    const line = !st.enabled ? 'AI assistant is disabled.'
      : (preset.needsKey && !st.hasKey) ? `${st.presetLabel}: add an API key to start.`
      : !st.model ? `${st.presetLabel}: choose a model (Fetch models lists what is available).`
      : `Ready: ${st.presetLabel} · ${st.model}${st.permission === 'allow' ? ' · acts without asking' : st.permission === 'deny' ? ' · read-only' : ''}`;
    $('ai-status').textContent = line;
  }
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
  $('set-ai-steps').addEventListener('change', (e) => {
    const n = Math.max(1, Math.min(500, Math.round(Number(e.target.value) || 12)));
    e.target.value = n;
    aero.setSettings({ ai: { maxSteps: n } });
  });
  $('set-notify-toast').addEventListener('change', (e) => aero.setSettings({ notifications: { toast: e.target.checked } }));

  // Dock hotkey: same recorder behaviour as the search one.
  const dockHotkeyInput = $('set-dock-hotkey');
  const dockHotkeyStatus = $('dock-hotkey-status');
  const DOCK_HOTKEY_IDLE = 'Brings the dock up over anything on screen - even a game. Press again or pick an app to dismiss.';
  async function saveDockHotkey(accel) {
    const s = await aero.setSettings({ dock: { hotkey: accel } });
    const actual = await aero.dockHotkey();
    dockHotkeyInput.value = AeroHotkey.pretty(actual || s.dock.hotkey);
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
    dockHotkeyInput.value = AeroHotkey.pretty((settings.dock || {}).hotkey) || '';
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
    const v = e.target.value.trim().toUpperCase();
    if (/^[A-Z]:?$/.test(v)) telSet({ drive: v[0] + ':' });
  });
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
      ds.textContent = w.url;
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
