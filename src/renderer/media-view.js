// BE-Aero Desktop - media controller widget: what is playing anywhere on the
// machine, with transport and volume controls. Polls main while visible.
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
      barEl.style.width = '0%';
      playBtn.textContent = '▶';
      playBtn.title = 'Play';
      return;
    }
    hintEl.textContent = '';
    titleEl.textContent = info.title || 'Unknown title';
    titleEl.title = info.title || '';
    subEl.textContent = [info.artist, info.album].filter(Boolean).join(' · ');
    const parts = [];
    if (info.app) parts.push(appName(info.app));
    if (info.duration > 0) parts.push(`${fmt(info.position)} / ${fmt(info.duration)}`);
    if (typeof info.volume === 'number') parts.push(`vol ${info.volume}%${info.muted ? ' (muted)' : ''}`);
    appEl.textContent = parts.join(' · ');
    artEl.style.backgroundImage = info.thumb ? `url("${info.thumb.replace(/"/g, '%22')}")` : '';
    barEl.style.width = info.duration > 0 ? `${Math.min(100, (info.position / info.duration) * 100)}%` : '0%';
    const playing = info.status === 'playing';
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.title = playing ? 'Pause' : 'Play';
  }

  async function refresh() {
    if (!root || root.classList.contains('hidden') || document.hidden) return;
    try { render(await aero.mediaInfo()); } catch { /* main busy */ }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(refresh, POLL_MS);
    refresh();
  }

  async function act(name) {
    try { await aero.mediaAction(name); } catch { /* ignore */ }
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
      <div class="media-progress"><div class="media-bar"></div></div>
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
    playBtn = root.querySelector('.media-play');
    hintEl = root.querySelector('.media-hint');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) { e.stopPropagation(); act(b.dataset.act); }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    schedule();
  }

  window.AeroMedia = { init, refresh, appName, fmt, last: () => last };
})();
