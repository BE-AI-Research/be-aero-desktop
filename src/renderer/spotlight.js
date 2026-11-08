// Aero Search - Spotlight-style launcher UI.
(function () {
  'use strict';
  const sp = window.spotlight;
  const $ = (id) => document.getElementById(id);
  const input = $('q');
  const ghost = $('ghost');
  const resultsEl = $('results');
  const previewEl = $('preview');

  let flat = [];        // selectable rows in display order
  let selected = 0;
  let lastQuery = '';
  let seq = 0;          // drops out-of-order responses
  let previewSeq = 0;
  let stats = null;

  const KIND_LABEL = { app: 'Application', setting: 'Windows Settings', folder: 'Folder', file: 'File' };
  const CAT_EMOJI = {
    APPLICATIONS: '🧩', SETTINGS: '⚙️', DOCUMENTS: '📄', IMAGES: '🖼️', MUSIC: '🎵', VIDEOS: '🎬',
    DEVELOPER: '💻', ARCHIVES: '🗜️', FOLDERS: '📁', OTHER: '📄', CALC: '🧮', WEB: '🌐'
  };
  const CAT_TITLE = {
    APPLICATIONS: 'Applications', SETTINGS: 'Settings', DOCUMENTS: 'Documents', IMAGES: 'Images',
    MUSIC: 'Music', VIDEOS: 'Videos', DEVELOPER: 'Developer', ARCHIVES: 'Archives', FOLDERS: 'Folders',
    OTHER: 'Other', CALC: 'Calculator', WEB: 'Web search'
  };

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // Bold the parts of the name that match query terms (escaped first).
  function highlight(name, query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!terms.length) return esc(name);
    const lower = name.toLowerCase();
    const marks = new Array(name.length).fill(false);
    for (const t of terms) {
      let i = lower.indexOf(t);
      while (i !== -1) { for (let k = i; k < i + t.length; k++) marks[k] = true; i = lower.indexOf(t, i + t.length); }
    }
    let out = '';
    let open = false;
    for (let i = 0; i < name.length; i++) {
      if (marks[i] && !open) { out += '<b>'; open = true; }
      if (!marks[i] && open) { out += '</b>'; open = false; }
      out += esc(name[i]);
    }
    return open ? out + '</b>' : out;
  }
  function formatSize(n) {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  }
  function formatDate(ms) {
    return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }
  function parentDir(p) {
    const i = p.lastIndexOf('\\');
    return i > 0 ? p.slice(0, i) : p;
  }
  const isUwp = (item) => /^shell:AppsFolder\\/i.test(item.path || '');

  function subtitle(item) {
    if (item.kind === 'setting') return 'Windows Settings';
    if (isUwp(item)) return 'App';
    if (/^shell:/i.test(item.path)) return 'Windows location';
    if (item.kind === 'app') return 'Application';
    return parentDir(item.path).replace(/^C:\\Users\\[^\\]+/i, '~');
  }

  // ---------------------------------------------------------------- results
  function setGhost(text) {
    // Inline autocomplete like HorusSearch's Tab-complete hint.
    const q = input.value;
    if (q && text && text.toLowerCase().startsWith(q.toLowerCase()) && text.length > q.length) {
      ghost.innerHTML = `<span class="typed">${esc(q)}</span>${esc(text.slice(q.length))}`;
      ghost.dataset.full = text;
    } else {
      ghost.innerHTML = '';
      delete ghost.dataset.full;
    }
  }

  function render(res) {
    const q = res.query;
    flat = [];
    let html = '';
    const addGroup = (cat, items) => {
      html += `<div class="group-label">${esc(CAT_TITLE[cat] || cat)}</div>`;
      for (const it of items) {
        const idx = flat.length;
        flat.push(it);
        html += `<div class="item" data-idx="${idx}">
          <div class="ico${it.kind === 'setting' || it.special ? ' badge' : ''}" data-icon="${idx}">${CAT_EMOJI[it.category] || '📄'}</div>
          <div class="txt"><div class="name">${it.special ? esc(it.name) : highlight(it.name, q)}</div>
          <div class="sub">${esc(it.special ? it.sub : subtitle(it))}</div></div></div>`;
      }
    };

    if (res.calc !== null && res.calc !== undefined) {
      addGroup('CALC', [{ special: 'calc', name: `= ${res.calc.toLocaleString(undefined, { maximumFractionDigits: 10 })}`, sub: 'Enter to copy result', value: res.calc, category: 'CALC' }]);
    }
    for (const g of res.groups) addGroup(g.category, g.items);
    const engineName = { bing: 'Bing', google: 'Google', duckduckgo: 'DuckDuckGo', brave: 'Brave Search' }[res.webEngine] || 'the web';
    addGroup('WEB', [{ special: 'web', name: `Search the web for “${q}”`,
      sub: `${engineName} · opens in your default browser`, engineName, category: 'WEB' }]);

    resultsEl.innerHTML = html;
    selected = 0;
    updateSelection();
    loadIcons();
    setGhost(res.top ? res.top.name : '');
    $('hint').textContent = res.total ? `${res.total.toLocaleString()} matches` : (res.indexing ? 'Indexing…' : 'No matches');
  }

  async function loadIcons() {
    const mySeq = seq;
    for (let i = 0; i < flat.length; i++) {
      const it = flat[i];
      if (it.special || it.kind === 'setting') continue;
      const url = await sp.icon(it.path);
      if (mySeq !== seq) return;
      const holder = resultsEl.querySelector(`[data-icon="${i}"]`);
      if (url && holder) holder.innerHTML = `<img src="${url}" alt="">`;
    }
  }

  function updateSelection() {
    for (const el of resultsEl.querySelectorAll('.item.selected')) el.classList.remove('selected');
    const el = resultsEl.querySelector(`[data-idx="${selected}"]`);
    if (el) {
      el.classList.add('selected');
      el.scrollIntoView({ block: 'nearest' });
    }
    showPreview(flat[selected]);
  }

  // ---------------------------------------------------------------- preview
  async function showPreview(item) {
    const mySeq = ++previewSeq;
    if (!item) { previewEl.innerHTML = ''; return; }
    if (item.special === 'calc') {
      previewEl.innerHTML = `<div class="pv-calc">${esc(item.value.toLocaleString(undefined, { maximumFractionDigits: 10 }))}</div>
        <div class="pv-calc-expr">${esc(lastQuery)}</div>
        <div class="pv-actions"><button data-act="copy">Copy result</button></div>`;
      return;
    }
    if (item.special === 'web') {
      previewEl.innerHTML = `<div class="pv-icon">🌐</div><div class="pv-title">${esc(lastQuery)}</div>
        <div class="pv-kind">Web search</div>
        <div class="pv-text">Searches the internet with ${esc(item.engineName || 'your chosen engine')} and opens the result in the browser Windows has set as default.</div>`;
      return;
    }
    const icon = resultsEl.querySelector(`[data-icon="${selected}"]`);
    let iconHtml = icon ? icon.innerHTML : '';
    previewEl.innerHTML = `<div class="pv-icon">${iconHtml}</div>
      <div class="pv-title">${esc(item.name)}</div>
      <div class="pv-kind">${esc(KIND_LABEL[item.kind] || 'File')}</div>`;
    if (isUwp(item)) {
      // A packaged app: no file on disk to report, but it does have a logo.
      const logo = await sp.icon(item.path);
      if (mySeq !== previewSeq) return;
      previewEl.innerHTML = `<div class="pv-icon">${logo ? `<img src="${logo}" alt="">` : iconHtml}</div>
        <div class="pv-title">${esc(item.name)}</div>
        <div class="pv-kind">Installed app</div>
        <div class="pv-meta"><div><span>Package</span><span>${
          esc(item.path.slice('shell:AppsFolder\\'.length).split('!')[0])}</span></div></div>
        <div class="pv-actions"><button data-act="open">Open</button></div>`;
      return;
    }
    if (item.kind === 'setting' || /^shell:/i.test(item.path)) {
      previewEl.innerHTML += `<div class="pv-actions"><button data-act="open">Open</button></div>`;
      return;
    }
    // The list row may still be showing its emoji placeholder, so ask for the
    // real icon rather than copying whatever is on screen right now.
    const resolved = await sp.icon(item.path);
    if (mySeq !== previewSeq) return;
    if (resolved) iconHtml = `<img src="${resolved}" alt="">`;
    const info = await sp.preview(item);
    if (mySeq !== previewSeq || !info) return;
    const rows = [];
    if (info.missing) rows.push(['Status', 'Not found (index may be stale)']);
    if (info.size != null) rows.push(['Size', formatSize(info.size)]);
    if (info.isDir && info.children != null) rows.push(['Contains', `${info.children} items`]);
    if (info.modified) rows.push(['Modified', formatDate(info.modified)]);
    if (info.created) rows.push(['Created', formatDate(info.created)]);
    rows.push(['Location', parentDir(item.path)]);
    const thumb = info.thumbnail && item.kind === 'file' && item.category !== 'APPLICATIONS'
      ? `<img class="pv-thumb" src="${info.thumbnail}" alt="">` : `<div class="pv-icon">${iconHtml}</div>`;
    previewEl.innerHTML = `${thumb}
      <div class="pv-title">${esc(item.name)}</div>
      <div class="pv-kind">${esc(KIND_LABEL[item.kind] || 'File')}</div>
      ${info.text ? `<div class="pv-text">${esc(info.text)}</div>` : ''}
      <div class="pv-meta">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}</div>
      <div class="pv-actions"><button data-act="open">Open</button><button data-act="reveal">Show in folder</button><button data-act="copy-path">Copy path</button></div>`;
  }

  // ---------------------------------------------------------------- actions
  function activate(item, reveal = false) {
    if (!item) return;
    if (item.special === 'calc') { sp.copy(String(item.value)); flash('Copied'); return; }
    if (item.special === 'web') { sp.web(lastQuery); return; }
    if (reveal) sp.reveal(item); else sp.open(item);
  }
  function flash(msg) {
    $('hint').textContent = msg;
  }

  // Built-in commands, in the spirit of horus:reset / horus:kill.
  async function command(q) {
    const cmd = q.trim().toLowerCase();
    if (cmd === 'aero:reindex') { flash('Re-indexing…'); const s = await sp.reindex(); if (s) updateStats(s); flash('Index rebuilt'); return true; }
    if (cmd === 'aero:clear-history') { sp.clearHistory(); flash('Launch history cleared'); return true; }
    return false;
  }

  let timer = null;
  async function runQuery() {
    const q = input.value;
    lastQuery = q.trim();
    const mySeq = ++seq;
    if (!lastQuery) {
      $('body').classList.add('hidden');
      $('foot').classList.add('hidden');
      $('hint').textContent = '';
      setGhost('');
      flat = [];
      return;
    }
    const res = await sp.query(q);
    if (mySeq !== seq) return;
    $('body').classList.remove('hidden');
    $('foot').classList.remove('hidden');
    render(res);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runQuery, 40);
  });

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (input.value) { input.value = ''; runQuery(); } else sp.hide();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flat.length) { selected = (selected + 1) % flat.length; updateSelection(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length) { selected = (selected - 1 + flat.length) % flat.length; updateSelection(); }
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      if (flat.length) {
        selected = Math.max(0, Math.min(flat.length - 1, selected + (e.key === 'PageDown' ? 6 : -6)));
        updateSelection();
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (ghost.dataset.full) { input.value = ghost.dataset.full; runQuery(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (await command(input.value)) return;
      clearTimeout(timer);
      if (lastQuery !== input.value.trim()) await runQuery();
      activate(flat[selected], e.ctrlKey);
    } else if (e.key === 'c' && e.ctrlKey && !input.selectionStart && input.selectionEnd === 0) {
      const it = flat[selected];
      if (it && !it.special) { e.preventDefault(); sp.copy(it.path); flash('Path copied'); }
    }
  });

  resultsEl.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.item');
    if (row && Number(row.dataset.idx) !== selected) { selected = Number(row.dataset.idx); updateSelection(); }
  });
  resultsEl.addEventListener('click', (e) => {
    const row = e.target.closest('.item');
    if (row) activate(flat[Number(row.dataset.idx)]);
  });
  resultsEl.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in input

  previewEl.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    const item = flat[selected];
    if (!act || !item) return;
    if (act === 'open') activate(item);
    else if (act === 'reveal') activate(item, true);
    else if (act === 'copy') { sp.copy(String(item.value)); flash('Copied'); }
    else if (act === 'copy-path') { sp.copy(item.path); flash('Path copied'); }
    input.focus();
  });

  function updateStats(s) {
    stats = s || stats;
    if (stats) $('stats').textContent = `${stats.apps} apps · ${stats.files.toLocaleString()} files indexed`;
  }

  // Follow the host theme: main pushes CSS variables on load and on change.
  sp.onTheme((vars) => {
    for (const [k, v] of Object.entries(vars || {})) {
      document.documentElement.style.setProperty(k, v);
    }
  });

  sp.onShow(({ query, stats: s }) => {
    updateStats(s);
    input.value = query || '';
    input.focus();
    // Caret at the END: the query is text the user is mid-typing in the
    // sidebar bar. Selecting it made the next keystroke REPLACE it, which
    // read as "my first letter got lost".
    input.setSelectionRange(input.value.length, input.value.length);
    runQuery();
  });
  sp.onHidden(() => {
    input.value = '';
    runQuery();
  });
  sp.onIndexed(updateStats);
  sp.info().then((i) => updateStats(i.stats));
})();
