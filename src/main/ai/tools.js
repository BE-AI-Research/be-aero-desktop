// The assistant's hands: every tool the model can call against the desktop.
// Each tool declares a category that the permission model keys on:
//   read    - observe (always allowed)
//   control - change state, operate widgets, drive web frames, launch apps
// Executors receive a context object assembled by the AI service; nothing
// here touches Electron directly, which keeps the registry unit-testable.

function obj(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });

// Settings the model may change. Anything not listed (API tokens, keys,
// certificate trust, plugin grants, the AI's own configuration) is off limits.
const SETTABLE = new Set(['theme', 'dock', 'widgets', 'weather', 'use24h', 'locked', 'alwaysOnTop',
  'clock', 'telemetry', 'opacity', 'width', 'search', 'webWidgets', 'scratchpad']);

function clip(value, max = 20000) {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return s.length > max ? s.slice(0, max) + `\n... (${s.length - max} more characters)` : s;
}

function sanitizeSettings(s) {
  const out = { ...s };
  delete out.api; delete out.certTrust; delete out.ai;
  if (out.plugins) out.plugins = { enabled: out.plugins.enabled };
  if (out.search) out.search = { ...out.search, launchCounts: undefined };
  delete out.themeVars; delete out.displays; delete out.homeRect;
  return out;
}

