// Settings > Devices: turn device connections on, show this device's ID,
// pair (show a code here, or enter another device's code), and manage each
// paired device's permissions.
(function () {
  let aero = null;
  let state = null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PERMS = [
    ['files', 'Browse files', 'See the folders you share with it (only the File Pool until you share more)'],
    ['pool', 'File Pool', 'Sync the File Pool folder'],
    ['state', 'Synced state', 'Notes, theme, pins, conversations, tasks and web widgets'],
    ['aiBus', 'AI requests', 'Its assistant can send this one tasks, requests and questions'],
    ['notify', 'Notifications', 'Send notifications here'],
    ['clipboard', 'Clipboard', 'Send things to this clipboard']
  ];
  let codeTimer = null;

  function ago(ts) {
    if (!ts) return 'never';
    const d = Math.max(0, Date.now() - ts);
    if (d < 60000) return 'just now';
    if (d < 3600000) return `${Math.floor(d / 60000)} min ago`;
    if (d < 86400000) return `${Math.floor(d / 3600000)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function render() {
    if (!state) return;
    $('set-dev-enabled').checked = !!state.enabled;
    $('dev-port').textContent = state.port || 41801;
    if (document.activeElement !== $('set-dev-name')) $('set-dev-name').value = state.name || '';
    $('dev-id').textContent = state.id || '(created when you turn this on)';
    $('dev-key-hint').textContent = state.id ? (state.keyProtected
      ? 'This device\'s key is encrypted by your OS account.'
      : 'No OS keyring is available, so this device\'s key is stored as a private file instead of encrypted.') : '';
    const err = $('dev-error');
    err.classList.toggle('hidden', !state.error);
    err.textContent = state.error || '';
    $('dev-live').classList.toggle('hidden', !state.running);

    // pairing code
    const codeEl = $('dev-code');
    clearInterval(codeTimer);
    if (state.pairing) {
      const tick = () => {
        const left = Math.max(0, Math.round((state.pairing.expires - Date.now()) / 1000));
        codeEl.textContent = `${state.pairing.code.slice(0, 3)} ${state.pairing.code.slice(3)}  ·  ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        if (!left) { clearInterval(codeTimer); codeEl.classList.add('hidden'); $('btn-dev-code').textContent = 'Show pairing code'; }
      };
      codeEl.classList.remove('hidden');
      $('btn-dev-code').textContent = 'Stop pairing';
      tick();
      codeTimer = setInterval(tick, 1000);
    } else {
      codeEl.classList.add('hidden');
      $('btn-dev-code').textContent = 'Show pairing code';
    }

    // nearby (unpaired) devices found on the LAN
    const near = $('dev-nearby');
    near.innerHTML = (state.nearby || []).length
      ? `<span class="hint-text">Found nearby:</span> ${state.nearby.map((n, i) => `<button class="btn" data-i="${i}" title="${esc(n.id)}">${esc(n.name || n.address)} (${esc(n.address)})</button>`).join('')}`
      : '';
    near.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => {
      const n = state.nearby[Number(b.dataset.i)];
      $('dev-pair-addr').value = n.port && n.port !== 41801 ? `${n.address}:${n.port}` : n.address;
      $('dev-pair-code').focus();
    }));

    // paired devices
    const list = $('dev-list');
    const peers = state.peers || [];
    list.innerHTML = peers.length ? '' : '<div class="hint-text">No devices paired yet.</div>';
    for (const p of peers) {
      const item = document.createElement('div');
      item.className = 'dev-item';
      item.innerHTML = `
        <div class="dev-item-head"><span class="dev-dot${p.online ? ' on' : ''}" title="${p.online ? 'Connected' : 'Not connected'}"></span>
          <span class="dev-item-name" title="${esc(p.id)}">${esc(p.label || p.name)}</span>
          <button class="btn dev-ping" title="Check the connection">Ping</button>
          <button class="btn dev-remove" title="Unpair this device">Remove</button></div>
        <div class="dev-item-sub">${p.online ? 'Connected' : `Last seen ${ago(p.lastSeen)}`} · ${esc((p.id || '').split('-').slice(0, 2).join('-'))}… ${p.addresses && p.addresses[0] ? `· ${esc(p.addresses[0])}` : ''} <span class="dev-ping-out"></span></div>
        <div class="dev-perms">${PERMS.map(([k, label, tip]) => `<label title="${esc(tip)}"><input type="checkbox" data-perm="${k}"${p.perms && p.perms[k] ? ' checked' : ''}> ${label}</label>`).join('')}</div>`;
      item.querySelectorAll('input[data-perm]').forEach((c) => c.addEventListener('change', () => aero.devicesPerms(p.id, { [c.dataset.perm]: c.checked })));
      item.querySelector('.dev-ping').addEventListener('click', async () => {
        const out = item.querySelector('.dev-ping-out');
        out.textContent = '· pinging…';
        const r = await aero.devicesPing(p.id);
        out.textContent = r && r.ok ? `· ${r.ms} ms` : `· ${r && r.error || 'no answer'}`;
      });
      const rm = item.querySelector('.dev-remove');
      rm.addEventListener('click', () => {
        if (!rm.classList.contains('confirm')) {
          rm.classList.add('confirm'); rm.textContent = 'Click to unpair';
          setTimeout(() => { rm.classList.remove('confirm'); rm.textContent = 'Remove'; }, 3000);
          return;
        }
        aero.devicesRemove(p.id);
      });
      list.appendChild(item);
    }
  }

  async function refresh() { state = await aero.devicesState(); render(); }

  function init(opts) {
    aero = opts.aero;
    if (!aero.devicesState || !$('set-dev-enabled')) return;
    aero.onDevicesChanged((s) => { state = s; render(); });
    $('set-dev-enabled').addEventListener('change', async (e) => { state = await aero.devicesEnable(e.target.checked); render(); });
    $('set-dev-name').addEventListener('change', async (e) => { state = await aero.devicesRenameThis(e.target.value); render(); });
    $('btn-dev-copy').addEventListener('click', () => aero.devicesCopyId());
    $('btn-dev-code').addEventListener('click', async () => {
      if (state && state.pairing) await aero.devicesClosePairing(); else await aero.devicesOpenPairing();
      refresh();
    });
    $('btn-dev-pair').addEventListener('click', async () => {
      const status = $('dev-pair-status');
      const btn = $('btn-dev-pair');
      btn.disabled = true;
      status.textContent = 'Connecting…';
      const r = await aero.devicesPairWith($('dev-pair-addr').value, $('dev-pair-code').value);
      btn.disabled = false;
      status.textContent = r && r.ok ? `Paired with ${r.name}.` : (r && r.error) || 'Pairing failed.';
      if (r && r.ok) { $('dev-pair-code').value = ''; }
      refresh();
    });
    refresh();
  }

  window.AeroDevices = { init, refresh };
})();
