// A file browser in its own window (files.html): the theme follows the
// desktop's, and it opens on the folder it was asked for.
(async function () {
  'use strict';
  const aero = window.aero;
  const apply = (s) => {
    for (const [k, v] of Object.entries((s && s.themeVars) || {})) document.documentElement.style.setProperty(k, v);
  };
  try { apply(await aero.getSettings()); } catch { /* defaults */ }
  if (aero.onSettingsChanged) aero.onSettingsChanged(apply);
  const start = new URLSearchParams(location.search).get('path') || '';
  await AeroFiles.init({ aero, window: true, start });
  const list = document.querySelector('.files-list');
  if (list) list.focus();
})();
