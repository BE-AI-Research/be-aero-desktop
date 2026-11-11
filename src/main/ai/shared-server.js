// Shared inference servers: devices that use the same local server (an
// Ollama box on the LAN) coordinate over the mesh instead of swapping models
// under each other.
//
// Presence: every paired device that allows "AI requests" tells the others
// which server + model its chat and tasks use, and when its assistant starts
// and finishes a turn (ai.status on connect, ai.activity on each turn).
//
// 1. Follow the loaded model: before a turn, when my model is not loaded on
//    the server but another one is, and a paired device uses THAT model on
//    the SAME server, use it for this turn - no swap. Only models my own
//    devices use are candidates, never an arbitrary loaded model.
// 2. Do not evict each other: a model a paired device is using (a turn in
//    progress, or one within the last few minutes) is not unloaded to make
//    room; we wait for it instead.
const IN_USE_MS = 5 * 60 * 1000;

// "http://192.168.1.150:11434/v1" -> "192.168.1.150:11434" (scheme, path and
// case ignored), so two devices' URLs for one server compare equal.
function serverKey(baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''));
    return `${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch { return ''; }
}

const sameModel = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// Pure decision for (1): which loaded model to use instead of `wanted`.
// peers: [{ name, models: [{ server, model }], active: { server, model, at } | null }]
function chooseModel({ server, wanted, loaded = [], peers = [] }) {
  if (!server || !wanted || !loaded.length) return null;
  if (loaded.some((m) => sameModel(m, wanted))) return null;            // ours is loaded: nothing to do
  for (const p of peers) {
    const uses = [...(p.models || []), ...(p.active ? [p.active] : [])];
    for (const u of uses) {
      if (u.server !== server) continue;
      const hit = loaded.find((m) => sameModel(m, u.model));
      if (hit) return { model: hit, device: p.name };
    }
  }
  return null;
}

// Pure decision for (2): which of `models` (loaded on `server`) a paired
// device is using now or was using within IN_USE_MS.
function inUseBy({ server, models = [], peers = [], now = Date.now() }) {
  const out = [];
  for (const p of peers) {
    const a = p.active;
    if (!a || a.server !== server) continue;
    if (!(a.running || now - (a.at || 0) < IN_USE_MS)) continue;
    for (const m of models) if (sameModel(m, a.model)) out.push({ model: m, device: p.name, running: !!a.running });
  }
  return out;
}

class SharedServers {
  // { local() -> { models: [{ server, model }] }, log }
  constructor({ local, log = () => {} }) {
    this.local = local;
    this.log = log;
    this.peers = new Map();     // peerId -> { name, models, active }
    this.mesh = null;
  }

  attach(mesh) {
    this.mesh = mesh;
    mesh.handle('ai.status', 'aiBus', async () => ({ models: this.local().models }));
    mesh.handle('ai.activity', 'aiBus', async (a, from) => {
      const p = this.peers.get(from.id) || { name: from.name, models: [] };
      p.name = from.name;
      if (Array.isArray(a.models)) p.models = a.models.filter((m) => m && m.server && m.model).slice(0, 8);
      if (a.active && a.active.server && a.active.model) p.active = { server: String(a.active.server), model: String(a.active.model), running: !!a.active.running, at: Date.now() };
      this.peers.set(from.id, p);
      return { ok: true };
    });
    mesh.on('online', (id) => this.refresh(id));
    for (const id of mesh.conns.keys()) this.refresh(id);
  }

  async refresh(peerId) {
    if (!this.mesh) return;
    const peer = this.mesh.peers.get(peerId);
    if (!peer || !(peer.perms && peer.perms.aiBus)) return;
    try {
      const r = await this.mesh.request(peerId, 'ai.status', {}, 8000);
      const p = this.peers.get(peerId) || { active: null };
      this.peers.set(peerId, { ...p, name: peer.label || peer.name, models: (r.models || []).filter((m) => m && m.server && m.model) });
    } catch { /* that device does not share AI status with us */ }
  }

  // Tell the other devices a turn started (running) or ended on server/model.
  announce(server, model, running) {
    if (!this.mesh || !server || !model) return;
    const msg = { models: this.local().models, active: { server, model, running } };
    for (const id of this.mesh.conns.keys()) {
      const p = this.mesh.peers.get(id);
      if (p && p.perms && p.perms.aiBus) this.mesh.request(id, 'ai.activity', msg, 8000).catch(() => {});
    }
  }

  list() {
    const online = this.mesh ? new Set(this.mesh.conns.keys()) : new Set();
    return [...this.peers.entries()].filter(([id]) => online.has(id)).map(([, p]) => p);
  }

  choose(server, wanted, loaded) { return chooseModel({ server, wanted, loaded, peers: this.list() }); }
  inUse(server, models) { return inUseBy({ server, models, peers: this.list() }); }
}

module.exports = { SharedServers, chooseModel, inUseBy, serverKey, IN_USE_MS };
