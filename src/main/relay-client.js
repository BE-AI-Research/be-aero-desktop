// The device side of the BE-Aero Relay Server.
//
// A relay is paired like a device (Settings > Devices, pair by address) and
// says role "relay" in its hello. When one of my devices is offline but
// paired with a relay that is online, messages for it go to the relay,
// sealed end to end (mesh/seal.js) - the relay cannot read them. When a
// relay tells me mail is waiting (relay.mail), or on connect, I fetch it,
// check each item came from one of MY paired devices with the permission
// it needs, open it and hand it to the right part of the app.
const { EventEmitter } = require('events');
const { seal, open } = require('./mesh/seal');
const { deviceIdFromCert } = require('./mesh/identity');

const INFO_MS = 60 * 1000;
// What each kind needs from my side's permissions for the sending device.
const KIND_PERM = { state: 'state', bus: 'aiBus', clipboard: 'clipboard', widget: 'state', notify: 'notify' };

class RelayClient extends EventEmitter {
  // { handlers: { kind: async (data, from, key) }, log }
  constructor({ handlers = {}, log = () => {} }) {
    super();
    this.handlers = handlers;
    this.log = log;
    this.mesh = null;
    this.info = new Map();         // relayId -> { at, peers: Map(id -> { online, cert, name }) , waiting, store }
    this.fetching = new Map();
    this.timer = null;
  }

  attach(mesh) {
    this.mesh = mesh;
    mesh.handle('relay.mail', null, async (_a, from) => {
      if (this.isRelay(from.id)) setImmediate(() => this.fetch(from.id));
      return { ok: true };
    });
    mesh.on('online', (id) => setTimeout(() => { if (this.isRelay(id)) { this.refresh(id).then(() => this.fetch(id)).catch(() => {}); } }, 800));
    clearInterval(this.timer);
    this.timer = setInterval(() => { for (const r of this.onlineRelays()) this.refresh(r.id).catch(() => {}); }, INFO_MS);
    for (const r of this.onlineRelays()) this.refresh(r.id).then(() => this.fetch(r.id)).catch(() => {});
  }

  stop() { clearInterval(this.timer); this.timer = null; this.mesh = null; }

  isRelay(id) { const p = this.mesh && this.mesh.peers.get(id); return !!(p && p.role === 'relay'); }
  relays() { return this.mesh ? [...this.mesh.peers.values()].filter((p) => p.role === 'relay') : []; }
  onlineRelays() { return this.relays().filter((p) => this.mesh.conns.has(p.id)); }

  async refresh(relayId) {
    const r = await this.mesh.request(relayId, 'relay.info', {}, 10000);
    const peers = new Map();
    for (const p of r.peers || []) {
      // A certificate from the relay only counts if it hashes to that ID.
      let cert = null;
      try { if (p.cert && deviceIdFromCert(Buffer.from(p.cert, 'base64')) === p.id) cert = p.cert; } catch { cert = null; }
      peers.set(p.id, { online: !!p.online, cert, name: p.name, lastSeen: p.lastSeen });
    }
    this.info.set(relayId, { at: Date.now(), peers, waiting: r.waiting || 0, store: r.store || null, version: r.version });
    this.emit('change');
    return this.info.get(relayId);
  }

  // A relay that is online and has this device paired.
  relayFor(peerId) {
    for (const r of this.onlineRelays()) {
      const inf = this.info.get(r.id);
      if (inf && inf.peers.has(peerId)) return r.id;
    }
    return null;
  }

  // Not directly reachable now, but a relay can take messages for it.
  reachable(peerId) { return !!(this.mesh && !this.mesh.conns.has(peerId) && this.relayFor(peerId)); }

  certOf(peerId) {
    const p = this.mesh && this.mesh.peers.get(peerId);
    if (p && p.cert) return p.cert;
    for (const inf of this.info.values()) { const x = inf.peers.get(peerId); if (x && x.cert) return x.cert; }
    return null;
  }

  async send(peerId, kind, key, data) {
    const relayId = this.relayFor(peerId);
    if (!relayId) throw new Error('no relay can reach that device now');
    const cert = this.certOf(peerId);
    if (!cert) throw new Error('that device\'s key is not known yet (it must connect once)');
    const me = this.mesh.identity;
    const env = seal({ from: me.id, to: peerId, kind, key: key || '' }, data, { senderKeyPem: me.keyPem, recipientCert: cert });
    await this.mesh.request(relayId, 'relay.put', { to: peerId, kind, key: key || '', data: env.toString('base64') }, 60000);
    return { relayed: true, via: relayId };
  }

  // Fetch and handle everything waiting on one relay.
  fetch(relayId) {
    if (this.fetching.has(relayId)) return this.fetching.get(relayId);
    const p = this.fetchNow(relayId).catch((err) => this.log(`relay fetch: ${err.message}`)).finally(() => this.fetching.delete(relayId));
    this.fetching.set(relayId, p);
    return p;
  }

  async fetchNow(relayId) {
    if (!this.mesh || !this.mesh.conns.has(relayId)) return;
    const { items } = await this.mesh.request(relayId, 'relay.list', {}, 15000);
    const done = [];
    for (const it of items || []) {
      try {
        const got = await this.mesh.request(relayId, 'relay.get', { id: it.id }, 60000);
        await this.handle(got);
      } catch (err) { this.log(`relay item ${it.kind} from ${String(it.from).slice(0, 7)} dropped: ${err.message}`); }
      done.push(it.id);                // handled or refused: either way, not again
    }
    if (done.length) await this.mesh.request(relayId, 'relay.ack', { ids: done }, 15000).catch(() => {});
    if (done.length) this.emit('change');
  }

  async handle(item) {
    const from = this.mesh.peers.get(item.from);
    // Only my own paired devices, never the relay or a stranger paired with it.
    if (!from || from.role === 'relay') throw new Error('not from one of this device\'s paired devices');
    const perm = KIND_PERM[item.kind];
    if (!perm) throw new Error(`unknown kind ${item.kind}`);
    if (!(from.perms && from.perms[perm])) throw new Error(`that device has no "${perm}" permission here`);
    const cert = this.certOf(item.from);
    if (!cert) throw new Error('sender key unknown');
    const me = this.mesh.identity;
    const { header, data } = open(Buffer.from(item.data, 'base64'), { recipientKeyPem: me.keyPem, recipientId: me.id, senderCert: cert, expectFrom: item.from });
    if (header.kind !== item.kind) throw new Error('kind mismatch');
    const h = this.handlers[item.kind];
    if (!h) throw new Error(`nothing handles ${item.kind}`);
    await h(data, { id: item.from, name: from.label || from.name }, header.key, item.at);
  }

  status() {
    return this.relays().map((r) => {
      const inf = this.info.get(r.id);
      return {
        id: r.id, name: r.label || r.name, online: !!(this.mesh && this.mesh.conns.has(r.id)),
        waiting: inf ? inf.waiting : null, store: inf ? inf.store : null, version: inf ? inf.version : null,
        devices: inf ? [...inf.peers.entries()].filter(([id]) => id !== (this.mesh && this.mesh.identity.id)).map(([id, x]) => ({ id, name: x.name, online: x.online })) : []
      };
    });
  }
}

module.exports = { RelayClient, KIND_PERM };
