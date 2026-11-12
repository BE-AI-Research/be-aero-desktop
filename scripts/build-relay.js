// Packs the BE-Aero Relay Server into release/: a folder with relay.js, its
// store, the mesh files it shares with the app (lib/), install scripts,
// Dockerfile and README - as a .tar.gz (Linux, Docker) and a .zip (Windows).
//   node scripts/build-relay.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const name = `be-aero-relay-${version}`;
const out = path.join(root, 'release', name);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'lib'), { recursive: true });
for (const f of ['relay.js', 'store.js', 'drive.js', 'README.md', 'Dockerfile', 'install-linux.sh', 'install-windows.ps1']) {
  let text = fs.readFileSync(path.join(root, 'relay', f), 'utf8');
  if (f === 'relay.js') text = text.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
  // LF for the shell script and Dockerfile, whatever git checked out.
  if (/\.(sh|js)$|Dockerfile/.test(f)) text = text.replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(out, f), text);
}
for (const f of ['mesh.js', 'identity.js']) {
  fs.writeFileSync(path.join(out, 'lib', f), fs.readFileSync(path.join(root, 'src', 'main', 'mesh', f), 'utf8').replace(/\r\n/g, '\n'));
}
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'be-aero-relay', version, description: 'BE-Aero Relay Server', main: 'relay.js', bin: { 'be-aero-relay': 'relay.js' }, engines: { node: '>=18' }, license: 'UNLICENSED' }, null, 2));
fs.chmodSync(path.join(out, 'relay.js'), 0o755);
fs.chmodSync(path.join(out, 'install-linux.sh'), 0o755);

// The packed relay must run on its own: load it from the output folder.
execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(out, 'relay.js'))})`], { stdio: 'inherit' });

const rel = path.join(root, 'release');
const tgz = `${name}.tar.gz`;
const zip = `${name}.zip`;
fs.rmSync(path.join(rel, tgz), { force: true });
fs.rmSync(path.join(rel, zip), { force: true });
execFileSync('tar', ['-czf', tgz, name], { cwd: rel });
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${name}' -DestinationPath '${zip}' -Force`], { cwd: rel });
} else {
  try { execFileSync('zip', ['-qr', zip, name], { cwd: rel }); } catch { console.log('zip not available; skipped the .zip'); }
}
console.log(`built release/${tgz}${fs.existsSync(path.join(rel, zip)) ? ` and release/${zip}` : ''}`);
