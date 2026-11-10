// Linux engines we download (Piper, Whisper) load their bundled libraries
// by soname (libfoo.so.1) with RUNPATH $ORIGIN, and their archives provide
// those names only as symlinks. If a link is missing or broken, the loader
// either fails ("cannot open shared object file") or silently picks the
// distribution's own, incompatible copy. Make every soname a real copy of
// the versioned library next to it. Returns the names it created.
const fs = require('fs');
const path = require('path');

function repairSonames(dir, platform = process.platform) {
  if (platform !== 'linux') return [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const fixed = [];
  for (const n of names) {
    // libggml-base.so.0.26.0 -> libggml-base.so.0 and libggml-base.so
    const m = /^(lib[\w+.-]*?\.so)\.(\d+)\.[\d.]+$/.exec(n);
    if (!m) continue;
    const real = path.join(dir, n);
    try { if (!fs.lstatSync(real).isFile()) continue; } catch { continue; }
    for (const alias of [`${m[1]}.${m[2]}`, m[1]]) {
      const dest = path.join(dir, alias);
      if (fs.existsSync(dest)) continue;          // follows links: a broken link counts as missing
      try { fs.rmSync(dest, { force: true }); fs.copyFileSync(real, dest); fixed.push(alias); } catch { /* read-only dir */ }
    }
  }
  return fixed;
}

module.exports = { repairSonames };
