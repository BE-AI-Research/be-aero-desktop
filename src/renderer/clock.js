// BE-Aero Desktop - chronometer faces. Renders one of several clock styles into
// a container and updates it each tick. Everything scales with the widget
// (SVG viewBox for dials, container-query units for text).
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const ANALOG = new Set(['analog', 'classic', 'minimal', 'hybrid']);
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const shortDateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  let root = null;
  let opts = null;
  let refs = {};
  let timer = null;
  let raf = null;
  let lastFlip = {};

  const pad = (n) => String(n).padStart(2, '0');

  function svg(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
  }

  function div(cls, parent, text) {
    const el = document.createElement('div');
    el.className = cls;
    if (text !== undefined) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }

  // Analog dial in a 200x200 viewBox.
  function buildDial(style, parent) {
    const s = svg('svg', { viewBox: '0 0 200 200', class: `dial-svg dial-${style}` }, parent);
    if (style !== 'minimal') svg('circle', { cx: 100, cy: 100, r: 96, class: 'dial-face' }, s);
    for (let i = 0; i < 60; i++) {
      const major = i % 5 === 0;
      if (style === 'minimal' && !major) continue;
      if (style === 'analog' && !major) continue;
      const len = major ? (style === 'minimal' ? 14 : 9) : 4;
      const a = (i / 60) * Math.PI * 2;
      const r1 = 90;
      const r2 = r1 - len;
      svg('line', {
        x1: 100 + Math.sin(a) * r1, y1: 100 - Math.cos(a) * r1,
        x2: 100 + Math.sin(a) * r2, y2: 100 - Math.cos(a) * r2,
        class: major ? 'tick major' : 'tick'
      }, s);
    }
    const numerals = style === 'classic' ? [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
      : (style === 'analog' || style === 'hybrid') ? [12, 3, 6, 9] : [];
    for (const n of numerals) {
      const a = ((n % 12) / 12) * Math.PI * 2;
      const r = style === 'classic' ? 68 : 70;
      const t = svg('text', { x: 100 + Math.sin(a) * r, y: 100 - Math.cos(a) * r, class: 'numeral' }, s);
      t.textContent = n;
    }
    const hand = (cls, len, tail) => svg('line', { x1: 100, y1: 100 + tail, x2: 100, y2: 100 - len, class: `hand ${cls}` }, s);
    refs.hour = hand('hour', 46, 8);
    refs.minute = hand('minute', 68, 10);
    refs.second = opts.showSeconds ? hand('second', 78, 16) : null;
    svg('circle', { cx: 100, cy: 100, r: 5, class: 'hub' }, s);
    return s;
  }

  // Concentric progress rings for hours / minutes / seconds.
  function buildRings(parent) {
    const s = svg('svg', { viewBox: '0 0 200 200', class: 'dial-svg rings-svg' }, parent);
    const rings = [['hour', 88, 10], ['minute', 72, 10]];
    if (opts.showSeconds) rings.push(['second', 56, 6]);
    for (const [k, r, w] of rings) {
      svg('circle', { cx: 100, cy: 100, r, class: 'ring-track', 'stroke-width': w }, s);
      const c = svg('circle', {
        cx: 100, cy: 100, r, class: `ring ring-${k}`, 'stroke-width': w,
        'stroke-dasharray': (2 * Math.PI * r).toFixed(2), transform: 'rotate(-90 100 100)'
      }, s);
      refs[`ring_${k}`] = { el: c, circ: 2 * Math.PI * r };
    }
    return s;
  }

  function buildDigital(parent, big) {
    const box = div(big ? 'digital big' : 'digital', parent);
    const line = div('digital-time', box);
    refs.hm = document.createElement('span');
    refs.hm.className = 'hm';
    line.appendChild(refs.hm);
    if (opts.showSeconds) {
      refs.sec = document.createElement('span');
      refs.sec.className = 'sec';
      line.appendChild(refs.sec);
    }
    refs.ampm = document.createElement('span');
    refs.ampm.className = 'ampm';
    line.appendChild(refs.ampm);
    if (opts.showDate) refs.date = div('digital-date', box);
    return box;
  }

  function buildFlip(parent) {
    const box = div('flip', parent);
    const digits = opts.showSeconds ? ['h1', 'h2', ':', 'm1', 'm2', ':', 's1', 's2'] : ['h1', 'h2', ':', 'm1', 'm2'];
    refs.flip = {};
    lastFlip = {};
    for (const d of digits) {
      if (d === ':') { div('flip-colon', box, ':'); continue; }
      const card = div(`flip-card ${d[0] === 's' ? 'small' : ''}`, box);
      refs.flip[d] = div('flip-digit', card, '0');
    }
    const foot = div('flip-foot', parent);
    refs.ampm = document.createElement('span');
    refs.ampm.className = 'ampm';
    foot.appendChild(refs.ampm);
    if (opts.showDate) {
      refs.date = document.createElement('span');
      refs.date.className = 'digital-date';
      foot.appendChild(refs.date);
    }
  }

  function render(container, settings) {
    root = container || root;
    const c = settings.clock || {};
    opts = {
      style: c.style || 'analog',
      digital: c.digital !== false,
      showSeconds: c.showSeconds !== false,
      showDate: c.showDate !== false,
      smooth: !!c.smooth,
      accent: c.accent || '',
      use24h: !!settings.use24h
    };
    refs = {};
    root.innerHTML = '';
    root.className = `clock-face style-${opts.style}`;
    root.style.setProperty('--clock-accent', opts.accent || 'var(--accent)');

    if (ANALOG.has(opts.style)) {
      const dialBox = div('dial-box', root);
      buildDial(opts.style, dialBox);
      if (opts.style === 'hybrid') buildDigital(root, true);
      else if (opts.digital || opts.showDate) {
        const show = opts.digital;
        const box = buildDigital(root, false);
        if (!show) box.querySelector('.digital-time').remove();
      }
    } else if (opts.style === 'rings') {
      const wrap = div('rings-box', root);
      buildRings(wrap);
      buildDigital(div('rings-center', wrap), false);
    } else if (opts.style === 'flip') {
      buildFlip(root);
    } else {
      buildDigital(root, true);
    }
    start();
  }

  function setRot(el, deg) {
    if (el) el.setAttribute('transform', `rotate(${deg.toFixed(2)} 100 100)`);
  }

  function tick() {
    if (!opts) return;
    const now = new Date();
    const ms = now.getMilliseconds();
    const s = now.getSeconds() + (opts.smooth ? ms / 1000 : 0);
    const m = now.getMinutes() + s / 60;
    const h = (now.getHours() % 12) + m / 60;

    setRot(refs.second, s * 6);
    setRot(refs.minute, m * 6);
    setRot(refs.hour, h * 30);

    const ring = (k, frac) => {
      const r = refs[`ring_${k}`];
      if (r) r.el.setAttribute('stroke-dashoffset', (r.circ * (1 - frac)).toFixed(2));
    };
    ring('hour', h / 12);
    ring('minute', m / 60);
    ring('second', s / 60);

    const H = now.getHours();
    const hh = opts.use24h ? pad(H) : String(H % 12 || 12);
    const mm = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    const ap = opts.use24h ? '' : (H >= 12 ? 'PM' : 'AM');
    if (refs.hm) refs.hm.textContent = `${hh}:${mm}`;
    if (refs.sec) refs.sec.textContent = `:${ss}`;
    if (refs.ampm) refs.ampm.textContent = ap;
    if (refs.date) refs.date.textContent = (opts.style === 'rings' ? shortDateFmt : dateFmt).format(now);

    if (refs.flip) {
      const digits = { h1: pad(hh)[0], h2: pad(hh)[1], m1: mm[0], m2: mm[1], s1: ss[0], s2: ss[1] };
      if (!opts.use24h && hh.length === 1) digits.h1 = ' ';
      for (const [k, el] of Object.entries(refs.flip)) {
        if (lastFlip[k] === digits[k]) continue;
        el.textContent = digits[k];
        if (lastFlip[k] !== undefined) {
          el.parentElement.classList.remove('flipping');
          void el.parentElement.offsetWidth; // restart the animation
          el.parentElement.classList.add('flipping');
        }
        lastFlip[k] = digits[k];
      }
    }
  }

  function start() {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    const smoothLoop = () => { tick(); raf = requestAnimationFrame(smoothLoop); };
    // Align ticks to the start of each second so hands move crisply.
    const stepLoop = () => { tick(); timer = setTimeout(stepLoop, 1000 - (Date.now() % 1000) + 5); };
    if (opts.smooth && refs.second) smoothLoop(); else stepLoop();
  }

  window.AeroClock = { render, tick };
})();
