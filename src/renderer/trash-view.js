// Recycle Bin / Trash: a dock tile. Click opens it; right-click for Open and
// Empty; drop files on it to move them there. The icon fills when there is
// something in it.
(function () {
  let aero = null;
  let state = { supported: false };
  let tileEl = null;

  const EMPTY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
  const FULL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M4 9h16M6 9l1 11h10l1-11M10 12.5v5M14 12.5v5"/><path fill="currentColor" opacity=".55" d="M7 8.2c.6-2.4 2.3-4.2 4.6-4.2 1.4 0 2.4.7 3 1.6.5-.4 1.1-.6 1.8-.6 1.4 0 2.6 1.3 2.6 3.2z"/></svg>';
  const bin = () => (aero && aero.platform === 'win32' ? 'Recycle Bin' : 'Trash');

  function apply() {
    if (!tileEl) return;
    const full = state.count > 0;
    tileEl.querySelector('.ticon').innerHTML = full ? FULL : EMPTY;
    tileEl.classList.toggle('trash-full', full);
    tileEl.title = `${bin()}${full ? ` - ${state.count} item${state.count === 1 ? '' : 's'}` : state.count === 0 ? ' - empty' : ''}\nClick to open, right-click to empty, drop files to delete`;
  }

  function renderTile(barEl) {
    if (!state.supported) { tileEl = null; return; }
    tileEl = document.createElement('button');
    tileEl.className = 'dock-tile trash-tile';
    tileEl.type = 'button';
    tileEl.innerHTML = '<div class="dock-ico ticon"></div>';
    tileEl.addEventListener('click', (e) => { e.stopPropagation(); aero.trashOpen(); });
    tileEl.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); aero.trashMenu(); });
    const t = tileEl;
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    t.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; t.classList.add('drop'); } });
    t.addEventListener('dragleave', () => t.classList.remove('drop'));
    t.addEventListener('drop', async (e) => {
      t.classList.remove('drop');
      if (!hasFiles(e)) return;
      e.preventDefault();
      const paths = [...(e.dataTransfer.files || [])].map((f) => aero.pathForFile(f)).filter(Boolean);
      if (paths.length) await aero.trashPut(paths);
    });
    apply();
    barEl.appendChild(tileEl);
  }

  function setState(s) {
    const was = state.supported;
    state = s || { supported: false };
    if (tileEl && !state.supported) { tileEl.remove(); tileEl = null; }
    if (!was && state.supported && window.AeroTasks && AeroTasks.refresh) AeroTasks.refresh(true);
    apply();
  }

  function init(opts) {
    aero = opts.aero;
    if (!aero.trashState) return;
    aero.onTrashUpdate((s) => setState({ supported: true, ...(s || {}) }));
    aero.trashState().then(setState).catch(() => {});
  }

  window.AeroTrash = { init, renderTile, setState };
})();
