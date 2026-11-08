// BE-Aero Desktop - visual system telemetry. Renders the chosen style (rings,
// speedometer arcs, bars, live graphs, compact chips) for the enabled metrics.
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const LABELS = { cpu: 'CPU', ram: 'RAM', disk: 'DISK', net: 'NET', battery: 'BATT' };
  const ORDER = ['cpu', 'ram', 'disk', 'net', 'battery'];

  let body = null;
  let coresEl = null;
  let footEl = null;
  let cfg = null;
  let views = {};
  const history = {};
  let last = null;
  let battery = null;

  const $ = (id) => document.getElementById(id);

  function svg(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
  }

  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function fmtRate(bps) {
    if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)} MB/s`;
    if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`;
    return `${Math.round(bps)} B/s`;
  }

  // Ring gauges are often only ~56px across in a docked sidebar, where
  // "313 KB/s" can only be drawn at an unreadable size. Rings use this.
  function fmtRateShort(bps) {
    if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)}M`;
    if (bps >= 1024) return `${Math.round(bps / 1024)}K`;
    return `${Math.round(bps)}B`;
  }

  function formatUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : `${h}h ${m}m`;
  }

  // Current value (0-100) and caption for a metric, or null when unavailable.
  function metricValue(key, t) {
    switch (key) {
      case 'cpu': return { v: t.cpu, text: `${Math.round(t.cpu)}%`, sub: `${t.cores} cores` };
      case 'ram': return { v: t.ram, text: `${Math.round(t.ram)}%`, sub: `${t.usedMemGB.toFixed(1)}/${t.totalMemGB.toFixed(0)} GB` };
      case 'disk': return t.disk ? { v: t.disk.percent, text: `${Math.round(t.disk.percent)}%`,
        sub: `${t.disk.drive} ${Math.round(t.disk.totalGB - t.disk.usedGB)} GB free` } : null;
      case 'net': return t.net ? { v: t.net.percent, text: fmtRate(t.net.rx + t.net.tx),
        short: fmtRateShort(t.net.rx + t.net.tx),
        sub: `↓${fmtRate(t.net.rx)} ↑${fmtRate(t.net.tx)}` } : null;
      case 'battery': return battery ? { v: battery.level * 100, text: `${Math.round(battery.level * 100)}%`,
        sub: battery.charging ? 'charging' : 'on battery' } : null;
      default: return null;
    }
  }

  const color = (k) => (cfg.colors && cfg.colors[k]) || 'var(--accent)';
  const enabled = () => ORDER.filter((k) => cfg.metrics && cfg.metrics[k]);

  // ---------------------------------------------------------------- builders
  function buildRing(k, parent, arc) {
    const box = el('div', `gauge ${arc ? 'gauge-arc' : ''}`, parent);
    const s = svg('svg', { viewBox: '0 0 100 100' }, box);
    const r = 40;
    const circ = 2 * Math.PI * r;
    const span = arc ? 0.75 : 1; // speedometer: 270 degree sweep
    const rot = arc ? 135 : -90;
    const common = { cx: 50, cy: 50, r, fill: 'none', 'stroke-width': cfg.thickness, 'stroke-linecap': 'round',
      transform: `rotate(${rot} 50 50)` };
    svg('circle', { ...common, class: 'gauge-track', 'stroke-dasharray': `${circ * span} ${circ}` }, s);
    const fill = svg('circle', { ...common, class: 'gauge-fill', stroke: color(k),
      'stroke-dasharray': `0 ${circ}` }, s);
    let needle = null;
    if (arc) needle = svg('line', { x1: 50, y1: 50, x2: 50, y2: 22, class: 'gauge-needle' }, s);
    const label = el('div', 'gauge-label', box);
    const value = el('span', 'gauge-value', label);
    el('span', 'gauge-name', label, LABELS[k]);
    const sub = el('span', 'gauge-sub', label);
    return {
      set(m) {
        const len = (m.v / 100) * circ * span;
        fill.setAttribute('stroke-dasharray', `${len} ${circ}`);
        fill.classList.toggle('hot', m.v >= cfg.warnAt && k !== 'battery' && k !== 'net');
        if (needle) needle.setAttribute('transform', `rotate(${-135 + (m.v / 100) * 270} 50 50)`);
        const text = m.short || m.text;
        value.textContent = text;
        value.title = m.text;
        // Let the CSS shrink long readings so they stay inside the ring.
        box.style.setProperty('--len', Math.max(3, text.length));
        sub.textContent = m.sub || '';
      }
    };
  }

  function buildBar(k, parent) {
    const row = el('div', 'tbar', parent);
    const head = el('div', 'tbar-head', row);
    el('span', 'tbar-name', head, LABELS[k]);
    const sub = el('span', 'tbar-sub', head);
    const value = el('span', 'tbar-value', head);
    const track = el('div', 'tbar-track', row);
    track.style.height = `${cfg.thickness}px`;
    const fill = el('div', 'tbar-fill', track);
    fill.style.background = color(k);
    return {
      set(m) {
        fill.style.width = `${Math.max(0, Math.min(100, m.v))}%`;
        fill.classList.toggle('hot', m.v >= cfg.warnAt && k !== 'battery' && k !== 'net');
        value.textContent = m.text;
        sub.textContent = m.sub || '';
      }
    };
  }

  function buildGraph(k, parent) {
    const box = el('div', 'tgraph', parent);
    const head = el('div', 'tbar-head', box);
    el('span', 'tbar-name', head, LABELS[k]);
    const sub = el('span', 'tbar-sub', head);
    const value = el('span', 'tbar-value', head);
    const s = svg('svg', { viewBox: '0 0 100 30', preserveAspectRatio: 'none', class: 'tgraph-svg' }, box);
    const id = `g-${k}-${Math.random().toString(36).slice(2, 7)}`;
    const defs = svg('defs', {}, s);
    const grad = svg('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    svg('stop', { offset: '0%', 'stop-color': color(k), 'stop-opacity': 0.45 }, grad);
    svg('stop', { offset: '100%', 'stop-color': color(k), 'stop-opacity': 0 }, grad);
    const area = svg('path', { fill: `url(#${id})` }, s);
    const line = svg('path', { fill: 'none', stroke: color(k), 'stroke-width': Math.max(1, cfg.thickness / 4),
      'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }, s);
    const warn = svg('line', { x1: 0, x2: 100, y1: 30 - (cfg.warnAt / 100) * 30, y2: 30 - (cfg.warnAt / 100) * 30,
      class: 'tgraph-warn', 'vector-effect': 'non-scaling-stroke' }, s);
    if (k === 'battery' || k === 'net') warn.remove();
    return {
      set(m) {
        const h = history[k] || [];
        const n = cfg.history;
        const pts = h.map((v, i) => [((i + n - h.length) / (n - 1)) * 100, 30 - (v / 100) * 29]);
        if (pts.length > 1) {
          const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('');
          line.setAttribute('d', d);
          area.setAttribute('d', `${d}L100,30L${pts[0][0].toFixed(2)},30Z`);
        }
        value.textContent = m.text;
        sub.textContent = m.sub || '';
      }
    };
  }

  function buildChip(k, parent) {
    const chip = el('div', 'tchip', parent);
    chip.style.setProperty('--c', color(k));
    el('span', 'tchip-name', chip, LABELS[k]);
    const value = el('span', 'tchip-value', chip);
    const s = svg('svg', { viewBox: '0 0 100 20', preserveAspectRatio: 'none', class: 'tchip-spark' }, chip);
    const line = svg('path', { fill: 'none', stroke: color(k), 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }, s);
    return {
      set(m) {
        value.textContent = m.text;
        const h = (history[k] || []).slice(-30);
        if (h.length > 1) {
          line.setAttribute('d', h.map((v, i) => `${i ? 'L' : 'M'}${((i / (h.length - 1)) * 100).toFixed(1)},${(19 - (v / 100) * 18).toFixed(1)}`).join(''));
        }
        chip.classList.toggle('hot', m.v >= cfg.warnAt && k !== 'battery' && k !== 'net');
      }
    };
  }

  const BUILDERS = {
    rings: (k, p) => buildRing(k, p, false),
    arcs: (k, p) => buildRing(k, p, true),
    bars: buildBar,
    graph: buildGraph,
    compact: buildChip
  };

  function render(settings) {
    body = body || $('telemetry-body');
    coresEl = coresEl || $('telemetry-cores');
    footEl = footEl || $('telemetry-foot');
    cfg = settings.telemetry;
    const style = BUILDERS[cfg.style] ? cfg.style : 'rings';
    body.className = `telemetry-body tstyle-${style} ${cfg.showValues ? '' : 'no-values'}`;
    body.innerHTML = '';
    views = {};
    const keys = enabled();
    body.style.setProperty('--count', keys.length || 1);
    for (const k of keys) views[k] = BUILDERS[style](k, body);
    if (!keys.length) el('div', 'tempty', body, 'Enable a metric in Settings');
    coresEl.classList.toggle('hidden', !cfg.showCores);
    footEl.classList.toggle('hidden', !cfg.showFooter);
    if (cfg.metrics.battery) initBattery();
    if (last) update(last, true);
  }

  async function initBattery() {
    if (battery || !navigator.getBattery) return;
    try {
      battery = await navigator.getBattery();
      // Desktops report a permanently "full, charging" battery: treat as absent.
      if (battery.charging && battery.level === 1 && battery.chargingTime === 0 && battery.dischargingTime === Infinity) {
        battery.desktop = true;
      }
    } catch { battery = null; }
  }

  function update(t, redraw) {
    if (!cfg) return;
    last = t;
    for (const k of ORDER) {
      if (redraw) continue;
      const m = metricValue(k, t);
      if (!m) continue;
      const h = history[k] || (history[k] = []);
      h.push(m.v);
      while (h.length > cfg.history) h.shift();
    }
    for (const [k, view] of Object.entries(views)) {
      const m = metricValue(k, t);
      if (k === 'battery' && battery && battery.desktop) {
        view.set({ v: 100, text: 'AC', sub: 'no battery' });
      } else view.set(m || { v: 0, text: '--', sub: k === 'net' ? 'measuring...' : 'unavailable' });
    }

    if (cfg.showCores && t.perCore) {
      if (coresEl.childElementCount !== t.perCore.length) {
        coresEl.innerHTML = '';
        for (let i = 0; i < t.perCore.length; i++) el('div', 'core', coresEl);
      }
      t.perCore.forEach((v, i) => {
        const c = coresEl.children[i];
        c.style.setProperty('--v', v / 100);
        c.title = `Core ${i}: ${v}%`;
        c.classList.toggle('hot', v >= cfg.warnAt);
      });
      coresEl.style.setProperty('--core-color', color('cpu'));
    }
    if (cfg.showFooter) {
      footEl.textContent = `${t.cores} CORES · ${t.usedMemGB.toFixed(1)} / ${t.totalMemGB.toFixed(1)} GB · UP ${formatUptime(t.uptime)}`;
      footEl.title = t.cpuModel || '';
    }
  }

  window.AeroTelemetry = { render, update };
})();
