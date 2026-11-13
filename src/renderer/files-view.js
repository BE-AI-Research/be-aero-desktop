// File browser: the desktop widget and the separate file browser windows
// (files.html) both run this. Places (File Pool, user folders, drives,
// devices), a folder list (a click opens; Ctrl/Shift-click and dragging a
// box select), keyboard, inline rename, copy/cut/paste, drag and drop
// between windows and other apps, a small preview, and the copy / move
// jobs with progress, pause and stop (transfers.js in main). All file
// access goes through main; this only draws and asks.
(function () {
  let aero = null;
  let root = null;
  let listEl = null;
  let placesEl = null;
  let crumbsEl = null;
  let filterEl = null;
  let statusEl = null;
  let previewEl = null;
  let cur = null;                 // { path, parent, entries, inPool }
  let places = [];
  let selected = new Set();       // paths
  let anchor = null;              // for shift-select
  let clip = null;                // { paths, cut }
  let showHidden = false;
  let back = [];
  let forward = [];
  let filter = '';
  let view = 'list';              // list | grid (tiles)
  let tileObserver = null;
  const iconCache = new Map();    // path -> data URL ('' = none)
  let found = [];
  const lastRoots = {};           // device id -> { rootIndex: name } for crumbs                 // index matches elsewhere on this PC
  let searchTimer = null;
  let opts0 = {};                 // { window: true, start } in a file browser window
  let transfersEl = null;
  let jobs = [];
  const AERO_MIME = 'application/x-aero-paths';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const GLYPH = { folder: '📁', image: '🖼️', text: '📄', file: '📦', pool: '🌊', ai: '🤖', drive: '💽', network: '🖧', share: '🗂️', device: '💻' };
  const isRemote = (p) => /^aero:\/\//i.test(String(p || ''));
  const IS_WIN = navigator.userAgent.includes('Windows');

  function human(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024; let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }
  function when(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return Date.now() - ms < 86400000 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
  }
  function dur(s) {
    if (s == null) return '';
    if (s < 60) return `${Math.max(1, s)} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  }
  const trimSep = (p) => String(p || '').replace(/[\\/]+$/, '');
  const parentOf = (p) => (isRemote(p) ? String(p).replace(/\/[^/]*$/, '') : String(p).replace(/[\\/][^\\/]*$/, ''));
  const normSep = (p) => (IS_WIN && !isRemote(p) ? trimSep(String(p || '').replace(/\//g, '\\')).toLowerCase() : trimSep(p));
  const samePath = (a, b) => normSep(a) === normSep(b);

  // Start a copy or move job; its progress shows in the panel below the list.
  async function transfer(paths, dest, move) {
    // Dropping things where they already are does nothing (as in Explorer).
    const list = paths.filter((p) => !samePath(p, dest) && !(samePath(parentOf(p), dest)));
    if (!list.length) return;
    const r = await aero.transferStart(list, dest, !!move);
    if (!r || !r.ok) { status((r && r.error) || 'Could not start that.', true); return; }
    status(`${move ? 'Moving' : 'Copying'} ${list.length} item${list.length === 1 ? '' : 's'}…`);
  }

  const FINISHED = new Set(['done', 'done-with-errors', 'failed', 'stopped']);
  function renderTransfers(list) {
    const before = new Map(jobs.map((j) => [j.id, j.state]));
    jobs = Array.isArray(list) ? list : [];
    // A job just finished: show what changed.
    if (jobs.some((j) => FINISHED.has(j.state) && before.has(j.id) && !FINISHED.has(before.get(j.id)))) softRefresh();
    if (!transfersEl) return;
    transfersEl.classList.toggle('hidden', !jobs.length);
    // One box per job, updated in place: rebuilding 4 times a second would
    // swap a button out from under a click.
    const keep = new Set(jobs.map((j) => j.id));
    for (const box of [...transfersEl.children]) if (!keep.has(box.dataset.id)) box.remove();
    jobs.forEach((j, i) => {
      let box = transfersEl.querySelector(`.xfer[data-id="${CSS.escape(j.id)}"]`);
      const html = jobHtml(j);
      if (!box) {
        const t = document.createElement('div'); t.innerHTML = html.full; box = t.firstElementChild;
        box.dataset.state = j.state;
      } else if (box.dataset.state !== j.state) {
        const t = document.createElement('div'); t.innerHTML = html.full; const fresh = t.firstElementChild;
        fresh.dataset.state = j.state; box.replaceWith(fresh); box = fresh;
      } else {
        const set = (sel, fn) => { const e = box.querySelector(sel); if (e) fn(e); };
        set('.xfer-pct', (e) => { if (e.textContent !== html.pct) e.textContent = html.pct; });
        set('.xfer-bar i', (e) => { e.style.width = `${html.pctNum}%`; });
        set('.xfer-sub', (e) => { if (e.innerHTML !== html.sub) e.innerHTML = html.sub; });
        const err = box.querySelector('.xfer-err');
        if (html.err && !err) box.insertAdjacentHTML('beforeend', html.err);
        else if (err && html.err) { const t = document.createElement('div'); t.innerHTML = html.err; err.replaceWith(t.firstElementChild); }
      }
      if (transfersEl.children[i] !== box) transfersEl.insertBefore(box, transfersEl.children[i] || null);
    });
  }

  function jobHtml(j) {
    {
      const pct = j.total > 0 ? Math.min(100, Math.round((j.done / j.total) * 100)) : (FINISHED.has(j.state) ? 100 : 0);
      const live = j.state === 'running' || j.state === 'paused' || j.state === 'stopping';
      const sub = live
        ? [j.total ? `${human(j.done)} of ${human(j.total)}` : human(j.done),
            j.files > 1 ? `${j.filesDone} of ${j.files} files` : '',
            j.state === 'paused' ? 'paused' : j.state === 'stopping' ? 'stopping…' : (j.speed ? `${human(j.speed)}/s` : ''),
            j.state === 'running' && j.eta != null ? `${dur(j.eta)} left` : ''].filter(Boolean).join(' · ')
        : j.state === 'done' ? `Done - ${j.filesDone} file${j.filesDone === 1 ? '' : 's'}, ${human(j.done)}`
          : j.state === 'stopped' ? `Stopped - ${j.filesDone} file${j.filesDone === 1 ? '' : 's'} finished`
            : j.state === 'failed' ? 'Failed' : `Done, ${j.errorCount} problem${j.errorCount === 1 ? '' : 's'}`;
      const btns = live
        ? `${j.state === 'paused' ? `<button class="icon-btn" data-act="resume" title="Resume">▶</button>` : `<button class="icon-btn" data-act="pause" title="Pause"${j.state === 'stopping' ? ' disabled' : ''}>⏸</button>`}<button class="icon-btn" data-act="cancel" title="Stop"${j.state === 'stopping' ? ' disabled' : ''}>⏹</button>`
        : '<button class="icon-btn" data-act="clear" title="Dismiss">✕</button>';
      const pctText = live ? `${pct}%` : '';
      const subHtml = `${esc(sub)}${live && j.current ? ` · <span class="xfer-cur">${esc(j.current)}</span>` : ''}`;
      const err = j.errors && j.errors.length ? `<div class="xfer-err" title="${esc(j.errors.join('\n'))}">${esc(j.errors[j.errors.length - 1])}${j.errorCount > 1 ? ` (+${j.errorCount - 1} more)` : ''}</div>` : '';
      return {
        pct: pctText, pctNum: pct, sub: subHtml, err,
        full: `<div class="xfer xfer-${j.state}" data-id="${esc(j.id)}">
        <div class="xfer-top"><span class="xfer-title" title="${esc(j.title)} → ${esc(j.dest)}">${esc(j.title)}</span><span class="xfer-pct">${pctText}</span><span class="xfer-btns">${btns}</span></div>
        ${live ? `<div class="xfer-bar"><i style="width:${pct}%"></i></div>` : ''}
        <div class="xfer-sub">${subHtml}</div>
        ${err}
      </div>`
      };
    }
  }

  function status(text, isError) { statusEl.textContent = text || ''; statusEl.classList.toggle('err', !!isError); }

  function visible() {
    const f = filter.toLowerCase();
    // Half-copied files (".part") of a job still writing here are not shown.
    const writing = cur && jobs.some((j) => (j.state === 'running' || j.state === 'paused' || j.state === 'stopping') && samePath(j.dest, cur.path));
    return (cur ? cur.entries : [])
      .filter((e) => (showHidden || !e.hidden) && (!f || e.name.toLowerCase().includes(f)) && !(writing && /\.part$/i.test(e.name)))
      .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
  }

  function renderPlaces() {
    placesEl.innerHTML = '';
    let netHeader = false;
    let devHeader = false;
    for (const p of places) {
      if (p.kind === 'device' && !devHeader) {
        devHeader = true;
        const h = document.createElement('div');
        h.className = 'files-place-head';
        h.textContent = 'Devices';
        placesEl.appendChild(h);
      }
      if (p.kind === 'network' && !netHeader) {
        netHeader = true;
        const h = document.createElement('div');
        h.className = 'files-place-head';
        h.textContent = 'Network';
        placesEl.appendChild(h);
      }
      const b = document.createElement('button');
      b.className = `files-place${cur && (cur.path === p.path || (p.kind === 'pool' && cur.inPool && cur.path.startsWith(p.path))) ? ' on' : ''}`;
      b.title = p.path;
      b.innerHTML = `<span class="g">${p.relay ? '\u{1F5C4}️' : (GLYPH[p.kind] || GLYPH.folder)}</span><span class="n">${esc(p.name)}</span>`;
      if (p.relay) b.title = `${p.name}: Shared storage and the File Pool copy (encrypted)`;
      b.addEventListener('click', () => go(p.path));
      if (p.kind === 'network') {
        if (p.status && p.status !== 'OK') { b.classList.add('off'); b.title = `${p.remote} - ${p.status}`; }
        b.addEventListener('contextmenu', async (e) => {
          e.preventDefault();
          const action = await aero.filesNetMenu({ remote: p.remote, status: p.status });
          if (action === 'disconnect') {
            const r = await aero.filesNetDisconnect(IS_WIN && /^[A-Z]:\\$/i.test(p.path) ? p.path.slice(0, 2) : p.remote);
            status(r && r.ok ? `Disconnected ${p.name}.` : (r && r.error) || 'Could not disconnect.', !(r && r.ok));
            await reloadPlaces();
          }
        });
      }
      placesEl.appendChild(b);
    }
    if (!netHeader) {
      const h = document.createElement('div');
      h.className = 'files-place-head';
      h.textContent = 'Network';
      placesEl.appendChild(h);
    }
    const c = document.createElement('button');
    c.className = 'files-place files-connect';
    c.innerHTML = '<span class="g">＋</span><span class="n">Connect to server…</span>';
    c.title = IS_WIN ? 'Connect a network share (\\\\server\\share)' : 'Connect a network share (smb://server/share)';
    c.addEventListener('click', () => connectForm(''));
    placesEl.appendChild(c);
  }

  async function reloadPlaces() {
    const pr = await aero.filesPlaces();
    places = pr && pr.ok ? pr.result : places;
    renderPlaces();
  }

  // Connect to a network share: address, user, password (to the OS on
  // stdin - never stored by BE-Aero), drive letter on Windows, remember.
  async function connectForm(address) {
    const old = root.querySelector('.files-connect-form');
    if (old) old.remove();
    const f = document.createElement('form');
    f.className = 'files-connect-form';
    const letters = IS_WIN ? ((await aero.filesNetLetters()) || {}).result || [] : [];
    f.innerHTML = `
      <div class="files-connect-title">Connect to a network share</div>
      <input name="address" spellcheck="false" placeholder="${IS_WIN ? '\\\\server\\share' : 'smb://server/share'}" value="${esc(address)}" required>
      <div class="row"><input name="user" spellcheck="false" autocomplete="username" placeholder="User name (blank = as you / guest)"><input name="password" type="password" autocomplete="current-password" placeholder="Password"></div>
      <div class="row">${IS_WIN ? `<select name="letter"><option value="">No drive letter</option>${letters.map((L) => `<option value="${L}">${L}:</option>`).join('')}</select>` : ''}
        <label class="check"><input type="checkbox" name="remember"> ${IS_WIN ? 'Reconnect at sign-in (password kept in Windows Credential Manager)' : 'Keep connected'}</label></div>
      <div class="files-connect-err"></div>
      <div class="row"><button type="submit" class="btn">Connect</button><button type="button" class="btn files-connect-cancel">Cancel</button></div>`;
    root.appendChild(f);
    const err = f.querySelector('.files-connect-err');
    f.querySelector('.files-connect-cancel').addEventListener('click', () => f.remove());
    f.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') f.remove(); });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = new FormData(f);
      err.textContent = 'Connecting…';
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      const r = await aero.filesNetConnect({ address: d.get('address'), user: d.get('user'), password: d.get('password'), letter: d.get('letter') || '', remember: d.get('remember') === 'on' });
      btn.disabled = false;
      if (!r || !r.ok) { err.textContent = (r && r.error) || 'Could not connect.'; return; }
      f.remove();
      await reloadPlaces();
      go(r.result.path);
    });
    f.querySelector(address ? 'input[name=user]' : 'input[name=address]').focus();
  }

  // The path bar is editable, like Explorer's: click its empty space (or
  // Ctrl+L / Alt+D / F4) to type or paste a path; Enter goes, Esc returns.
  let editing = false;
  function editAddress() {
    if (editing || !cur) return;
    editing = true;
    crumbsEl.innerHTML = '';
    const input = document.createElement('input');
    input.className = 'files-address';
    input.type = 'text';
    input.spellcheck = false;
    input.value = cur.path;
    crumbsEl.appendChild(input);
    crumbsEl.classList.add('editing');
    input.focus();
    input.select();
    const done = () => { editing = false; crumbsEl.classList.remove('editing'); renderCrumbs(); };
    input.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { done(); listEl.focus(); }
      if (e.key === 'Enter') {
        const target = input.value.trim();
        if (!target) return;
        const ok = await go(target, { fromAddress: true });
        if (ok) { done(); listEl.focus(); } else { input.select(); }
      }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (editing && document.activeElement !== input) done(); }, 120));
  }

  function renderCrumbs() {
    if (editing) return;
    crumbsEl.innerHTML = '';
    if (!cur) return;
    const sep = cur.path.includes('\\') ? '\\' : '/';
    // Network paths start with the server: \\server\share\dir or smb://server/share/dir.
    if (isRemote(cur.path)) {
      const m = /^aero:\/\/([^/]+)(?:\/(\d+))?(?:\/(.*))?$/.exec(cur.path);
      const segs = [[cur.deviceName || 'Device', `aero://${m[1]}`]];
      if (m[2] !== undefined) {
        const rootName = (lastRoots[m[1]] || {})[m[2]] || 'Shared';
        segs.push([rootName, `aero://${m[1]}/${m[2]}`]);
        let acc2 = `aero://${m[1]}/${m[2]}`;
        for (const part of (m[3] || '').split('/').filter(Boolean)) { acc2 += `/${part}`; segs.push([part, acc2]); }
      }
      for (const [label, target] of segs) {
        const b = document.createElement('button');
        b.className = 'files-crumb';
        b.textContent = label;
        b.title = `${cur.deviceName || 'Device'}: ${label}`;
        b.addEventListener('click', () => go(target));
        crumbsEl.appendChild(b);
      }
      return;
    }
    const unc = /^\\\\([^\\]+)(.*)$/.exec(cur.path);
    const smbUri = /^smb:\/\/([^/]+)(.*)$/i.exec(cur.path);
    const net = unc || smbUri;
    const parts = net
      ? [net[1], ...net[2].split(/[\\/]/).filter(Boolean)]
      : cur.path.split(/[\\/]/).filter((x, i) => x || i === 0);
    let acc = '';
    parts.forEach((part, i) => {
      if (net) acc = i === 0 ? (unc ? `\\\\${part}` : `smb://${part}`) : `${acc}${unc ? '\\' : '/'}${part}`;
      else acc = i === 0 ? (part === '' ? '/' : `${part}${sep}`) : `${acc}${acc.endsWith(sep) ? '' : sep}${part}`;
      const target = acc;
      const b = document.createElement('button');
      b.className = 'files-crumb';
      b.textContent = part === '' ? '/' : part;
      b.title = target;
      b.addEventListener('click', () => go(target));
      crumbsEl.appendChild(b);
    });
    crumbsEl.scrollLeft = crumbsEl.scrollWidth;
  }

  function renderList() {
    const rows = visible();
    listEl.innerHTML = '';
    listEl.classList.toggle('grid', view === 'grid');
    if (tileObserver) tileObserver.disconnect();
    const extraNow = filter.length >= 2 ? found.filter((f) => !rows.some((x) => x.path === f.path)) : [];
    if (!rows.length && !extraNow.length) {
      const e = document.createElement('div');
      e.className = 'files-empty';
      e.textContent = filter ? 'Nothing matches.' : cur && cur.inPool ? 'The File Pool is empty. Drop files here, or right-click a file elsewhere and choose "Copy to File Pool".' : 'This folder is empty.';
      listEl.appendChild(e);
    }
    const extra = filter.length >= 2 ? found.filter((f) => !rows.some((x) => x.path === f.path)) : [];
    const all = rows.concat(extra.length ? [{ divider: true }] : [], extra);
    for (const e of all) {
      if (e.divider) {
        const d = document.createElement('div');
        d.className = 'files-divider';
        d.textContent = 'Elsewhere on this PC';
        listEl.appendChild(d);
        continue;
      }
      const r = document.createElement('div');
      r.className = `files-row${selected.has(e.path) ? ' sel' : ''}${e.hidden ? ' hidden-file' : ''}${clip && clip.cut && clip.paths.includes(e.path) ? ' cut' : ''}`;
      r.dataset.path = e.path;
      r.draggable = true;
      r.title = e.found ? `${e.name}\n${e.where}` : e.name;
      if (view === 'grid') {
        r.classList.add('tile');
        r.dataset.kind = e.kind;
        r.innerHTML = `<div class="ti">${GLYPH[e.kind] || GLYPH.file}</div><div class="tn">${esc(e.name)}</div>`;
        if (e.found) r.classList.add('found');
        listEl.appendChild(r);
        continue;
      }
      r.innerHTML = e.found
        ? `<span class="g">${GLYPH[e.kind] || GLYPH.file}</span><span class="n">${esc(e.name)}<small class="files-where">${esc(e.where)}</small></span>`
        : `<span class="g">${GLYPH[e.kind] || GLYPH.file}</span><span class="n">${esc(e.name)}</span><span class="s">${e.dir ? '' : human(e.size)}</span><span class="t">${when(e.mtime)}</span>`;
      if (e.found) r.classList.add('found');
      listEl.appendChild(r);
    }
    if (view === 'grid') observeTiles();
    const n = rows.length;
    if (filter.length >= 2) { status(`${n} here · ${extra.length} elsewhere${selected.size ? ` · ${selected.size} selected` : ''}`); renderPreview(); return; }
    status(`${n} item${n === 1 ? '' : 's'}${selected.size ? ` · ${selected.size} selected` : ''}${cur && cur.truncated ? ' · showing the first 5000' : ''}`);
    renderPreview();
  }

  // Tiles fetch their real picture as they scroll into view: a thumbnail
  // for images, the system's icon for other files (folders keep the glyph).
  function observeTiles() {
    if (!tileObserver) {
      tileObserver = new IntersectionObserver((hits) => {
        for (const h of hits) {
          if (!h.isIntersecting) continue;
          tileObserver.unobserve(h.target);
          loadTileIcon(h.target);
        }
      }, { root: listEl, rootMargin: '120px' });
    }
    for (const t of listEl.querySelectorAll('.files-row.tile')) {
      if (t.dataset.kind === 'folder' || t.dataset.kind === 'share') continue;
      const cached = iconCache.get(t.dataset.path);
      if (cached) { setTileIcon(t, cached); continue; }
      if (cached === '') continue;
      tileObserver.observe(t);
    }
  }
  function setTileIcon(tile, url) {
    const ti = tile.querySelector('.ti');
    if (!ti || !url) return;
    ti.innerHTML = `<img src="${url}" alt="" draggable="false">`;
  }
  async function loadTileIcon(tile) {
    const p = tile.dataset.path;
    let url = '';
    try {
      if (tile.dataset.kind === 'image') {
        const r = await aero.filesPreview(p);
        if (r && r.ok && r.result.kind === 'image') url = r.result.dataUrl;
      }
      if (!url) url = (await aero.filesIcon(p, 'large')) || '';
    } catch { url = ''; }
    if (iconCache.size > 800) iconCache.clear();
    iconCache.set(p, url);
    if (tile.isConnected) setTileIcon(tile, url);
  }

  function setView(v) {
    view = v === 'grid' ? 'grid' : 'list';
    const b = root.querySelector('.files-view');
    if (b) { b.textContent = view === 'grid' ? '☰' : '▦'; b.title = view === 'grid' ? 'Show as a list' : 'Show as tiles'; }
    renderList();
  }

  async function renderPreview() {
    const one = selected.size === 1 ? [...selected][0] : null;
    const e = one ? entryOf(one) : null;
    if (!e || e.dir) { previewEl.classList.add('hidden'); previewEl.innerHTML = ''; return; }
    const r = await aero.filesPreview(e.path);
    if (selected.size !== 1 || !selected.has(e.path)) return;          // selection moved on
    const p = r && r.ok ? r.result : null;
    if (!p || (p.kind !== 'image' && p.kind !== 'text')) { previewEl.classList.add('hidden'); return; }
    previewEl.classList.remove('hidden');
    previewEl.innerHTML = p.kind === 'image'
      ? `<img src="${p.dataUrl}" alt="">`
      : `<pre>${esc(p.text)}${p.truncated ? '\n…' : ''}</pre>`;
  }

  async function go(dir, { push = true } = {}) {
    const r = await aero.filesList(dir);
    if (r && r.needsConnect) { status('That share needs you to connect first.'); connectForm(String(dir)); return false; }
    if (!r || !r.ok) {
      const msg = r && r.error ? r.error.replace(/^Error:\s*/, '') : 'Cannot open that folder.';
      if (msg === 'needs sign-in') { connectForm(String(dir)); status('Sign in to see this server\'s shares.'); return false; }
      status(msg, true);
      return false;
    }
    if (push && cur && cur.path !== r.result.path) { back.push(cur.path); forward = []; }
    cur = r.result;
    if (isRemote(cur.path) && /^aero:\/\/[^/]+$/.test(cur.path)) {
      const dev = cur.path.slice(7);
      lastRoots[dev] = Object.fromEntries(cur.entries.map((e) => [e.path.split('/').pop(), e.name]));
    }
    selected = new Set();
    anchor = null;
    filter = '';
    filterEl.value = '';
    renderPlaces(); renderCrumbs(); renderList();
    if (opts0.window) document.title = `${(isRemote(cur.path) ? (cur.deviceName || 'Device') : '') || cur.path.split(/[\\/]/).filter(Boolean).pop() || cur.path} - Files`;
    else aero.setSettings({ files: { last: cur.path } });
    if (aero.filesWatch) aero.filesWatch(cur.path);
    return true;
  }

  // The folder changed on disk (here, another app, or File Pool sync):
  // reload it in place - selection, scroll position and search kept.
  async function softRefresh() {
    if (!cur || editing || root.querySelector('.files-rename')) return;
    const r = await aero.filesList(cur.path);
    if (!r || !r.ok) return;
    const top = listEl.scrollTop;
    const paths = new Set(r.result.entries.map((e) => e.path));
    cur = r.result;
    selected = new Set([...selected].filter((p) => paths.has(p)));
    renderList();
    listEl.scrollTop = top;
  }
  const refresh = () => (cur ? go(cur.path, { push: false }).then(() => {}) : null);

  function selectRow(path, e) {
    const rows = visible().map((x) => x.path).concat(filter.length >= 2 ? found.map((x) => x.path) : []);
    if (e && e.shiftKey && anchor) {
      const a = rows.indexOf(anchor); const b = rows.indexOf(path);
      if (a >= 0 && b >= 0) { selected = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1)); markSelection(); return; }
    }
    if (e && (e.ctrlKey || e.metaKey)) { if (selected.has(path)) selected.delete(path); else selected.add(path); }
    else selected = new Set([path]);
    anchor = path;
    markSelection();
  }

  // Selection changed: mark the rows (no rebuild - keeps a drag alive).
  function markSelection({ preview = true } = {}) {
    for (const r of listEl.querySelectorAll('.files-row')) r.classList.toggle('sel', selected.has(r.dataset.path));
    const n = listEl.querySelectorAll('.files-row:not(.found)').length;
    status(`${n} item${n === 1 ? '' : 's'}${selected.size ? ` · ${selected.size} selected` : ''}`);
    if (preview) renderPreview();
  }

  const entryOf = (path) => (cur && cur.entries.find((x) => x.path === path)) || found.find((x) => x.path === path) || null;

  async function openEntry(path) {
    const e = entryOf(path);
    if (!e) return;
    if (e.dir) { go(e.path); return; }
    const r = await aero.filesOpen(e.path);
    if (!r || !r.ok) status(r && r.error || 'Could not open it.', true);
  }

  function renameInline(path) {
    const row = listEl.querySelector(`.files-row[data-path="${CSS.escape(path)}"]`);
    if (!row) return;
    const n = row.querySelector('.n, .tn');
    const old = n.textContent;
    const input = document.createElement('input');
    input.className = 'files-rename';
    input.value = old;
    n.replaceWith(input);
    input.focus();
    const dot = old.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : old.length);
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      if (save && input.value.trim() && input.value !== old) {
        const r = await aero.filesRename(path, input.value.trim());
        if (!r || !r.ok) status(r && r.error || 'Could not rename.', true);
        else { await refresh(); selected = new Set([r.result]); renderList(); return; }
      }
      renderList();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
  }

  async function paste(into) {
    if (!clip || !clip.paths.length) return;
    const dest = into || cur.path;
    const { paths, cut } = clip;
    if (cut) { clip = null; renderList(); }
    await transfer(paths, dest, cut);
  }

  async function act(action, paths) {
    const one = paths[0];
    switch (action) {
      case 'open': for (const p of paths) await openEntry(p); break;
      case 'reveal': aero.filesReveal(one); break;
      case 'reveal-here': aero.filesOpen(cur.path); break;
      case 'copy': clip = { paths, cut: false }; status(`${paths.length} copied - paste in any folder.`); renderList(); break;
      case 'cut': clip = { paths, cut: true }; status(`${paths.length} cut - paste where they should go.`); renderList(); break;
      case 'paste': await paste(paths.length === 1 && (entryOf(one) || {}).dir ? one : null); break;
      case 'to-pool': {
        const r = await aero.filesPool();
        if (r && r.ok) await transfer(paths, r.result, false); else status((r && r.error) || 'Could not open the File Pool.', true);
        break;
      }
      case 'new-window': aero.filesNewWindow(one); break;
      case 'new-window-here': aero.filesNewWindow(cur.path); break;
      case 'rename': renameInline(one); break;
      case 'trash': {
        const r = await aero.filesTrash(paths);
        if (!r || !r.ok) status(r && r.error || 'Could not delete.', true); else { await refresh(); status(`${paths.length} moved to the ${navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash'}.`); }
        break;
      }
      case 'copy-path': aero.filesCopyPath(one); status('Path copied.'); break;
      case 'html-widget': {
        status('Making a widget…');
        const r = await aero.filesHtmlWidget(one);
        status(r && r.ok ? `"${r.title}" is on your desktop${r.copied ? ` (with ${r.copied} of its files)` : ''}. It lives in AI Folder > AI Widgets.` : `Could not make a widget: ${(r && r.error) || 'unknown error'}`);
        break;
      }
      case 'mkdir': {
        const r = await aero.filesMkdir(cur.path, 'New folder');
        if (r && r.ok) { await refresh(); selected = new Set([r.result]); renderList(); renameInline(r.result); }
        else status(r && r.error || 'Could not create the folder.', true);
        break;
      }
      case 'toggle-hidden': showHidden = !showHidden; aero.setSettings({ files: { showHidden } }); renderList(); break;
      default: break;
    }
  }

  function wire() {
    // A click opens (a folder goes in, a file opens in its app); Ctrl / Shift
    // click selects; dragging a box over empty space selects what it covers.
    listEl.addEventListener('click', (e) => {
      if (bandDone) { bandDone = false; return; }
      if (e.target.closest('.files-rename')) return;
      const row = e.target.closest('.files-row');
      if (!row) { selected = new Set(); renderList(); return; }
      if (e.ctrlKey || e.metaKey || e.shiftKey) { selectRow(row.dataset.path, e); return; }
      if (e.detail > 1) return;                        // the second click of a double click
      selected = new Set([row.dataset.path]); anchor = row.dataset.path;
      markSelection();
      openEntry(row.dataset.path);
    });
    let bandDone = false;
    listEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.files-row, .files-rename')) return;
      if (e.offsetX > listEl.clientWidth || e.offsetY > listEl.clientHeight) return;   // the scroll bar
      listEl.focus();
      const at = (ev) => { const b = listEl.getBoundingClientRect(); return [ev.clientX - b.left + listEl.scrollLeft, ev.clientY - b.top + listEl.scrollTop]; };
      const [sx, sy] = at(e);
      const base = e.ctrlKey || e.metaKey ? new Set(selected) : new Set();
      const boxes = [...listEl.querySelectorAll('.files-row')].map((r) => ({ p: r.dataset.path, l: r.offsetLeft, t: r.offsetTop, w: r.offsetWidth, h: r.offsetHeight }));
      let band = null;
      let last = e;
      const update = () => {
        const [x, y] = at(last);
        if (!band && Math.hypot(x - sx, y - sy) < 5) return;
        if (!band) { band = document.createElement('div'); band.className = 'files-band'; listEl.appendChild(band); }
        const l = Math.min(x, sx); const t = Math.min(y, sy); const w = Math.abs(x - sx); const h = Math.abs(y - sy);
        Object.assign(band.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` });
        const sel = new Set(base);
        for (const r of boxes) {
          if (r.l < l + w && r.l + r.w > l && r.t < t + h && r.t + r.h > t) {
            if (base.has(r.p)) sel.delete(r.p); else sel.add(r.p);
          }
        }
        selected = sel;
        markSelection({ preview: false });
      };
      // Near the top or bottom edge, the list scrolls on its own.
      const scroller = setInterval(() => {
        if (!band) return;
        const b = listEl.getBoundingClientRect();
        if (last.clientY < b.top + 18) listEl.scrollTop -= 14; else if (last.clientY > b.bottom - 18) listEl.scrollTop += 14; else return;
        update();
      }, 30);
      const move = (ev) => { last = ev; update(); };
      const up = () => {
        clearInterval(scroller);
        listEl.removeEventListener('pointermove', move);
        listEl.removeEventListener('pointerup', up);
        listEl.removeEventListener('pointercancel', up);
        if (band) { band.remove(); bandDone = true; setTimeout(() => { bandDone = false; }, 0); anchor = [...selected].pop() || null; renderList(); }
      };
      try { listEl.setPointerCapture(e.pointerId); } catch { /* gone */ }
      listEl.addEventListener('pointermove', move);
      listEl.addEventListener('pointerup', up);
      listEl.addEventListener('pointercancel', up);
    });
    listEl.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const row = e.target.closest('.files-row');
      if (row && !selected.has(row.dataset.path)) selectRow(row.dataset.path, null);
      const paths = row ? [...selected] : [];
      const firstEntry = paths.length === 1 && entryOf(paths[0]);
      const action = await aero.filesMenu({ count: paths.length, dir: !!(firstEntry && firstEntry.dir), inPool: cur.inPool, path: firstEntry && firstEntry.dir ? paths[0] : null, here: cur.path, html: !!(firstEntry && !firstEntry.dir && /\.html?$/i.test(firstEntry.name || paths[0])), canPaste: !!(clip && clip.paths.length) && (!isRemote(cur.path) || !!cur.writable), showHidden, readOnly: isRemote(cur.path) && !cur.writable });
      if (action) act(action, paths);
    });
    listEl.addEventListener('keydown', (e) => {
      if (e.target !== listEl) return;
      const rows = visible();
      const paths = [...selected];
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'a') { selected = new Set(rows.map((x) => x.path)); renderList(); e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'c' && paths.length) { act('copy', paths); return; }
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'x' && paths.length) { act('cut', paths); return; }
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'v') { paste(); return; }
      if (k === 'Enter' && paths.length) { act('open', paths); return; }
      if (k === 'Backspace' || (e.altKey && k === 'ArrowUp')) { if (cur.parent) go(cur.parent); e.preventDefault(); return; }
      if (k === 'F2' && paths.length === 1) { renameInline(paths[0]); return; }
      if (k === 'Delete' && paths.length) { act('trash', paths); return; }
      if (k === 'ArrowDown' || k === 'ArrowUp' || (view === 'grid' && (k === 'ArrowLeft' || k === 'ArrowRight'))) {
        e.preventDefault();
        const i = rows.findIndex((x) => x.path === anchor);
        // In the tile grid, up/down move a whole row.
        const first = listEl.querySelector('.files-row.tile');
        const cols = view === 'grid' && first ? Math.max(1, Math.floor(listEl.clientWidth / (first.getBoundingClientRect().width + 4))) : 1;
        const step = k === 'ArrowDown' ? cols : k === 'ArrowUp' ? -cols : k === 'ArrowRight' ? 1 : -1;
        const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + step))];
        if (next) { selectRow(next.path, e.shiftKey ? { shiftKey: true } : null); const el = listEl.querySelector(`.files-row[data-path="${CSS.escape(next.path)}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); }
      }
    });
    // Drag and drop: between file browser windows, onto a folder, out to
    // other apps and in from them. Copy; hold Shift to move. Files on this
    // PC travel as real files (any app takes them); files on other devices
    // travel as their aero:// addresses, which BE-Aero windows understand.
    listEl.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.files-row');
      if (!row) return;
      if (!selected.has(row.dataset.path)) { selected = new Set([row.dataset.path]); anchor = row.dataset.path; markSelection(); }
      const paths = [...selected];
      if (paths.some(isRemote)) {
        e.dataTransfer.setData(AERO_MIME, JSON.stringify(paths));
        e.dataTransfer.setData('text/plain', paths.join('\n'));
        e.dataTransfer.effectAllowed = 'copyMove';
        return;
      }
      e.preventDefault();
      aero.filesDrag(paths);
    });
    const dropRow = (e) => {
      const row = e.target.closest && e.target.closest('.files-row');
      const en = row && entryOf(row.dataset.path);
      return en && en.dir && !en.found ? row : null;
    };
    const clearDrop = () => { listEl.classList.remove('drop'); for (const r of listEl.querySelectorAll('.files-row.drop-into')) r.classList.remove('drop-into'); };
    listEl.addEventListener('dragover', (e) => {
      const types = e.dataTransfer ? [...e.dataTransfer.types] : [];
      if (!types.includes('Files') && !types.includes(AERO_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy';
      const row = dropRow(e);
      for (const r of listEl.querySelectorAll('.files-row.drop-into')) if (r !== row) r.classList.remove('drop-into');
      if (row) row.classList.add('drop-into');
      listEl.classList.toggle('drop', !row);
    });
    listEl.addEventListener('dragleave', (e) => { if (!listEl.contains(e.relatedTarget)) clearDrop(); });
    listEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      const row = dropRow(e);
      clearDrop();
      if (!cur) return;
      let paths = [];
      try { paths = JSON.parse(e.dataTransfer.getData(AERO_MIME) || '[]').filter((p) => typeof p === 'string'); } catch { paths = []; }
      if (!paths.length) paths = [...(e.dataTransfer.files || [])].map((f) => aero.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      const dest = row && !paths.some((p) => samePath(p, row.dataset.path)) ? row.dataset.path : cur.path;
      await transfer(paths, dest, e.shiftKey);
    });
    root.querySelector('.files-back').addEventListener('click', () => { const p = back.pop(); if (p) { forward.push(cur.path); go(p, { push: false }); } });
    root.querySelector('.files-up').addEventListener('click', () => { if (cur && cur.parent) go(cur.parent); });
    root.querySelector('.files-new').addEventListener('click', () => act('mkdir', []));
    const nw = root.querySelector('.files-newwin');
    if (nw) {
      if (opts0.window) nw.title = 'Open another window here';
      nw.addEventListener('click', () => aero.filesNewWindow(cur ? cur.path : ''));
    }
    transfersEl.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]');
      const box = b && b.closest('.xfer');
      if (!box) return;
      const id = box.dataset.id;
      const fn = { pause: aero.transferPause, resume: aero.transferResume, cancel: aero.transferCancel, clear: aero.transferClear }[b.dataset.act];
      if (fn) await fn(id);
    });
    root.querySelector('.files-pool').addEventListener('click', async () => { const r = await aero.filesPool(); if (r && r.ok) go(r.result); });
    root.querySelector('.files-view').addEventListener('click', () => { setView(view === 'grid' ? 'list' : 'grid'); aero.setSettings({ files: { view } }); });
    // Search: the current folder narrows as you type; after a pause the
    // whole-PC index (Spotlight's) adds matches from everywhere else.
    crumbsEl.addEventListener('click', (e) => { if (!e.target.closest('.files-crumb')) editAddress(); });
    crumbsEl.title = 'Click to type a path (Ctrl+L)';
    root.addEventListener('keydown', (e) => {
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') || (e.altKey && e.key.toLowerCase() === 'd') || e.key === 'F4') { e.preventDefault(); editAddress(); }
    });
    filterEl.addEventListener('input', () => {
      filter = filterEl.value.trim();
      renderList();
      clearTimeout(searchTimer);
      if (filter.length < 2) { found = []; return; }
      const q = filter;
      searchTimer = setTimeout(async () => {
        const r = await aero.filesSearch(q);
        if (q !== filter) return;
        const sep = navigator.userAgent.includes('Windows') ? '\\' : '/';
        found = r && r.ok ? r.result.results.map((x) => {
          const cut = x.path.lastIndexOf(sep);
          return { ...x, dir: x.kind === 'folder', kind: x.kind === 'folder' ? 'folder' : /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(x.name) ? 'image' : 'file', found: true, where: cut > 0 ? x.path.slice(0, cut) : '' };
        }) : [];
        if (r && r.ok && r.result.indexing && !found.length) status('Still indexing this PC - try again in a moment.');
        renderList();
        // Then my other devices' shared folders ("On <device>"), when they answer.
        if (!aero.filesSearchRemote) return;
        const rr = await aero.filesSearchRemote(q);
        if (q !== filter || !rr || !rr.ok || !rr.result.length) return;
        found = found.concat(rr.result.map((x) => ({
          name: x.name, path: x.path, dir: x.dir, found: true, remote: true, where: x.where,
          kind: x.dir ? 'folder' : /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(x.name) ? 'image' : 'file'
        })));
        renderList();
      }, 220);
    });
    filterEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { filterEl.value = ''; filter = ''; found = []; renderList(); listEl.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); listEl.focus(); const first = visible()[0] || found[0]; if (first) selectRow(first.path, null); }
      if (e.key === 'Enter') { const first = visible()[0] || found[0]; if (first) openEntry(first.path); }
    });
  }

  // The places sidebar is resizable: drag the divider left or right; drag it
  // all the way left (or double-click it) to fold the sidebar away. The
  // desktop widget and the file browser windows remember their own width.
  function sidebar(saved) {
    const body = root.querySelector('.files-body');
    if (!body || root.querySelector('.files-split')) return;
    const key = opts0.window ? 'placesWidthWin' : 'placesWidth';
    const DEFAULT = opts0.window ? 168 : 108;
    const MIN = 72;
    const split = document.createElement('div');
    split.className = 'files-split no-drag';
    split.title = 'Drag to resize the sidebar; double-click to hide or show it';
    placesEl.after(split);
    let width = Number.isFinite(saved) ? saved : DEFAULT;
    let last = width > 0 ? width : DEFAULT;          // to come back to after folding
    const max = () => Math.max(MIN, Math.floor(body.clientWidth * 0.6));
    const apply = (w) => {
      width = w <= 0 ? 0 : Math.min(max(), Math.max(MIN, Math.round(w)));
      placesEl.style.width = `${width}px`;
      placesEl.classList.toggle('folded', width === 0);
      split.classList.toggle('folded', width === 0);
    };
    const save = () => aero.setSettings({ files: { [key]: width } });
    apply(width);
    split.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX;
      const w0 = width;
      split.classList.add('dragging');
      try { split.setPointerCapture(e.pointerId); } catch { /* gone */ }
      const move = (ev) => {
        const w = w0 + (ev.clientX - x0);
        // Below half the minimum it folds away; past that it snaps to the minimum.
        apply(w < MIN / 2 ? 0 : w);
      };
      const up = () => {
        split.classList.remove('dragging');
        split.removeEventListener('pointermove', move);
        split.removeEventListener('pointerup', up);
        split.removeEventListener('pointercancel', up);
        if (width > 0) last = width;
        save();
      };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', up);
      split.addEventListener('pointercancel', up);
    });
    split.addEventListener('dblclick', () => {
      if (width > 0) { last = width; apply(0); } else apply(last || DEFAULT);
      save();
    });
    // A smaller widget or window: keep the sidebar within its limit.
    if (window.ResizeObserver) new ResizeObserver(() => { if (width > max()) apply(width); }).observe(body);
  }

  async function init(opts) {
    aero = opts.aero;
    opts0 = opts;
    root = document.querySelector('.files-widget');
    if (!root || !aero.filesList) return;
    listEl = root.querySelector('.files-list');
    placesEl = root.querySelector('.files-places');
    crumbsEl = root.querySelector('.files-crumbs');
    filterEl = root.querySelector('.files-filter');
    statusEl = root.querySelector('.files-status');
    previewEl = root.querySelector('.files-preview');
    transfersEl = root.querySelector('.files-transfers');
    if (!transfersEl) { transfersEl = document.createElement('div'); transfersEl.className = 'files-transfers hidden'; statusEl.before(transfersEl); }
    wire();
    if (aero.onTransfers) { aero.onTransfers(renderTransfers); aero.transferList().then(renderTransfers).catch(() => {}); }
    if (aero.onFilesChanged) aero.onFilesChanged(({ dir }) => { if (cur && dir === cur.path) softRefresh(); });
    // Devices (and the relay) coming online or going: the places list follows.
    if (aero.onDevicesChanged) {
      let last = '';
      let t = null;
      aero.onDevicesChanged((st) => {
        const key = ((st && st.peers) || []).filter((p) => p.online).map((p) => p.id).sort().join(',');
        if (key === last) return;
        last = key;
        clearTimeout(t);
        t = setTimeout(reloadPlaces, 400);
      });
    }
    const s = (await aero.getSettings()).files || {};
    showHidden = !!s.showHidden;
    sidebar(Number(opts.window ? s.placesWidthWin : s.placesWidth));
    view = s.view === 'grid' ? 'grid' : 'list';
    setView(view);
    const pr = await aero.filesPlaces();
    places = pr && pr.ok ? pr.result : [];
    const home = (places.find((p) => p.id === 'home') || places[1] || {}).path;
    // Do not start on a network share (it may be slow or gone); start home.
    const start = opts.start || (s.last && !/^(\\\\|smb:)/i.test(s.last) ? s.last : home);
    await go(start, { push: false });
    if (!cur && places[1]) await go(places[1].path, { push: false });
  }

  window.AeroFiles = { init, go };
})();
