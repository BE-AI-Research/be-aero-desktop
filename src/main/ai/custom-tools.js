// The assistant's tool workspace: tools it writes, tests and then uses.
//
// Each tool is a folder in AI Folder/AI Tools/<name>/:
//   tool.json  - { name, description, input_schema, mode, runtime }
//   index.js   - sandbox mode: defines  async function run(input, aero)
//   run.ps1 | run.sh | run.py - script mode: JSON input on stdin, result on stdout
//
// Sandbox mode (default) runs in a hidden, sandboxed Chromium page with no
// Node and no network; aero.call(tool, input) reaches the app's own tools
// through the same permission checks as the assistant (tool-sandbox.js).
// Script mode runs the interpreter with the tool's folder as its working
// folder, and only after the user approved that exact code. Approvals are
// hashes kept in the app's data, never in the AI folder (the assistant can
// write there and must not approve itself).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const NAME_RE = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_CODE = 256 * 1024;
const MAX_OUT = 256 * 1024;
const SCRIPT_TIMEOUT = 60 * 1000;
const RUNTIMES = {
  powershell: { file: 'run.ps1' },
  bash: { file: 'run.sh' },
  python: { file: 'run.py' }
};

const hashOf = (tool, code) => crypto.createHash('sha256').update(`${tool.mode}|${tool.runtime || ''}|${code}`).digest('hex');

function normSchema(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { type: 'object', properties: {}, required: [] };
  const props = s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties) ? s.properties : {};
  const required = Array.isArray(s.required) ? s.required.filter((k) => typeof k === 'string' && k in props) : [];
  return { type: 'object', properties: props, required };
}

// The interpreter for a script tool on this OS -> [command, args...].
function interpreter(runtime, file) {
  const win = process.platform === 'win32';
  if (runtime === 'powershell') return win ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file] : ['pwsh', '-NoProfile', '-NonInteractive', '-File', file];
  if (runtime === 'bash') return win ? ['bash.exe', file] : ['bash', file];
  if (runtime === 'python') return win ? ['python.exe', file] : ['python3', file];
  throw new Error(`unknown runtime ${runtime}`);
}

class CustomTools {
  // { folder: async () => AI folder, approvalsFile, approve: async (tool, code) -> bool, sandbox: (code, input, callTool, opts) -> Promise, onChange(list), log }
  constructor({ folder, approvalsFile, approve, sandbox, onChange = () => {}, log = () => {} }) {
    this.folder = folder;
    this.approvalsFile = approvalsFile;
    this.approveFn = approve;
    this.sandbox = sandbox;
    this.onChange = onChange;
    this.log = log;
    this.tools = new Map();     // name -> { name, description, input_schema, mode, runtime, dir, file, code, hash }
    try { this.approvals = JSON.parse(fs.readFileSync(approvalsFile, 'utf8')) || {}; } catch { this.approvals = {}; }
    this.watcher = null;
  }

