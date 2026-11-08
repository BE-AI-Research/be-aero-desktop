// App panes: widget panes driven by other applications over the local API.
//
// Anything arriving here came off a socket, so none of it is trusted. Panes are
// a fixed, structured shape - title, lines, metrics, a progress bar - which the
// renderer draws with textContent. No HTML crosses this boundary, so a program
// pushing a status update can never inject markup into the sidebar.
const MAX_PANES = 24;
const MAX_PANES_PER_OWNER = 8;
const MAX_LINES = 12;
const MAX_METRICS = 8;
const MAX_ACTIONS = 4;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

// Normalise whatever an app sent into the pane shape the renderer expects.
// Returns { error } rather than throwing, so a bad request is a 400 not a crash.
function sanitizePane(id, body) {
  if (!ID_RE.test(String(id || ''))) {
    return { error: 'pane id must be 1-64 chars of letters, digits, dot, dash or underscore' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be a JSON object' };
  }

  const lines = Array.isArray(body.lines)
    ? body.lines.slice(0, MAX_LINES).map((l) => str(String(l ?? ''), 200)).filter(Boolean)
    : [];
  if (!lines.length && typeof body.text === 'string') {
    for (const l of body.text.split('\n').slice(0, MAX_LINES)) lines.push(l.slice(0, 200));
  }

  const metrics = Array.isArray(body.metrics)
    ? body.metrics.slice(0, MAX_METRICS).map((m) => {
      if (!m || typeof m !== 'object') return null;
      const percent = num(m.percent, 0, 100);
      return {
        label: str(String(m.label ?? ''), 40),
        value: str(String(m.value ?? ''), 40),
        percent: percent === null ? null : percent,
        color: COLOR_RE.test(m.color || '') ? m.color : null
      };
    }).filter(Boolean)
    : [];

  const actions = Array.isArray(body.actions)
    ? body.actions.slice(0, MAX_ACTIONS).map((a) => {
      if (!a || typeof a !== 'object') return null;
      const label = str(String(a.label ?? ''), 24);
      // Only http(s) links can be handed to the browser; anything else could
      // launch a local program through a protocol handler.
      const url = typeof a.url === 'string' && /^https?:\/\//i.test(a.url) ? a.url.slice(0, 2000) : null;
      if (!label || !url) return null;
      return { label, url };
    }).filter(Boolean)
    : [];

  const progress = num(body.progress, 0, 100);

  return {
    pane: {
      id: String(id),
      title: str(body.title, 60) || String(id),
      subtitle: str(body.subtitle, 80),
      lines,
      metrics,
      actions,
      progress: progress === null ? null : progress,
      accent: COLOR_RE.test(body.accent || '') ? body.accent : null,
      icon: str(body.icon, 8),
      ownerId: null,    // set by the registry from the authenticated app
      ownerName: '',
      updatedAt: null   // stamped by the caller, which owns the clock
    }
  };
}

// In-memory registry. Panes are deliberately not persisted: they describe the
// live state of another program, so a stale pane after a restart would lie.
class PaneRegistry {
  constructor({ max = MAX_PANES, perOwner = MAX_PANES_PER_OWNER, onChange = () => {} } = {}) {
    this.max = max;
    this.perOwner = perOwner;
    this.onChange = onChange;
    this.panes = new Map();
  }

  // Panes are stored under "<ownerId>:<paneId>" so two apps can both own a
  // pane called "status" without colliding, and so no app can address, read
  // or delete a pane belonging to another.
  key(ownerId, id) {
    return `${ownerId || 'local'}:${id}`;
  }

  // Every pane, for the renderer. Owner-scoped reads use listFor().
  list() {
    return [...this.panes.values()];
  }

  listFor(ownerId) {
    return this.list().filter((p) => p.ownerId === ownerId);
  }

  get(ownerId, id) {
    return this.panes.get(this.key(ownerId, id)) || null;
  }

  // Per-owner cap as well as a global one: one chatty app must not be able to
  // crowd every other app out of the sidebar.
  countFor(ownerId) {
    return this.listFor(ownerId).length;
  }

  set(id, body, now, owner) {
    const { pane, error } = sanitizePane(id, body);
    if (error) return { error };
    const ownerId = (owner && owner.id) || 'local';
    const key = this.key(ownerId, pane.id);
    if (!this.panes.has(key)) {
      if (this.panes.size >= this.max) return { error: `too many panes (limit ${this.max})` };
      if (this.countFor(ownerId) >= this.perOwner) {
        return { error: `too many panes for this app (limit ${this.perOwner})` };
      }
    }
    pane.ownerId = ownerId;
    pane.ownerName = (owner && owner.name) || '';
    pane.updatedAt = now;
    this.panes.set(key, pane);
    this.onChange(this.list());
    return { pane };
  }

  delete(ownerId, id) {
    const existed = this.panes.delete(this.key(ownerId, id));
    if (existed) this.onChange(this.list());
    return existed;
  }

  // Remove everything one owner put up - used by DELETE /panes and when the
  // user revokes an app.
  clearOwner(ownerId) {
    let removed = 0;
    for (const [key, pane] of [...this.panes]) {
      if (pane.ownerId === ownerId) { this.panes.delete(key); removed++; }
    }
    if (removed) this.onChange(this.list());
    return removed;
  }

  clear() {
    if (!this.panes.size) return;
    this.panes.clear();
    this.onChange(this.list());
  }
}

module.exports = { PaneRegistry, sanitizePane, MAX_PANES, MAX_PANES_PER_OWNER };
