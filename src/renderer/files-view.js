// File browser widget: places (File Pool, user folders, drives), a folder
// list with selection, keyboard, inline rename, copy/cut/paste, drag out to
// other apps, drop in from them, and a small preview. All file access goes
// through main (files.js); this only draws and asks.
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
  let found = [];                 // index matches elsewhere on this PC
  let searchTimer = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const GLYPH = { folder: '📁', image: '🖼️', text: '📄', file: '📦', pool: '🌊', ai: '🤖', drive: '💽', network: '🖧', share: '🗂️' };
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
  function status(text, isError) { statusEl.textContent = text || ''; statusEl.classList.toggle('err', !!isError); }

  function visible() {
    const f = filter.toLowerCase();
    return (cur ? cur.entries : [])
      .filter((e) => (showHidden || !e.hidden) && (!f || e.name.toLowerCase().includes(f)))
      .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
  }

  function renderPlaces() {
    placesEl.innerHTML = '';
    let netHeader = false;
    for (const p of places) {
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
      b.innerHTML = `<span class="g">${GLYPH[p.kind] || GLYPH.folder}</span><span class="n">${esc(p.name)}</span>`;
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
      r.title = e.name;
      r.innerHTML = e.found
        ? `<span class="g">${GLYPH[e.kind] || GLYPH.file}</span><span class="n">${esc(e.name)}<small class="files-where">${esc(e.where)}</small></span>`
        : `<span class="g">${GLYPH[e.kind] || GLYPH.file}</span><span class="n">${esc(e.name)}</span><span class="s">${e.dir ? '' : human(e.size)}</span><span class="t">${when(e.mtime)}</span>`;
      if (e.found) r.classList.add('found');
      listEl.appendChild(r);
    }
    const n = rows.length;
    if (filter.length >= 2) { status(`${n} here · ${extra.length} elsewhere${selected.size ? ` · ${selected.size} selected` : ''}`); renderPreview(); return; }
    status(`${n} item${n === 1 ? '' : 's'}${selected.size ? ` · ${selected.size} selected` : ''}${cur && cur.truncated ? ' · showing the first 5000' : ''}`);
    renderPreview();
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
    selected = new Set();
    anchor = null;
    filter = '';
    filterEl.value = '';
    renderPlaces(); renderCrumbs(); renderList();
    aero.setSettings({ files: { last: cur.path } });
    return true;
  }
  const refresh = () => (cur ? go(cur.path, { push: false }).then(() => {}) : null);

  function selectRow(path, e) {
    const rows = visible().map((x) => x.path).concat(filter.length >= 2 ? found.map((x) => x.path) : []);
    if (e && e.shiftKey && anchor) {
      const a = rows.indexOf(anchor); const b = rows.indexOf(path);
      if (a >= 0 && b >= 0) { selected = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1)); renderList(); return; }
    }
    if (e && (e.ctrlKey || e.metaKey)) { if (selected.has(path)) selected.delete(path); else selected.add(path); }
    else selected = new Set([path]);
    anchor = path;
    renderList();
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
    const n = row.querySelector('.n');
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
    status(clip.cut ? 'Moving…' : 'Copying…');
    const r = await aero.filesTransfer(clip.paths, dest, clip.cut);
    if (!r || !r.ok) { status(r && r.error || 'Could not paste.', true); return; }
    if (clip.cut) clip = null;
    await refresh();
    status(`${r.result.length} item${r.result.length === 1 ? '' : 's'} ${clip ? 'copied' : 'moved'}.`);
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
        status('Copying to the File Pool…');
        const r = await aero.filesToPool(paths);
        status(r && r.ok ? `Copied to the File Pool (${r.result.length}).` : (r && r.error) || 'Could not copy.', !(r && r.ok));
        break;
      }
      case 'rename': renameInline(one); break;
      case 'trash': {
        const r = await aero.filesTrash(paths);
        if (!r || !r.ok) status(r && r.error || 'Could not delete.', true); else { await refresh(); status(`${paths.length} moved to the ${navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash'}.`); }
        break;
      }
      case 'copy-path': aero.filesCopyPath(one); status('Path copied.'); break;
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
    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('.files-row');
      if (!row) { selected = new Set(); renderList(); return; }
      selectRow(row.dataset.path, e);
    });
    listEl.addEventListener('dblclick', (e) => { const row = e.target.closest('.files-row'); if (row) openEntry(row.dataset.path); });
    listEl.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const row = e.target.closest('.files-row');
      if (row && !selected.has(row.dataset.path)) selectRow(row.dataset.path, null);
      const paths = row ? [...selected] : [];
      const firstEntry = paths.length === 1 && entryOf(paths[0]);
      const action = await aero.filesMenu({ count: paths.length, dir: !!(firstEntry && firstEntry.dir), inPool: cur.inPool, canPaste: !!(clip && clip.paths.length), showHidden });
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
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        const i = rows.findIndex((x) => x.path === anchor);
        const next = rows[Math.max(0, Math.min(rows.length - 1, i + (k === 'ArrowDown' ? 1 : -1)))];
        if (next) { selectRow(next.path, e.shiftKey ? { shiftKey: true } : null); const el = listEl.querySelector(`.files-row[data-path="${CSS.escape(next.path)}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); }
      }
    });
    // Drag out to other apps; drop in from them (copy; Shift = move).
    listEl.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.files-row');
      if (!row) return;
      if (!selected.has(row.dataset.path)) selectRow(row.dataset.path, null);
      e.preventDefault();
      aero.filesDrag([...selected]);
    });
    listEl.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); listEl.classList.add('drop'); } });
    listEl.addEventListener('dragleave', () => listEl.classList.remove('drop'));
    listEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      listEl.classList.remove('drop');
      const paths = [...(e.dataTransfer.files || [])].map((f) => aero.pathForFile(f)).filter(Boolean);
      if (!paths.length || !cur) return;
      status(e.shiftKey ? 'Moving…' : 'Copying…');
      const r = await aero.filesTransfer(paths, cur.path, e.shiftKey);
      if (!r || !r.ok) status(r && r.error || 'Could not copy those files.', true);
      else { await refresh(); status(`${r.result.length} item${r.result.length === 1 ? '' : 's'} ${e.shiftKey ? 'moved' : 'copied'} here.`); }
    });
    root.querySelector('.files-back').addEventListener('click', () => { const p = back.pop(); if (p) { forward.push(cur.path); go(p, { push: false }); } });
    root.querySelector('.files-up').addEventListener('click', () => { if (cur && cur.parent) go(cur.parent); });
    root.querySelector('.files-new').addEventListener('click', () => act('mkdir', []));
    root.querySelector('.files-pool').addEventListener('click', async () => { const r = await aero.filesPool(); if (r && r.ok) go(r.result); });
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
      }, 220);
    });
    filterEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { filterEl.value = ''; filter = ''; found = []; renderList(); listEl.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); listEl.focus(); const first = visible()[0] || found[0]; if (first) selectRow(first.path, null); }
      if (e.key === 'Enter') { const first = visible()[0] || found[0]; if (first) openEntry(first.path); }
    });
  }

  async function init(opts) {
    aero = opts.aero;
    root = document.querySelector('.files-widget');
    if (!root || !aero.filesList) return;
    listEl = root.querySelector('.files-list');
    placesEl = root.querySelector('.files-places');
    crumbsEl = root.querySelector('.files-crumbs');
    filterEl = root.querySelector('.files-filter');
    statusEl = root.querySelector('.files-status');
    previewEl = root.querySelector('.files-preview');
    wire();
    const s = (await aero.getSettings()).files || {};
    showHidden = !!s.showHidden;
    const pr = await aero.filesPlaces();
    places = pr && pr.ok ? pr.result : [];
    const home = (places.find((p) => p.id === 'home') || places[1] || {}).path;
    // Do not start on a network share (it may be slow or gone); start home.
    const start = s.last && !/^(\\\\|smb:)/i.test(s.last) ? s.last : home;
    await go(start, { push: false });
    if (!cur && places[1]) await go(places[1].path, { push: false });
  }

  window.AeroFiles = { init, go };
})();