  async root() {
    const dir = path.join(await this.folder(), 'AI Tools');
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  saveApprovals() {
    try {
      fs.mkdirSync(path.dirname(this.approvalsFile), { recursive: true });
      fs.writeFileSync(this.approvalsFile, JSON.stringify(this.approvals));
    } catch (err) { this.log(`tool approvals not saved: ${err.message}`); }
  }

  approved(t) { return t.mode !== 'script' || this.approvals[t.name] === t.hash; }

  async load() {
    const root = await this.root();
    const found = new Map();
    let dirents = [];
    try { dirents = await fsp.readdir(root, { withFileTypes: true }); } catch { /* none */ }
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(dir, 'tool.json'), 'utf8'));
        if (!meta || !NAME_RE.test(String(meta.name)) || found.has(meta.name)) continue;
        const mode = meta.mode === 'script' ? 'script' : 'sandbox';
        const runtime = mode === 'script' ? String(meta.runtime || '') : '';
        if (mode === 'script' && !RUNTIMES[runtime]) continue;
        const file = path.join(dir, mode === 'script' ? RUNTIMES[runtime].file : 'index.js');
        const code = await fsp.readFile(file, 'utf8');
        const t = { name: meta.name, description: String(meta.description || '').slice(0, 1000), input_schema: normSchema(meta.input_schema), mode, runtime, dir, file, code };
        t.hash = hashOf(t, code);
        found.set(t.name, t);
      } catch { /* not a tool folder */ }
    }
    this.tools = found;
    return this.list();
  }

  list() {
    return [...this.tools.values()].map((t) => ({
      name: t.name, description: t.description, mode: t.mode, runtime: t.runtime, folder: t.dir, file: t.file,
      approved: this.approved(t), needsApproval: t.mode === 'script' && !this.approved(t), input_schema: t.input_schema
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) { return this.tools.get(String(name)) || null; }

  // Ask the user to approve a script tool's current code (native dialog).
  async requestApproval(name) {
    const t = this.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    if (this.approved(t)) return true;
    const ok = this.approveFn ? await this.approveFn(t, t.code) : false;
    if (ok) { this.approvals[t.name] = t.hash; this.saveApprovals(); }
    this.onChange(this.list());
    return ok;
  }

  revoke(name) { delete this.approvals[String(name)]; this.saveApprovals(); this.onChange(this.list()); }

  async save({ name, description, input_schema, mode, runtime = '', code }, { create }) {
    if (!NAME_RE.test(String(name || ''))) throw new Error('name must be lowercase letters, digits and _ (2-40), starting with a letter');
    const existing = this.get(name);
    if (create && existing) throw new Error(`a tool named ${name} exists - use update_tool`);
    if (!create && !existing) throw new Error(`no tool ${name} - use create_tool`);
    const m = (mode || (existing && existing.mode)) === 'script' ? 'script' : 'sandbox';
    const rt = m === 'script' ? String(runtime || (existing && existing.runtime) || '') : '';
    if (m === 'script' && !RUNTIMES[rt]) throw new Error('script tools need runtime: powershell, bash or python');
    const body = code != null ? String(code) : existing ? existing.code : '';
    if (!body.trim()) throw new Error('code is empty');
    if (Buffer.byteLength(body) > MAX_CODE) throw new Error(`code is too large (max ${MAX_CODE / 1024} KB)`);
    if (m === 'sandbox' && !/\bfunction\s+run\s*\(|\brun\s*=\s*(async\s*)?(\(|function)/.test(body)) throw new Error('a sandbox tool must define: async function run(input, aero) { ... }');
    const root = await this.root();
    const dir = existing ? existing.dir : path.join(root, name);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, m === 'script' ? RUNTIMES[rt].file : 'index.js');
    // Switching mode or runtime: the old code file goes.
    if (existing && existing.file !== file) { try { await fsp.unlink(existing.file); } catch { /* gone */ } }
    await fsp.writeFile(file, body, 'utf8');
    const meta = {
      name, mode: m, ...(rt ? { runtime: rt } : {}),
      description: String(description != null ? description : existing ? existing.description : '').slice(0, 1000),
      input_schema: normSchema(input_schema != null ? input_schema : existing ? existing.input_schema : null)
    };
    await fsp.writeFile(path.join(dir, 'tool.json'), JSON.stringify(meta, null, 2), 'utf8');
    await this.load();
    const t = this.get(name);
    let approved = this.approved(t);
    if (!approved) approved = await this.requestApproval(name);
    this.onChange(this.list());
    return { name, mode: m, runtime: rt || undefined, folder: dir, approved };
  }

  async remove(name, trash) {
    const t = this.get(name);
    if (!t) return false;
    this.tools.delete(t.name);
    delete this.approvals[t.name];
    this.saveApprovals();
    try { if (trash) await trash(t.dir); else await fsp.rm(t.dir, { recursive: true, force: true }); } catch (err) { this.log(`tool folder not removed: ${err.message}`); }
    this.onChange(this.list());
    return true;
  }

  // ---- running
  async run(name, input, callTool) {
    const t = this.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    const started = Date.now();
    if (t.mode === 'sandbox') {
      if (!this.sandbox) throw new Error('the tool sandbox is not available');
      const r = await this.sandbox(t.code, input || {}, callTool, { timeoutMs: 30000, name: t.name });
      return { ...r, ms: Date.now() - started };
    }
    if (!this.approved(t)) throw new Error(`the script tool ${t.name} is waiting for the user's approval (Settings > AI assistant > AI tools); it cannot run until then`);
    const [cmd, ...args] = interpreter(t.runtime, t.file);
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let done = false;
      const child = spawn(cmd, args, { cwd: t.dir, windowsHide: true, env: { ...process.env, BE_AERO_TOOL: t.name } });
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ ...r, ms: Date.now() - started }); };
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false, error: `timed out after ${SCRIPT_TIMEOUT / 1000} s`, logs: err.slice(-4000) }); }, SCRIPT_TIMEOUT);
      child.stdout.on('data', (b) => { if (out.length < MAX_OUT) out += b.toString('utf8'); });
      child.stderr.on('data', (b) => { if (err.length < MAX_OUT) err += b.toString('utf8'); });
      child.on('error', (e) => finish({ ok: false, error: `could not start ${cmd}: ${e.message}` }));
      child.on('close', (code) => {
        const text = out.trim();
        let output = text;
        try { output = JSON.parse(text); } catch { /* plain text */ }
        if (code === 0) finish({ ok: true, output, logs: err.trim().slice(-4000) || undefined });
        else finish({ ok: false, error: `exited with code ${code}`, output: text.slice(0, 4000) || undefined, logs: err.trim().slice(-4000) || undefined });
      });
      try { child.stdin.end(JSON.stringify(input || {})); } catch { /* closed */ }
    });
  }

  // The saved tools as tool definitions for the assistant (tool_<name>).
  definitions(callToolFor) {
    return [...this.tools.values()].map((t) => ({
      name: `tool_${t.name}`,
      category: t.mode === 'script' ? 'control' : 'read',
      custom: true,
      description: `[Your own ${t.mode} tool${t.mode === 'script' && !this.approved(t) ? ', waiting for the user to approve it' : ''}] ${t.description}`.slice(0, 1100),
      input_schema: t.input_schema,
      run: async (input, ctx) => {
        const r = await this.run(t.name, input, callToolFor(ctx));
        if (!r.ok) return { error: r.error, ...(r.logs ? { logs: r.logs } : {}) };
        return r.output === undefined ? { ok: true } : r.output;
      }
    }));
  }

  async watch(onReload) {
    if (this.watcher) return;
    const root = await this.root();
    let t = null;
    try {
      this.watcher = fs.watch(root, { recursive: true }, () => {
        clearTimeout(t);
        t = setTimeout(() => this.load().then((l) => { this.onChange(l); if (onReload) onReload(l); }).catch(() => {}), 400);
      });
      this.watcher.on('error', () => { this.watcher = null; });
    } catch { this.watcher = null; }
  }
}

module.exports = { CustomTools, NAME_RE, normSchema, interpreter, hashOf, RUNTIMES };
