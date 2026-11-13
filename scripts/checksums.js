// SHA256SUMS.txt for a release: the Linux updater (install-linux.sh's
// be-aero-desktop-update helper) installs only what this file vouches for.
//   node scripts/checksums.js            -> release/SHA256SUMS.txt for this version's assets
// Upload it with the release (and install-linux.sh, which it covers too).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const rel = path.join(root, 'release');
const wanted = [
  `be-aero-desktop-${version}.tar.gz`,
  `BE-Aero Desktop Setup ${version}.exe`,
  `BE-Aero Desktop ${version}.exe`
];
const lines = [];
for (const name of wanted) {
  const p = path.join(rel, name);
  if (!fs.existsSync(p)) { console.warn(`(skipped, not built: ${name})`); continue; }
  const sum = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  // Release asset names use dashes where the build has spaces.
  lines.push(`${sum}  ${name.replace(/ /g, '-')}`);
}
const installer = path.join(root, 'scripts', 'install-linux.sh');
// The published installer has Unix line endings: hash it that way.
const sh = Buffer.from(fs.readFileSync(installer, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
fs.writeFileSync(path.join(rel, 'install-linux.sh'), sh);
lines.push(`${crypto.createHash('sha256').update(sh).digest('hex')}  install-linux.sh`);
fs.writeFileSync(path.join(rel, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
console.log(`release/SHA256SUMS.txt (${lines.length} files) and release/install-linux.sh (LF) written`);
