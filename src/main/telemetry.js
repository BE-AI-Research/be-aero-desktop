// Real system telemetry from the OS (no native dependencies):
// CPU (total + per core), RAM, disk usage and network throughput.
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

function cpuTimes() {
  let idle = 0;
  let total = 0;
  const cores = [];
  for (const cpu of os.cpus()) {
    let t = 0;
    for (const v of Object.values(cpu.times)) t += v;
    cores.push({ idle: cpu.times.idle, total: t });
    total += t;
    idle += cpu.times.idle;
  }
  return { idle, total, cores };
}

const pct = (v) => Math.max(0, Math.min(100, v));
let last = cpuTimes();

// Parse `netstat -e` output: the "Bytes" row holds received and sent totals.
function parseNetstat(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*Bytes\s+(\d+)\s+(\d+)/i);
    if (m) return { rx: Number(m[1]), tx: Number(m[2]) };
  }
  return null;
}

// Parse /proc/net/dev (Linux): per-interface counters; the loopback device
// is left out so local traffic does not look like network use.
function parseProcNetDev(text) {
  let rx = 0;
  let tx = 0;
  let any = false;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([^\s:]+):\s*(.*)$/);
    if (!m || m[1] === 'lo') continue;
    const cols = m[2].trim().split(/\s+/).map(Number);
    if (cols.length < 9 || cols.some((n) => Number.isNaN(n))) continue;
    rx += cols[0];
    tx += cols[8];
    any = true;
  }
  return any ? { rx, tx } : null;
}

// Network rate is sampled asynchronously; sample() reports the latest value.
const net = { last: null, rxRate: 0, txRate: 0, peak: 1, busy: false };
function ingestCounters(now) {
  if (!now) return;
  const t = Date.now();
  if (net.last) {
    const dt = Math.max(0.2, (t - net.last.t) / 1000);
    net.rxRate = Math.max(0, (now.rx - net.last.rx) / dt);
    net.txRate = Math.max(0, (now.tx - net.last.tx) / dt);
    // Decaying peak gives the gauge a sensible scale for this connection.
    net.peak = Math.max(net.rxRate + net.txRate, net.peak * 0.98, 64 * 1024);
  }
  net.last = { ...now, t };
}
function pollNetwork() {
  if (net.busy) return;
  if (process.platform === 'linux') {
    net.busy = true;
    fs.readFile('/proc/net/dev', 'utf8', (err, text) => {
      net.busy = false;
      if (!err) ingestCounters(parseProcNetDev(text));
    });
    return;
  }
  if (process.platform !== 'win32') return;
  net.busy = true;
  execFile('netstat', ['-e'], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
    net.busy = false;
    if (!err) ingestCounters(parseNetstat(stdout));
  });
}

// Disk usage of one volume. Windows takes a drive letter ("C:"); elsewhere
// an absolute mount point, with "/" standing in for a Windows-style default.
function diskUsage(drive) {
  try {
    let root;
    let label;
    if (process.platform === 'win32') {
      root = /^[a-z]:?$/i.test(drive || '') ? `${drive[0]}:\\` : (drive || 'C:\\');
      label = root.slice(0, 2).toUpperCase();
    } else {
      root = typeof drive === 'string' && drive.startsWith('/') ? drive : '/';
      label = root;
    }
    const st = fs.statfsSync(root);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    if (!total) return null;
    return { drive: label, percent: pct(((total - free) / total) * 100),
      usedGB: (total - free) / 1024 ** 3, totalGB: total / 1024 ** 3 };
  } catch {
    return null;
  }
}

function sample(opts = {}) {
  const now = cpuTimes();
  const idleDelta = now.idle - last.idle;
  const totalDelta = now.total - last.total;
  const perCore = now.cores.map((c, i) => {
    const p = last.cores[i];
    const td = p ? c.total - p.total : 0;
    return td > 0 ? Math.round(pct((1 - (c.idle - p.idle) / td) * 100)) : 0;
  });
  last = now;
  const cpu = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const out = {
    cpu: pct(cpu),
    ram: pct(((totalMem - freeMem) / totalMem) * 100),
    usedMemGB: (totalMem - freeMem) / 1024 ** 3,
    totalMemGB: totalMem / 1024 ** 3,
    cores: perCore.length,
    perCore,
    cpuModel: (os.cpus()[0] || {}).model || '',
    uptime: os.uptime()
  };
  if (opts.disk) out.disk = diskUsage(opts.drive);
  if (opts.net) {
    pollNetwork();
    out.net = { rx: net.rxRate, tx: net.txRate, percent: pct(((net.rxRate + net.txRate) / net.peak) * 100) };
  }
  return out;
}

module.exports = { sample, parseNetstat, parseProcNetDev, diskUsage };
