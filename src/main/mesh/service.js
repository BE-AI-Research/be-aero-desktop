// Devices: the Electron side of the mesh - the encrypted identity, the peers
// file, the approval dialogs, the IPC the Settings > Devices section uses,
// and turning the whole thing on and off.
//
// Off by default: turning it on opens a network port (Windows asks once
// whether to let BE-Aero through its firewall).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, ipcMain, dialog, safeStorage, clipboard } = require('electron');
const { loadIdentity, normalizeId } = require('./identity');
const { Mesh, DEFAULT_PORT } = require('./mesh');

// Electron safeStorage as the identity's protect hook. On Linux without a
// keyring Electron falls back to 'basic_text' (obfuscation, not
// encryption) - that does not count as protected.
function safeStorageProtect() {
  return {
    available: () => {
      try {
        if (!safeStorage.isEncryptionAvailable()) return false;
        if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
          && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
        return true;
      } catch { return false; }
    },
    encrypt: (text) => safeStorage.encryptString(String(text)),
    decrypt: (buf) => safeStorage.decryptString(buf)
  };
}

class DeviceService {
  // { userDataDir, store, getWindow, log, onStart(mesh), onStop() }
  constructor({ userDataDir, store, getWindow, log = (m) => console.log('[devices]', m), onStart = () => {}, onStop = () => {} }) {
    this.onStart = onStart;
    this.onStop = onStop;
    this.dir = path.join(userDataDir, 'mesh');
    this.store = store;
    this.getWindow = getWindow;
    this.log = log;
    this.mesh = null;
    this.identity = null;
    this.error = '';
    this.peersFile = path.join(this.dir, 'peers.json');
  }

  settings() { return this.store.get('devices') || {}; }

  deviceName() { return String(this.settings().name || os.hostname()).slice(0, 60); }

