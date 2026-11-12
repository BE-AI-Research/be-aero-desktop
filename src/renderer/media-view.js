// BE-Aero Desktop - media controller widget: what is playing anywhere on the
// machine - or on another of my devices, picked from the dropdown - with
// transport and volume controls. Polls main while visible.
(function () {
  'use strict';

  const POLL_MS = 2000;
  let aero = null;
  let root = null;
  let artEl = null;
  let titleEl = null;
  let subEl = null;
  let appEl = null;
  let barEl = null;
  let playBtn = null;
  let hintEl = null;
  let timer = null;
  let last = null;
  let timeEl = null;
  let thumbEl = null;
  let trackEl = null;
  // The clock the bar runs on between polls: position at `at` (performance.now()).
  let clock = { position: 0, duration: 0, playing: false, rate: 1, at: 0, canSeek: false };
  let scrub = null;       // { pct } while the user drags the thumb
  let raf = 0;
  let picker = null;      // device dropdown (device-picker.js); '' = this device
  const dev = () => (picker ? picker.value() : '');

  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function fmt(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r < 10 ? '0' : ''}${r}`;
  }

  function appName(id) {
    const s = String(id || '');
    if (!s) return '';
    const base = s.split(/[\\/]/).pop().replace(/\.exe$/i, '').replace(/^Microsoft\./i, '').replace(/_[a-z0-9]+!.*$/i, '').replace(/!.*$/, '');
    return base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').trim();
  }

  function render(info) {
    last = info;
    const none = !info || info.status === 'none';
    root.classList.toggle('media-none', none);
    root.classList.toggle('media-playing', !!info && info.status === 'playing');
    if (none) {
      titleEl.textContent = info && info.available === false ? 'Media control unavailable' : 'Nothing playing';
      subEl.textContent = '';
      appEl.textContent = '';
      hintEl.textContent = info && info.hint ? info.hint : '';
      artEl.style.backgroundImage = '';
      clock = { position: 0, duration: 0, playing: false, rate: 1, at: performance.now(), canSeek: false };
      root.classList.remove('media-can-seek');
      paintProgress();
      playBtn.textContent = '▶';
      playBtn.title = 'Play';
      return;
    }
    hintEl.textContent = '';
    titleEl.textContent = info.title || 'Unknown title';
    titleEl.title = info.title || '';
    subEl.textContent = [info.artist, info.album].filter(Boolean).join(' · ');
    const parts = [];
    if (dev() && picker) parts.push(`on ${picker.name(dev())}`);
    if (info.app) parts.push(appName(info.app));
    if (typeof info.volume === 'number') parts.push(`vol ${info.volume}%${info.muted ? ' (muted)' : ''}`);
    appEl.textContent = parts.join(' · ');
    artEl.style.backgroundImage = info.thumb ? `url("${info.thumb.replace(/"/g, '%22')}")` : '';
    const playing = info.status === 'playing';
    // Main already extrapolated to when it sampled; carry on from there locally.
    const lag = info.sampledAt ? Math.max(0, Date.now() - info.sampledAt) / 1000 : 0;
    clock = {
      position: (Number(info.position) || 0) + (playing ? lag * (Number(info.rate) || 1) : 0),
      duration: Number(info.duration) || 0,
      playing, rate: Number(info.rate) > 0 ? Number(info.rate) : 1,
      at: performance.now(),
      canSeek: info.canSeek !== false && (Number(info.duration) || 0) > 0
    };
    root.classList.toggle('media-can-seek', clock.canSeek);
    paintProgress();
    tick();
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.title = playing ? 'Pause' : 'Play';
  }

  function livePos() {
    const p = clock.playing ? clock.position + ((performance.now() - clock.at) / 1000) * clock.rate : clock.position;
    return clock.duration > 0 ? Math.max(0, Math.min(clock.duration, p)) : Math.max(0, p);
  }
  function paintProgress() {
    if (!barEl) return;
    const d = clock.duration;
    const pos = scrub ? scrub.pct * d : livePos();
    const pct = d > 0 ? (pos / d) * 100 : 0;
    barEl.style.width = `${pct}%`;
    if (thumbEl) thumbEl.style.left = `${pct}%`;
    const text = d > 0 ? `${fmt(pos)} / ${fmt(d)}` : '';
    if (timeEl.textContent !== text) timeEl.textContent = text;
  }
  // Animate only while something is playing and the widget can be seen.
  function tick() {
    cancelAnimationFrame(raf);
    const loop = () => {
      if (!root || root.classList.contains('hidden') || document.hidden || (!clock.playing && !scrub)) { raf = 0; return; }
      paintProgress();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }
  function pctAt(clientX) {
    const r = trackEl.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
  }
  function startScrub(e) {
    if (e.button !== 0 || !clock.canSeek) return;
    e.preventDefault();
    e.stopPropagation();
    scrub = { pct: pctAt(e.clientX) };
    root.classList.add('media-scrubbing');
    try { trackEl.setPointerCapture(e.pointerId); } catch { /* fine */ }
    paintProgress();
    tick();
    const move = (ev) => { if (!scrub) return; scrub.pct = pctAt(ev.clientX); paintProgress(); };
    const up = async (ev) => {
      trackEl.removeEventListener('pointermove', move);
      trackEl.removeEventListener('pointerup', up);
      trackEl.removeEventListener('pointercancel', up);
      if (!scrub) return;
      const target = (ev.type === 'pointercancel' ? null : pctAt(ev.clientX) * clock.duration);
      scrub = null;
      root.classList.remove('media-scrubbing');
      if (target == null) { paintProgress(); return; }
      // Optimistic: run the clock from the new position right away.
      clock = { ...clock, position: target, at: performance.now() };
      paintProgress();
      tick();
      try { await aero.mediaSeek(target, dev()); } catch { /* ignore */ }
      setTimeout(refresh, 700);
    };
    trackEl.addEventListener('pointermove', move);
    trackEl.addEventListener('pointerup', up);
    trackEl.addEventListener('pointercancel', up);
  }

  async function refresh() {
    if (!root || root.classList.contains('hidden') || document.hidden) return;
    const d = dev();
    try { const info = await aero.mediaInfo(d); if (d === dev()) render(info); } catch { /* main busy */ }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(refresh, POLL_MS);
    refresh();
  }

  async function act(name) {
    try { await aero.mediaAction(name, dev()); } catch { /* ignore */ }
    setTimeout(refresh, 350);
  }

  function init(opts) {
    aero = opts.aero;
    const widget = document.querySelector('.media-widget');
    if (!widget) return;
    // Our own container: the widget itself also holds the layout's resize
    // grip, which must survive.
    widget.insertAdjacentHTML('afterbegin', `
      <div class="media-head">
        <h3 class="widget-title">NOW PLAYING</h3>
        <button class="icon-btn media-min" title="Minimize to the dock">&#8212;</button>
      </div>
      <div class="media-body"></div>`);
    if (window.AeroDevicePicker && aero.mediaDevices) {
      picker = AeroDevicePicker.create({ aero, key: 'media', onChange: () => { render({ status: 'none', available: true, hint: 'Asking…' }); refresh(); } });
      widget.querySelector('.media-min').before(picker.el);
    }
    widget.querySelector('.media-min').addEventListener('click', (e) => {
      e.stopPropagation();
      aero.setSettings({ widgetMinimized: { media: true } });
    });
    root = widget;
    widget.querySelector('.media-body').innerHTML = `
      <div class="media-row">
        <div class="media-art"></div>
        <div class="media-text">
          <div class="media-title">Nothing playing</div>
          <div class="media-sub"></div>
          <div class="media-app"></div>
        </div>
      </div>
      <div class="media-track" title="Drag to seek">
        <div class="media-progress"><div class="media-bar"></div></div>
        <div class="media-thumb"></div>
      </div>
      <div class="media-time"></div>
      <div class="media-controls">
        <button class="icon-btn media-btn" data-act="prev" title="Previous">⏮</button>
        <button class="icon-btn media-btn media-play" data-act="toggle" title="Play / pause">▶</button>
        <button class="icon-btn media-btn" data-act="next" title="Next">⏭</button>
        <span class="media-spacer"></span>
        <button class="icon-btn media-btn" data-act="voldown" title="Volume down">🔉</button>
        <button class="icon-btn media-btn" data-act="mute" title="Mute / unmute">🔇</button>
        <button class="icon-btn media-btn" data-act="volup" title="Volume up">🔊</button>
      </div>
      <div class="media-hint hint-text"></div>`;
    artEl = root.querySelector('.media-art');
    titleEl = root.querySelector('.media-title');
    subEl = root.querySelector('.media-sub');
    appEl = root.querySelector('.media-app');
    barEl = root.querySelector('.media-bar');
    thumbEl = root.querySelector('.media-thumb');
    trackEl = root.querySelector('.media-track');
    timeEl = root.querySelector('.media-time');
    trackEl.addEventListener('pointerdown', startScrub);
    playBtn = root.querySelector('.media-play');
    hintEl = root.querySelector('.media-hint');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) { e.stopPropagation(); act(b.dataset.act); }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); tick(); } });
    schedule();
  }

  window.AeroMedia = { init, refresh, appName, fmt, last: () => last };
})();