const TOOLS = [
  // ---------------------------------------------------------------- read
  {
    name: 'list_widgets', category: 'read',
    description: 'List the desktop widgets (built-in, plugin and web widgets), whether each is enabled, and the current layout mode.',
    input_schema: obj({}),
    run: async (_in, ctx) => {
      const s = ctx.settings();
      return {
        layout: s.dock, locked: !!s.locked,
        builtIn: Object.entries(s.widgets || {}).map(([id, on]) => ({ id, enabled: on !== false })),
        webWidgets: (s.webWidgets || []).map((w) => ({ id: w.id, name: w.name, url: w.url, minimized: !!w.minimized })),
        plugins: ctx.plugins().map((p) => ({ id: p.id, name: p.name }))
      };
    }
  },
  {
    name: 'get_settings', category: 'read',
    description: 'Read the current settings (theme, clock, weather, telemetry, dock, layout...). Secrets are never included.',
    input_schema: obj({ section: str('Optional top-level section to return, e.g. "theme" or "weather". Omit for everything.') }),
    run: async (input, ctx) => {
      const s = sanitizeSettings(ctx.settings());
      return input.section ? { [input.section]: s[input.section] } : s;
    }
  },
  {
    name: 'read_scratchpad', category: 'read',
    description: 'Read the text in the Scratchpad notes widget.',
    input_schema: obj({}),
    run: async (_in, ctx) => ({ text: ctx.settings().scratchpad || '' })
  },
  {
    name: 'read_telemetry', category: 'read',
    description: 'Current system telemetry: CPU, memory, disk, network, battery.',
    input_schema: obj({}),
    run: async (_in, ctx) => ctx.telemetry()
  },
  {
    name: 'search', category: 'read',
    description: 'Search the desktop index (installed apps, files, folders, settings pages) the way the Aero Search launcher does. Returns matching items with the exact "path" to pass to launch().',
    input_schema: obj({ query: str('What to search for'), limit: num('Max results (default 12)') }, ['query']),
    run: async (input, ctx) => {
      const r = ctx.search(input.query) || {};
      const flat = [];
      for (const g of r.groups || []) for (const it of g.items || []) flat.push({ name: it.name, path: it.path, kind: it.kind, category: g.category || it.category });
      if (!flat.length && Array.isArray(r.results)) for (const it of r.results) flat.push({ name: it.name, path: it.path, kind: it.kind, category: it.category });
      return { results: flat.slice(0, Math.max(1, Math.min(50, input.limit || 12))), calc: r.calc || null };
    }
  },
  {
    name: 'list_running_apps', category: 'read',
    description: 'Applications currently running (what the dock shows), with the ids needed to focus or close them.',
    input_schema: obj({}),
    run: async (_in, ctx) => {
      const list = await ctx.tasks.list();
      const byApp = new Map();
      for (const w of list) {
        const key = (w.exe || '').toLowerCase();
        if (!byApp.has(key)) byApp.set(key, { app: w.appName || w.title, exe: w.exe, windows: [] });
        byApp.get(key).windows.push({ id: w.hwnd, pid: w.pid, title: w.title });
      }
      return { apps: [...byApp.values()] };
    }
  },
  {
    name: 'web_search', category: 'read',
    description: 'Search the web and get results (title, url, snippet) without opening a browser. Follow up with fetch_url to read a result.',
    input_schema: obj({ query: str('Search query'), count: num('Number of results (default 8, max 20)') }, ['query']),
    run: async (input, ctx) => ctx.webSearch(input.query, input.count || 8)
  },
  {
    name: 'fetch_url', category: 'read',
    description: 'Fetch a web page or text/JSON resource and return its readable text (no browser needed).',
    input_schema: obj({ url: str('http(s) URL') }, ['url']),
    run: async (input, ctx) => ctx.fetchPage(input.url)
  },
  {
    name: 'web_elements', category: 'read',
    description: 'List the interactive elements (links, buttons, inputs, selects) in a web widget page with CSS selectors you can pass to web_click / web_type / web_select.',
    input_schema: obj({ id: str('Web widget id') }, ['id']),
    run: async (input, ctx) => ctx.webOp(input.id, 'elements', {})
  },
  {
    name: 'web_find', category: 'read',
    description: 'Find elements in a web widget page whose visible text contains a phrase.',
    input_schema: obj({ id: str('Web widget id'), query: str('Text to look for') }, ['id', 'query']),
    run: async (input, ctx) => ctx.webOp(input.id, 'find', { query: input.query })
  },
  {
    name: 'clipboard_read', category: 'read',
    description: 'Read the text currently on the clipboard.',
    input_schema: obj({}),
    run: async (_in, ctx) => ({ text: ctx.clipboard.read() })
  },
  {
    name: 'web_read', category: 'read',
    description: 'Read the page currently loaded in a web widget: title, URL and visible text.',
    input_schema: obj({ id: str('Web widget id from list_widgets') }, ['id']),
    run: async (input, ctx) => ctx.webOp(input.id, 'read', {})
  },
  // ------------------------------------------------------------- control
  {
    name: 'set_settings', category: 'control',
    description: 'Change settings. Pass a partial object that is merged in, e.g. {"theme":{"preset":"midnight"}}, {"weather":{"city":"Berlin"}}, {"dock":"left"}, {"use24h":true}, {"locked":true}. Allowed sections: theme, dock, widgets, weather, use24h, locked, alwaysOnTop, clock, telemetry, opacity, width, search, webWidgets, scratchpad.',
    input_schema: obj({ patch: { type: 'object', description: 'Partial settings object to merge' } }, ['patch']),
    run: async (input, ctx) => {
      const patch = {};
      const refused = [];
      for (const [k, v] of Object.entries(input.patch || {})) {
        if (SETTABLE.has(k)) patch[k] = v; else refused.push(k);
      }
      if (!Object.keys(patch).length) return { ok: false, error: `nothing to apply; refused sections: ${refused.join(', ') || 'none'}` };
      ctx.updateSettings(patch);
      return { ok: true, applied: Object.keys(patch), ...(refused.length ? { refused } : {}) };
    }
  },
  {
    name: 'set_widget_enabled', category: 'control',
    description: 'Show or hide a built-in widget: search, clock, weather, telemetry, tasks (the dock), scratchpad, ai.',
    input_schema: obj({ widget: str('Widget id'), enabled: bool('true to show, false to hide') }, ['widget', 'enabled']),
    run: async (input, ctx) => {
      if (!(input.widget in (ctx.settings().widgets || {}))) return { ok: false, error: `unknown widget ${input.widget}` };
      ctx.updateSettings({ widgets: { [input.widget]: !!input.enabled } });
      return { ok: true };
    }
  },
  {
    name: 'write_scratchpad', category: 'control',
    description: 'Write to the Scratchpad notes widget.',
    input_schema: obj({ text: str('Text to write'), mode: { type: 'string', enum: ['replace', 'append'], description: 'replace the note or append to it (default append)' } }, ['text']),
    run: async (input, ctx) => {
      const cur = ctx.settings().scratchpad || '';
      const next = input.mode === 'replace' ? input.text : (cur ? cur.replace(/\s*$/, '\n') : '') + input.text;
      ctx.updateSettings({ scratchpad: next });
      return { ok: true, length: next.length };
    }
  },
  {
    name: 'launch', category: 'control',
    description: 'Open an item found with search(): an application, file, folder or settings page. Pass its exact "path".',
    input_schema: obj({ path: str('The item path exactly as returned by search()') }, ['path']),
    run: async (input, ctx) => { await ctx.launch(input.path); return { ok: true }; }
  },
  {
    name: 'open_url', category: 'control',
    description: 'Open a web address in the default browser.',
    input_schema: obj({ url: str('http(s) URL') }, ['url']),
    run: async (input, ctx) => {
      if (!/^https?:\/\//i.test(input.url)) return { ok: false, error: 'only http(s) URLs' };
      await ctx.openExternal(input.url);
      return { ok: true };
    }
  },
  {
    name: 'focus_app', category: 'control',
    description: 'Bring a running application window to the front (id from list_running_apps).',
    input_schema: obj({ id: num('Window id') }, ['id']),
    run: async (input, ctx) => ({ ok: !!(await ctx.tasks.action('focus', input.id)) })
  },
  {
    name: 'close_app', category: 'control',
    description: 'Ask a running application window to close (id from list_running_apps).',
    input_schema: obj({ id: num('Window id') }, ['id']),
    run: async (input, ctx) => ({ ok: !!(await ctx.tasks.action('close', input.id)) })
  },
  {
    name: 'create_web_widget', category: 'control',
    description: 'Create a new web widget showing a web page on the desktop.',
    input_schema: obj({ url: str('http(s) URL'), name: str('Short name for the widget') }, ['url']),
    run: async (input, ctx) => {
      if (!/^https?:\/\//i.test(input.url)) return { ok: false, error: 'only http(s) URLs' };
      const id = ctx.createWebWidget(input.url, input.name);
      return { ok: true, id };
    }
  },
  {
    name: 'remove_web_widget', category: 'control',
    description: 'Remove a web widget.',
    input_schema: obj({ id: str('Web widget id') }, ['id']),
    run: async (input, ctx) => {
      const list = (ctx.settings().webWidgets || []).filter((w) => w.id !== input.id);
      ctx.updateSettings({ webWidgets: list });
      return { ok: true };
    }
  },
  {
    name: 'web_navigate', category: 'control',
    description: 'Navigate a web widget to a URL and wait for it to load.',
    input_schema: obj({ id: str('Web widget id'), url: str('http(s) URL') }, ['id', 'url']),
    run: async (input, ctx) => ctx.webOp(input.id, 'navigate', { url: input.url })
  },
  {
    name: 'web_click', category: 'control',
    description: 'Click an element in a web widget, by CSS selector or by its visible text.',
    input_schema: obj({ id: str('Web widget id'), selector: str('CSS selector'), text: str('Visible text of the element (used when selector is omitted)') }, ['id']),
    run: async (input, ctx) => ctx.webOp(input.id, 'click', { selector: input.selector, text: input.text })
  },
  {
    name: 'web_type', category: 'control',
    description: 'Type into an input in a web widget (CSS selector), optionally pressing Enter afterwards.',
    input_schema: obj({ id: str('Web widget id'), selector: str('CSS selector of the input'), text: str('Text to type'), submit: bool('Press Enter afterwards') }, ['id', 'selector', 'text']),
    run: async (input, ctx) => ctx.webOp(input.id, 'type', { selector: input.selector, text: input.text, submit: !!input.submit })
  },
  {
    name: 'web_scroll', category: 'control',
    description: 'Scroll a web widget page by a number of pixels (negative = up).',
    input_schema: obj({ id: str('Web widget id'), dy: num('Pixels to scroll vertically') }, ['id', 'dy']),
    run: async (input, ctx) => ctx.webOp(input.id, 'scroll', { dy: input.dy })
  },
  {
    name: 'web_eval', category: 'control',
    description: 'Run JavaScript inside a web widget page and return its result (for anything the other web_* tools cannot express).',
    input_schema: obj({ id: str('Web widget id'), code: str('JavaScript expression or statements') }, ['id', 'code']),
    run: async (input, ctx) => ctx.webOp(input.id, 'eval', { code: input.code })
  },
  {
    name: 'open_web_search', category: 'control',
    description: "Open a web search for a query in the user's default browser with their chosen search engine (use when the user wants to see results themselves; use web_search to read results yourself).",
    input_schema: obj({ query: str('Search query') }, ['query']),
    run: async (input, ctx) => { await ctx.openWebSearch(input.query); return { ok: true }; }
  },
  {
    name: 'clipboard_write', category: 'control',
    description: 'Put text on the clipboard.',
    input_schema: obj({ text: str('Text to copy') }, ['text']),
    run: async (input, ctx) => { ctx.clipboard.write(input.text); return { ok: true }; }
  },
  {
    name: 'minimize_app', category: 'control',
    description: 'Minimize a running application window (id from list_running_apps).',
    input_schema: obj({ id: num('Window id') }, ['id']),
    run: async (input, ctx) => ({ ok: !!(await ctx.tasks.action('minimize', input.id)) })
  },
  {
    name: 'maximize_app', category: 'control',
    description: 'Maximize a running application window (id from list_running_apps).',
    input_schema: obj({ id: num('Window id') }, ['id']),
    run: async (input, ctx) => ({ ok: !!(await ctx.tasks.action('maximize', input.id)) })
  },
  {
    name: 'restore_app', category: 'control',
    description: 'Restore a minimized or maximized application window to normal (id from list_running_apps).',
    input_schema: obj({ id: num('Window id') }, ['id']),
    run: async (input, ctx) => ({ ok: !!(await ctx.tasks.action('restore', input.id)) })
  },
  {
    name: 'send_keys', category: 'control',
    description: 'Send keyboard input to the application that currently has focus (focus_app first). "text" types literal text; "keys" sends key combinations - on Windows in SendKeys syntax, e.g. "^s" (Ctrl+S), "%{F4}" (Alt+F4), "{ENTER}", "{TAB}"; on Linux as xdotool key names, e.g. "ctrl+s", "Return".',
    input_schema: obj({ text: str('Literal text to type'), keys: str('Key combination(s) to press after the text') }),
    run: async (input, ctx) => {
      if (!input.text && !input.keys) return { ok: false, error: 'give text and/or keys' };
      return ctx.sendKeys({ text: input.text || '', keys: input.keys || '' });
    }
  },
  {
    name: 'run_command', category: 'control',
    description: 'Launch a program or open a file/URL/folder the way the Run dialog (Win+R) does - fire and forget, no output captured. Example: "notepad", "calc", "explorer C:\\Users".',
    input_schema: obj({ command: str('Command line to run') }, ['command']),
    run: async (input, ctx) => ({ ok: !!ctx.runCommand(input.command) })
  },
  {
    name: 'exec_capture', category: 'control',
    description: 'Run a shell command and return its output (stdout/stderr/exit code). For command-line work: listing files, git, ipconfig, package managers... Times out after timeoutSec (default 20).',
    input_schema: obj({ command: str('Shell command'), timeoutSec: num('Timeout in seconds (max 120)') }, ['command']),
    run: async (input, ctx) => ctx.execCapture(input.command, Math.min(120, Math.max(1, input.timeoutSec || 20)))
  },
  {
    name: 'web_select', category: 'control',
    description: 'Choose an option in a <select> inside a web widget page.',
    input_schema: obj({ id: str('Web widget id'), selector: str('CSS selector of the select'), value: str('Option value or visible label') }, ['id', 'selector', 'value']),
    run: async (input, ctx) => ctx.webOp(input.id, 'select', { selector: input.selector, value: input.value })
  },
  {
    name: 'web_hover', category: 'control',
    description: 'Hover over an element in a web widget page (opens hover menus).',
    input_schema: obj({ id: str('Web widget id'), selector: str('CSS selector') }, ['id', 'selector']),
    run: async (input, ctx) => ctx.webOp(input.id, 'hover', { selector: input.selector })
  },
  {
    name: 'web_submit', category: 'control',
    description: 'Submit a form in a web widget page (the form containing the selector, or the first form).',
    input_schema: obj({ id: str('Web widget id'), selector: str('CSS selector of the form or an element inside it') }, ['id']),
    run: async (input, ctx) => ctx.webOp(input.id, 'submit', { selector: input.selector })
  },
  {
    name: 'web_back', category: 'control',
    description: 'Go back one page in a web widget.',
    input_schema: obj({ id: str('Web widget id') }, ['id']),
    run: async (input, ctx) => ctx.webOp(input.id, 'back', {})
  },
  {
    name: 'web_forward', category: 'control',
    description: 'Go forward one page in a web widget.',
    input_schema: obj({ id: str('Web widget id') }, ['id']),
    run: async (input, ctx) => ctx.webOp(input.id, 'forward', {})
  },
  {
    name: 'web_reload', category: 'control',
    description: 'Reload the page in a web widget.',
    input_schema: obj({ id: str('Web widget id') }, ['id']),
    run: async (input, ctx) => ctx.webOp(input.id, 'reload', {})
  },
  {
    name: 'web_wait', category: 'control',
    description: 'Wait for an element to appear in a web widget page (selector), or just wait some milliseconds.',
    input_schema: obj({ id: str('Web widget id'), selector: str('CSS selector to wait for'), ms: num('Milliseconds (default 10000, max 30000)') }, ['id']),
    run: async (input, ctx) => ctx.webOp(input.id, 'wait', { selector: input.selector, ms: input.ms })
  },
  {
    name: 'list_tasks', category: 'read',
    description: 'List the scheduled tasks (recurring or one-off prompts that run automatically).',
    input_schema: obj({}),
    run: async (_in, ctx) => ({ tasks: ctx.tasks.list() })
  },
  {
    name: 'schedule_task', category: 'control',
    description: 'Create or update a scheduled task: a prompt the assistant runs automatically. schedule.type is once (at: ISO date-time), interval (every: minutes), daily (time: HH:MM) or weekly (time: HH:MM, days: [0-6], 0=Sunday). Pass id to update an existing task.',
    input_schema: obj({
      id: str('Existing task id (to update)'),
      name: str('Short task name'),
      prompt: str('What to do on each run, written as an instruction to yourself'),
      schedule: { type: 'object', description: '{ type, at?, every?, time?, days? }' },
      permission: { type: 'string', enum: ['inherit', 'allow', 'deny'], description: 'What the run may change while the user is away (default inherit)' },
      conversationMode: { type: 'string', enum: ['shared', 'new'], description: 'shared: one running conversation; new: fresh each run' }
    }, ['name', 'prompt', 'schedule']),
    run: async (input, ctx) => {
      const t = ctx.tasks.add({ id: input.id, name: input.name, prompt: input.prompt, schedule: input.schedule, permission: input.permission, conversationMode: input.conversationMode });
      return { ok: true, id: t.id, name: t.name };
    }
  },
  {
    name: 'delete_task', category: 'control',
    description: 'Delete a scheduled task by id (see list_tasks).',
    input_schema: obj({ id: str('Task id') }, ['id']),
    run: async (input, ctx) => { ctx.tasks.remove(input.id); return { ok: true }; }
  },
  {
    name: 'read_file', category: 'control',
    description: 'Read a text file from disk (code, notes, CSV, JSON, logs...). For images or PDFs ask the user to attach them to a message instead.',
    input_schema: obj({ path: str('Absolute file path'), maxChars: num('Maximum characters to return (default 60000)') }, ['path']),
    run: async (input, ctx) => ctx.files.read(input.path, input.maxChars || 60000)
  },
  {
    name: 'list_directory', category: 'control',
    description: 'List the files and folders in a directory with sizes and modification times.',
    input_schema: obj({ path: str('Absolute directory path') }, ['path']),
    run: async (input, ctx) => ctx.files.list(input.path)
  },
  {
    name: 'notify', category: 'control',
    description: 'Show a desktop notification.',
    input_schema: obj({ title: str('Title'), body: str('Body text') }, ['title']),
    run: async (input, ctx) => { ctx.notify(input.title, input.body || ''); return { ok: true }; }
  },
  {
    name: 'reindex_search', category: 'control',
    description: 'Rebuild the search index (after installing new apps, for example).',
    input_schema: obj({}),
    run: async (_in, ctx) => { await ctx.reindex(); return { ok: true }; }
  }
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

function definitions() {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

function categoryOf(name) {
  const t = byName.get(name);
  return t ? t.category : null;
}

// Light schema check: required keys present, declared types respected.
function validateInput(name, input) {
  const t = byName.get(name);
  if (!t) return `unknown tool ${name}`;
  if (!input || typeof input !== 'object') return 'input must be an object';
  for (const k of t.input_schema.required || []) {
    if (!(k in input)) return `missing required field "${k}"`;
  }
  for (const [k, v] of Object.entries(input)) {
    const p = t.input_schema.properties[k];
    if (!p) return `unexpected field "${k}"`;
    if (p.type === 'string' && typeof v !== 'string') return `"${k}" must be a string`;
    if (p.type === 'number' && typeof v !== 'number') return `"${k}" must be a number`;
    if (p.type === 'boolean' && typeof v !== 'boolean') return `"${k}" must be a boolean`;
    if (p.type === 'object' && (!v || typeof v !== 'object' || Array.isArray(v))) return `"${k}" must be an object`;
    if (p.type === 'array' && !Array.isArray(v)) return `"${k}" must be an array`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}`;
  }
  return null;
}

async function execute(name, input, ctx) {
  const t = byName.get(name);
  if (!t) throw new Error(`unknown tool ${name}`);
  return t.run(input || {}, ctx);
}

module.exports = { TOOLS, definitions, categoryOf, validateInput, execute, clip, sanitizeSettings, SETTABLE };