  loadPeers() {
    try { const l = JSON.parse(fs.readFileSync(this.peersFile, 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; }
  }

  savePeers(list) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.peersFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, this.peersFile);
    } catch (err) { this.log(`could not save devices: ${err.message}`); }
  }

  ensureIdentity() {
    if (this.identity) return this.identity;
    this.identity = loadIdentity(this.dir, { name: this.deviceName(), protect: safeStorageProtect() });
    if (!this.identity.protected) this.log('the OS keyring is not available: the device key is stored as a private file, not encrypted');
    return this.identity;
  }

  async start() {
    if (this.mesh) return true;
    this.error = '';
    try {
      const identity = this.ensureIdentity();
      identity.name = this.deviceName();
      this.mesh = new Mesh({
        identity,
        peers: { load: () => this.loadPeers(), save: (l) => this.savePeers(l) },
        approvePairing: (req) => this.approve(req),
        port: Number(this.settings().port) || DEFAULT_PORT,
        log: this.log
      });
      this.mesh.on('change', () => this.broadcast());
      await this.mesh.start();
      this.log(`listening on port ${this.mesh.port} as ${identity.id}`);
      try { this.onStart(this.mesh); } catch (err) { this.log(`start hook: ${err.message}`); }
    } catch (err) {
      this.error = err && err.code === 'EADDRINUSE'
        ? `Port ${this.settings().port || DEFAULT_PORT} is in use by another program.`
        : String(err && err.message || err);
      if (this.mesh) { try { this.mesh.stop(); } catch { /* */ } }
      this.mesh = null;
      this.log(`could not start: ${this.error}`);
    }
    this.broadcast();
    return !!this.mesh;
  }

  stop() {
    if (this.mesh) { try { this.onStop(); } catch { /* */ } this.mesh.stop(); this.mesh = null; }
    this.broadcast();
  }

  state() {
    let id = '';
    let keyProtected = false;
    try { const i = this.ensureIdentity(); id = i.id; keyProtected = i.protected; } catch (err) { this.error = String(err.message || err); }
    const base = { enabled: !!this.settings().enabled, running: !!this.mesh, error: this.error, id, name: this.deviceName(), keyProtected };
    if (!this.mesh) return { ...base, port: Number(this.settings().port) || DEFAULT_PORT, peers: this.loadPeers().map((p) => ({ ...p, online: false })), nearby: [], pairing: null };
    return { ...base, ...this.mesh.state(), enabled: true };
  }

  broadcast() {
    const w = this.getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('devices:changed', this.state());
  }

  // The showing side: approve the device that typed our code.
  async approve({ id, name, address }) {
    // Automated end-to-end tests only: a source checkout (never a packaged
    // build) with the variable set approves without the dialog.
    if (!app.isPackaged && process.env.AERO_TEST_AUTO_APPROVE === '1') return true;
    const w = this.getWindow();
    const r = await dialog.showMessageBox(w && !w.isDestroyed() ? w : undefined, {
      type: 'question',
      buttons: ['Pair', 'Decline'],
      defaultId: 1,
      cancelId: 1,
      title: 'Pair a device',
      message: `Pair with "${name}"?`,
      detail: `It entered this device's pairing code from ${String(address || '').replace(/^::ffff:/, '')}.\n\nDevice ID:\n${id}\n\nOnly approve a device you are setting up right now. It will be able to reach this device for the things you allow in Settings > Devices.`
    });
    return r.response === 0;
  }

  registerIpc() {
    ipcMain.handle('devices:state', () => this.state());
    ipcMain.handle('devices:enable', async (_e, on) => {
      this.store.set({ devices: { enabled: !!on } });
      if (on) await this.start(); else this.stop();
      return this.state();
    });
    ipcMain.handle('devices:rename-this', (_e, name) => {
      const n = String(name || '').trim().slice(0, 60);
      this.store.set({ devices: { name: n } });
      if (this.identity) this.identity.name = n || os.hostname();
      this.broadcast();
      return this.state();
    });
    ipcMain.handle('devices:open-pairing', () => (this.mesh ? this.mesh.openPairing() : null));
    ipcMain.handle('devices:close-pairing', () => { if (this.mesh) this.mesh.closePairing(); return true; });
    ipcMain.handle('devices:pair-with', async (_e, address, code) => {
      if (!this.mesh) return { error: 'Turn on device connections first.' };
      const m = /^\s*\[?([^\]\s]+?)\]?(?::(\d+))?\s*$/.exec(String(address || ''));
      if (!m) return { error: 'Enter the other device\'s address, for example 192.168.1.20' };
      const host = m[1];
      const port = Number(m[2]) || DEFAULT_PORT;
      try {
        const res = await this.mesh.pairWith(host, port, String(code || '').replace(/\D/g, ''), async ({ id, name }) => {
          if (!app.isPackaged && process.env.AERO_TEST_AUTO_APPROVE === '1') return true;   // tests only, never packaged
          const w = this.getWindow();
          const r = await dialog.showMessageBox(w && !w.isDestroyed() ? w : undefined, {
            type: 'question', buttons: ['Pair', 'Cancel'], defaultId: 0, cancelId: 1, title: 'Pair a device',
            message: `Pair with "${name}"?`,
            detail: `Check this ID matches the one shown on "${name}" (Settings > Devices):\n\n${id}`
          });
          return r.response === 0;
        });
        return { ok: true, ...res };
      } catch (err) {
        const msg = String(err && err.message || err);
        return { error: /ECONNREFUSED/.test(msg) ? 'Nothing answered at that address. Is BE-Aero running there with device connections on?' : /timed out|ETIMEDOUT|EHOSTUNREACH/.test(msg) ? 'That address did not answer.' : msg };
      }
    });
    ipcMain.handle('devices:remove', (_e, id) => (this.mesh ? this.mesh.removePeer(String(id)) : (this.savePeers(this.loadPeers().filter((p) => p.id !== id)), this.broadcast(), true)));
    ipcMain.handle('devices:set-address', (_e, id, address) => {
      if (!this.mesh) return { error: 'Turn on device connections first.' };
      const m = /^\s*\[?([^\]\s]+?)\]?(?::(\d+))?\s*$/.exec(String(address || ''));
      if (!m || !/^[A-Za-z0-9.:-]+$/.test(m[1])) return { error: 'Enter an address like 192.168.1.49 or 192.168.1.49:41811' };
      return this.mesh.setAddress(String(id), m[1], m[2] ? Number(m[2]) : 0) ? { ok: true } : { error: 'No such device.' };
    });
    ipcMain.handle('devices:perms', (_e, id, perms) => (this.mesh ? this.mesh.setPerms(String(id), perms || {}) : false));
    ipcMain.handle('devices:ping', async (_e, id) => {
      if (!this.mesh) return { error: 'device connections are off' };
      const t = Date.now();
      try { await this.mesh.request(String(id), 'ping', {}, 8000); return { ok: true, ms: Date.now() - t }; } catch (err) { return { error: String(err.message || err) }; }
    });
    ipcMain.handle('devices:share-add', async (_e, id) => {
      if (!this.mesh) return { error: 'Turn on device connections first.' };
      const peer = this.mesh.peers.get(String(id));
      if (!peer) return { error: 'No such device.' };
      const w = this.getWindow();
      const r = await dialog.showOpenDialog(w && !w.isDestroyed() ? w : undefined, { title: `Share a folder with ${peer.label || peer.name}`, properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return { cancelled: true };
      const shares = (peer.shares || []).filter((s) => s.path !== r.filePaths[0]);
      shares.push({ path: r.filePaths[0], name: require('path').basename(r.filePaths[0]) || r.filePaths[0] });
      this.mesh.setShares(peer.id, shares);
      return { ok: true };
    });
    ipcMain.handle('devices:share-remove', (_e, id, p) => {
      if (!this.mesh) return false;
      const peer = this.mesh.peers.get(String(id));
      if (!peer) return false;
      return this.mesh.setShares(peer.id, (peer.shares || []).filter((s) => s.path !== p));
    });
    ipcMain.handle('devices:copy-id', () => { try { clipboard.writeText(this.ensureIdentity().id); return true; } catch { return false; } });
    ipcMain.handle('devices:normalize-id', (_e, id) => normalizeId(id));
  }
}

module.exports = { DeviceService, safeStorageProtect };
