// Local-model backend awareness, after BE-Code (internal/agent/resilience.go
// and provider/ollama_model.go). A local server is shared and fallible:
// another client can evict our model, reload it with a different context
// window, or keep it busy; idle expiry unloads it. So, around every call:
//   - status(): is the model resident, and with which window? (Ollama
//     /api/ps, LM Studio /api/v0/models). An eviction is reported once; a
//     window change shrinks or grows the context budget to match, so the
//     conversation is compacted to fit instead of silently truncated.
//   - keepAlive(): after a reply, extend residency (Ollama keep_alive), so a
//     pause between messages does not cost a reload plus re-processing.
//   - watchStall(): a backend that sends nothing for a while is reported
//     as waiting (loading / re-processing / queued), not left to look hung.
// Requests are short and bounded; anything unsupported is remembered and
// skipped for the rest of the session.

const STATUS_TIMEOUT_MS = 2500;
const STATUS_TTL_MS = 5000;
const STALL_FIRST_MS = 45 * 1000;
const STALL_SECOND_FACTOR = 4;        // BE-Code: second notice at 4x

// "http://host:11434/v1" -> "http://host:11434"
function nativeRoot(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
}

// Reserve for the reply and the system prompt: a quarter of the window, at
// most 4096 tokens, at least 512.
function budgetForWindow(window, configured) {
  const w = Number(window) || 0;
  if (w <= 0) return configured;
  const usable = Math.max(1024, w - Math.max(512, Math.min(4096, Math.floor(w / 4))));
  return configured > 0 ? Math.min(configured, usable) : usable;
}

async function getJson(fetchImpl, url, { method = 'GET', body, timeout = STATUS_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetchImpl(url, {
      method, signal: ac.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) return { status: res.status, json: null };
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
  } finally { clearTimeout(t); }
}

class Backend {
  // { baseUrl, fetchImpl?, apiKey? }
  constructor({ baseUrl, fetchImpl, apiKey } = {}) {
    this.root = nativeRoot(baseUrl);
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.apiKey = apiKey || '';
    this.kind = undefined;          // 'ollama' | 'lmstudio' | null (unsupported), found on first use
    this.cache = null;              // { at, model, result }
  }

  supported() { return this.kind !== null; }

  // -> { loaded: bool, window: number|0 } or null when the server cannot say.
  async status(model) {
    if (this.kind === null || !this.root || /^unix:/i.test(this.root)) return null;
    if (this.cache && this.cache.model === model && Date.now() - this.cache.at < STATUS_TTL_MS) return this.cache.result;
    let result = null;
    try {
      if (this.kind === undefined || this.kind === 'ollama') {
        const r = await getJson(this.fetch, `${this.root}/api/ps`);
        if (r.json && Array.isArray(r.json.models)) {
          this.kind = 'ollama';
          const m = r.json.models.find((x) => x.name === model || x.model === model);
          result = { loaded: !!m, window: m ? Number(m.context_length) || 0 : 0 };
        } else if (this.kind === 'ollama') {
          result = null;
        }
      }
      if (!result && (this.kind === undefined || this.kind === 'lmstudio')) {
        const r = await getJson(this.fetch, `${this.root}/api/v0/models`);
        const list = r.json && Array.isArray(r.json.data) ? r.json.data : null;
        if (list && list.some((x) => x && 'state' in x)) {
          this.kind = 'lmstudio';
          const m = list.find((x) => x.id === model);
          result = m
            ? { loaded: m.state === 'loaded', window: Number(m.loaded_context_length || (m.state === 'loaded' ? m.max_context_length : 0)) || 0 }
            : { loaded: false, window: 0 };
        }
      }
      if (this.kind === undefined) this.kind = null;      // neither: stop asking
    } catch {
      return null;                                         // unreachable: the chat call reports it
    }
    this.cache = { at: Date.now(), model, result };
    return result;
  }

  // Extend the model's residency (Ollama only). Fire and forget.
  async keepAlive(model, duration = '30m') {
    if (this.kind !== 'ollama' || !duration || duration === '0') return false;
    try {
      const r = await getJson(this.fetch, `${this.root}/api/generate`, { method: 'POST', body: { model, keep_alive: duration }, timeout: 120000 });
      this.cache = null;
      return r.status === 200;
    } catch { return false; }
  }
}

// Wrap a stream callback so silence is reported. Returns { onText, stop }.
// report(stage, idleMs): stage 1 after `first`, stage 2 after first x 4;
// report(0) when output resumes after a notice.
function watchStall(onText, report, { first = STALL_FIRST_MS, now = () => Date.now(), every } = {}) {
  let last = now();
  let stage = 0;
  const tick = every || Math.max(250, Math.floor(first / 4));
  const timer = setInterval(() => {
    const idle = now() - last;
    if (stage === 0 && idle >= first) { stage = 1; report(1, idle); }
    else if (stage === 1 && idle >= first * STALL_SECOND_FACTOR) { stage = 2; report(2, idle); }
  }, tick);
  return {
    onText: (d) => {
      last = now();
      if (stage) { stage = 0; report(0, 0); }
      if (onText) onText(d);
    },
    stop: () => clearInterval(timer)
  };
}

module.exports = { Backend, watchStall, budgetForWindow, nativeRoot, STALL_FIRST_MS, STALL_SECOND_FACTOR };
