// UAC shield: a dock tile beside the bell (Windows). Grey when nothing is
// happening; amber while an elevation prompt is open; pulsing when Windows
// is holding a prompt back (click to show it); red when UAC is set to never
// notify or turned off. Click opens the menu (status, show the waiting
// prompt, prompt level). The menu itself is native, built in main.
(function () {
  let aero = null;
  let state = { supported: false };
  let tileEl = null;

  const SHIELD = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 8v5M12 16v.5"/></svg>';

  function title() {
    if (state.busy) return 'UAC: waiting for you to approve the level change';
    if (state.waiting) return 'A UAC prompt is waiting - click to show it';
    if (state.open) return 'A UAC prompt is open';
    return `UAC: ${state.levelLabel || 'unknown'} - click for options`;
  }

  function apply() {
    if (!tileEl) return;
    tileEl.classList.toggle('uac-open', !!state.open);
    tileEl.classList.toggle('uac-waiting', !!state.waiting);
    tileEl.classList.toggle('uac-busy', !!state.busy);
    tileEl.classList.toggle('uac-weak', state.level === 'never' || state.level === 'off');
    tileEl.title = title();
  }

  function renderTile(barEl) {
    if (!state.supported) { tileEl = null; return; }
    tileEl = document.createElement('button');
    tileEl.className = 'dock-tile uac-tile';
    tileEl.type = 'button';
    tileEl.innerHTML = `<div class="dock-ico ticon">${SHIELD}</div>`;
    tileEl.addEventListener('click', (e) => { e.stopPropagation(); aero.uacMenu(); });
    tileEl.addEventListener('contextmenu', (e) => { e.preventDefault(); aero.uacMenu(); });
    apply();
    barEl.appendChild(tileEl);
  }

  function setState(s) {
    const wasSupported = state.supported;
    state = s || { supported: false };
    // Turned on or off in Settings: the dock is redrawn on its next refresh;
    // until then hide or keep the tile we have.
    if (tileEl && !state.supported) { tileEl.remove(); tileEl = null; }
    if (!wasSupported && state.supported && window.AeroTasks && AeroTasks.refresh) AeroTasks.refresh();
    apply();
  }

  function init(opts) {
    aero = opts.aero;
    if (!aero.uacState) return;
    aero.onUacUpdate((s) => setState({ supported: true, ...(s || {}) }));
    aero.uacState().then(setState).catch(() => {});
  }

  window.AeroUac = { init, renderTile, setState };
})();
