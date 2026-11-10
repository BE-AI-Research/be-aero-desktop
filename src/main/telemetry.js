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

// CPU use is measured between two readings of the OS counters. Many callers
// ask for a sample (the telemetry timer, plugins, the app API, the
// assistant), so a reading is only taken once MIN_CPU_WINDOW_MS has passed
// since the last one; quicker callers get the latest result. Otherwise an
// extra call just before the timer leaves it a window of a few ms, and on
// Linux, whose per-core counters move in 10 ms ticks, most cores then read
// 0% and the rest jump to 100%.
const MIN_CPU_WINDOW_MS = 750;
let lastAt = Date.now();
let cpuResult = { cpu: 0, perCore: last.cores.map(() => 0) };

function cpuUsage(prev, now) {
  // A changed core count (CPUs taken offline or brought back) would pair the
  // wrong cores by position: start a new window instead.
  if (prev.cores.length !== now.cores.length) return null;
  const totalDelta = now.total - prev.total;
  if (totalDelta <= 0) return null;
  const perCore = now.cores.map((c, i) => {
    const p = prev.cores[i];
    const td = c.total - p.total;
    return td > 0 ? Math.round(pct((1 - (c.idle - p.idle) / td) * 100)) : 0;
  });
  return { cpu: pct((1 - (now.idle - prev.idle) / totalDelta) * 100), perCore };
}

function sample(opts = {}) {
  const t = Date.now();
  if (t - lastAt >= MIN_CPU_WINDOW_MS || cpuResult.perCore.length === 0) {
    const now = cpuTimes();
    const r = cpuUsage(last, now);
    if (r) cpuResult = r;
    else if (now.cores.length !== cpuResult.perCore.length) cpuResult = { cpu: cpuResult.cpu, perCore: now.cores.map(() => 0) };
    last = now;
    lastAt = t;
  }
  const { cpu, perCore } = cpuResult;

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

module.exports = { sample, cpuUsage, parseNetstat, parseProcNetDev, diskUsage };
