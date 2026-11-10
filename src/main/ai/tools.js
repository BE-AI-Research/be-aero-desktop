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
    name: 'media_status', category: 'read',
    description: 'What is playing on this machine right now (any media app): title, artist, album, app, playback status, position, volume when known.',
    input_schema: obj({}),
    run: async (_in, ctx) => {
      if (!ctx.media) return { error: 'media control is not available' };
      const info = await ctx.media.info();
      if (info && info.thumb) { const { thumb: _omit, ...rest } = info; return rest; }
      return info;
    }
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
      const list = await ctx.windows.list();
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
    description: 'List the interactive elements (links, buttons, inputs, selects) in a web widget page, NUMBERED. Pass an element\'s index to web_click / web_type / web_select.',
    input_schema: obj({ id: str('Web widget id, name or site') }),
    run: async (input, ctx) => ctx.webOp(input.id, 'elements', {})
  },
  {
    name: 'web_find', category: 'read',
    description: 'Find elements in a web widget page whose visible text contains a phrase.',
    input_schema: obj({ id: str('Web widget id, name or site'), query: str('Text to look for') }, ['query']),
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
    description: 'Read the page currently loaded in a web widget: title, URL and visible text. The widget can be given by id, by name, or by site (e.g. "github"); with a single web widget it can be omitted.',
    input_schema: obj({ id: str('Web widget id, name or site') }),
    run: async (input, ctx) => ctx.webOp(input.id, 'read', {})
  },
  {
    name: 'web_screenshot', category: 'read',
    description: 'Take a screenshot of a web widget page and look at it (returned as an image). Use when the text alone is confusing or layout matters.',
    input_schema: obj({ id: str('Web widget id, name or site') }),
    run: async (input, ctx) => ctx.webOp(input.id, 'screenshot', {})
  },
  // ------------------------------------------------------------- control
  {
    name: 'media_control', category: 'control',
    description: 'Control media playback on this machine: play, pause, toggle (play/pause), next, prev, stop, volup, voldown, mute. Works on whatever app is playing (Spotify, a browser, a player).',
    input_schema: obj({ action: { type: 'string', enum: ['play', 'pause', 'toggle', 'next', 'prev', 'stop', 'volup', 'voldown', 'mute'], description: 'The transport or volume action' } }, ['action']),
    run: async (input, ctx) => {
      if (!ctx.media) return { error: 'media control is not available' };
      return { ok: !!(await ctx.media.action(input.action)) };
    }
  },
  {
    name: 'speak_text', category: 'control',
    description: 'Say something out loud on the user\'s speakers with the configured text-to-speech voice (Piper or the system voice). Use when the user asks you to read something aloud or to announce a result.',
    input_schema: obj({ text: str('What to say (plain text, up to about 4000 characters)') }, ['text']),
    run: async (input, ctx) => {
      if (!ctx.speak) return { error: 'text to speech is not available' };
      return { ok: !!ctx.speak(String(input.text || '').slice(0, 4000)) };
    }
  },
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
    run: async (input, ctx) => ({ ok: !!(await ctx.windows.action('focus', input.id)) })
  },
  {
    name: 'close_app', category: 'control',
    description: 'Ask a running application window to close (id from list_running_apps).',
    input_schema: obj({ id: num('Window id') }, ['id']),
    run: async (input, ctx) => ({ ok: !!(await ctx.windows.action('close', input.id)) })
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
    name: 'web_open', category: 'control',
    description: 'Open a URL in a web widget on the desktop (reuses a widget already showing that site, otherwise creates one) and return the page text. The simplest way to start browsing inside the desktop.',
    input_schema: obj({ url: str('http(s) URL'), name: str('Name for a new widget (optional)') }, ['url']),
    run: async (input, ctx) => ctx.webOpen(input.url, input.name)
  },
  {
    name: 'web_navigate', category: 'control',
    description: 'Navigate a web widget to a URL and wait for it to load.',
    input_schema: obj({ id: str('Web widget id, name or site'), url: str('http(s) URL') }, ['url']),
    run: async (input, ctx) => ctx.webOp(input.id, 'navigate', { url: input.url })
  },
  {
    name: 'web_click', category: 'control',
    description: 'Click an element in a web widget: by index from web_elements (preferred), by CSS selector, or by visible text.',
    input_schema: obj({ id: str('Web widget id, name or site'), index: num('Element index from web_elements'), selector: str('CSS selector'), text: str('Visible text') }),
    run: async (input, ctx) => ctx.webOp(input.id, 'click', { index: input.index, selector: input.selector, text: input.text })
  },
  {
    name: 'web_type', category: 'control',
    description: 'Type into an input in a web widget - target by index from web_elements, CSS selector, or placeholder/label text. Replaces the current value unless clear is false; submit presses Enter.',
    input_schema: obj({ id: str('Web widget id, name or site'), index: num('Element index'), selector: str('CSS selector'), text: str('Text to type'), submit: bool('Press Enter afterwards'), clear: bool('Clear the field first (default true)') }, ['text']),
    run: async (input, ctx) => ctx.webOp(input.id, 'type', { index: input.index, selector: input.selector, text: input.text, submit: !!input.submit, clear: input.clear !== false })
  },
  {
    name: 'web_scroll', category: 'control',
    description: 'Scroll a web widget page by a number of pixels (negative = up).',
    input_schema: obj({ id: str('Web widget id, name or site'), dy: num('Pixels to scroll vertically') }, ['dy']),
    run: async (input, ctx) => ctx.webOp(input.id, 'scroll', { dy: input.dy })
  },
  {
    name: 'web_eval', category: 'control',
    description: 'Run JavaScript inside a web widget page and return its result (for anything the other web_* tools cannot express).',
    input_schema: obj({ id: str('Web widget id, name or site'), code: str('JavaScript expression or statements') }, ['code']),
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
    run: async (input, ctx) => ({ ok: !!(await ctx.windows.action('minimize', input.id)) })
  },
  {
    name: 'maximize_app', category: 'control',
    description: 'Maximize a running application window (id from list_running_apps).',
    input_schema: obj({ id: num('Window id') }, ['id']),
    run: async (input, ctx) => ({ ok: !!(await ctx.windows.action('maximize', input.id)) })
  },
  {
    name: 'restore_app', category: 'control',
    description: 'Restore a minimized or maximized application window to normal (id from list_running_apps).',
    input_schema: obj({ id: num('Window id') }, ['id']),
    run: async (input, ctx) => ({ ok: !!(await ctx.windows.action('restore', input.id)) })
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
    description: 'Choose an option in a <select> inside a web widget page (target by index or selector).',
    input_schema: obj({ id: str('Web widget id, name or site'), index: num('Element index'), selector: str('CSS selector of the select'), value: str('Option value or visible label') }, ['value']),
    run: async (input, ctx) => ctx.webOp(input.id, 'select', { index: input.index, selector: input.selector, value: input.value })
  },
  {
    name: 'web_hover', category: 'control',
    description: 'Hover over an element in a web widget page (opens hover menus).',
    input_schema: obj({ id: str('Web widget id, name or site'), index: num('Element index'), selector: str('CSS selector'), text: str('Visible text') }),
    run: async (input, ctx) => ctx.webOp(input.id, 'hover', { index: input.index, selector: input.selector, text: input.text })
  },
  {
    name: 'web_submit', category: 'control',
    description: 'Submit a form in a web widget page (the form containing the selector, or the first form).',
    input_schema: obj({ id: str('Web widget id, name or site'), selector: str('CSS selector of the form or an element inside it') }),
    run: async (input, ctx) => ctx.webOp(input.id, 'submit', { selector: input.selector })
  },
  {
    name: 'web_back', category: 'control',
    description: 'Go back one page in a web widget.',
    input_schema: obj({ id: str('Web widget id, name or site') }),
    run: async (input, ctx) => ctx.webOp(input.id, 'back', {})
  },
  {
    name: 'web_forward', category: 'control',
    description: 'Go forward one page in a web widget.',
    input_schema: obj({ id: str('Web widget id, name or site') }),
    run: async (input, ctx) => ctx.webOp(input.id, 'forward', {})
  },
  {
    name: 'web_reload', category: 'control',
    description: 'Reload the page in a web widget.',
    input_schema: obj({ id: str('Web widget id, name or site') }),
    run: async (input, ctx) => ctx.webOp(input.id, 'reload', {})
  },
  {
    name: 'web_wait', category: 'control',
    description: 'Wait for an element to appear in a web widget page (selector), or just wait some milliseconds.',
    input_schema: obj({ id: str('Web widget id, name or site'), selector: str('CSS selector to wait for'), ms: num('Milliseconds (default 10000, max 30000)') }),
    run: async (input, ctx) => ctx.webOp(input.id, 'wait', { selector: input.selector, ms: input.ms })
  },
  // ------------------------------------------------------- OS browser (CDP)
  {
    name: 'browser_tabs', category: 'read',
    description: "List the tabs open in the user's browser as driven by the assistant (Chrome/Edge/Brave via DevTools). Starts the browser with the BE-Aero profile if needed.",
    input_schema: obj({}),
    run: async (_in, ctx) => ctx.browser('tabs', {})
  },
  {
    name: 'browser_open', category: 'control',
    description: "Open a URL in a new tab of the user's OS browser (Chrome, Edge or Brave, driven through DevTools with a dedicated BE-Aero profile) and return the page text and tab id. The way to browse the real web for the user.",
    input_schema: obj({ url: str('http(s) URL') }, ['url']),
    run: async (input, ctx) => ctx.browser('open', { url: input.url })
  },
  {
    name: 'browser_read', category: 'read',
    description: 'Read the page in a browser tab: title, URL and visible text. tab = id (or prefix), or a word from its title/URL; omit when one tab is open.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment') }),
    run: async (input, ctx) => ctx.browser('read', { tab: input.tab })
  },
  {
    name: 'browser_elements', category: 'read',
    description: 'List the interactive elements in a browser tab, NUMBERED, for browser_click / browser_type / browser_select.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment') }),
    run: async (input, ctx) => ctx.browser('elements', { tab: input.tab })
  },
  {
    name: 'browser_find', category: 'read',
    description: 'Find elements in a browser tab whose visible text contains a phrase.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment'), query: str('Text to look for') }, ['query']),
    run: async (input, ctx) => ctx.browser('find', { tab: input.tab, query: input.query })
  },
  {
    name: 'browser_screenshot', category: 'read',
    description: 'Take a screenshot of a browser tab and look at it (returned as an image).',
    input_schema: obj({ tab: str('Tab id, or title/url fragment') }),
    run: async (input, ctx) => ctx.browser('screenshot', { tab: input.tab })
  },
  {
    name: 'browser_navigate', category: 'control',
    description: 'Navigate a browser tab to a URL and wait for it to load; returns the page text.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment'), url: str('http(s) URL') }, ['url']),
    run: async (input, ctx) => ctx.browser('navigate', { tab: input.tab, url: input.url })
  },
  {
    name: 'browser_click', category: 'control',
    description: 'Click an element in a browser tab: by index from browser_elements (preferred), CSS selector, or visible text.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment'), index: num('Element index'), selector: str('CSS selector'), text: str('Visible text') }),
    run: async (input, ctx) => ctx.browser('click', { tab: input.tab, index: input.index, selector: input.selector, text: input.text })
  },
  {
    name: 'browser_type', category: 'control',
    description: 'Type into an input in a browser tab (index, selector or placeholder/label text). Replaces the value unless clear is false; submit presses Enter.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment'), index: num('Element index'), selector: str('CSS selector'), text: str('Text to type'), submit: bool('Press Enter afterwards'), clear: bool('Clear first (default true)') }, ['text']),
    run: async (input, ctx) => ctx.browser('type', { tab: input.tab, index: input.index, selector: input.selector, text: input.text, submit: !!input.submit, clear: input.clear !== false })
  },
  {
    name: 'browser_select', category: 'control',
    description: 'Choose an option in a <select> in a browser tab.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment'), index: num('Element index'), selector: str('CSS selector'), value: str('Option value or label') }, ['value']),
    run: async (input, ctx) => ctx.browser('select', { tab: input.tab, index: input.index, selector: input.selector, value: input.value })
  },
  {
    name: 'browser_hover', category: 'control',
    description: 'Hover over an element in a browser tab.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment'), index: num('Element index'), selector: str('CSS selector'), text: str('Visible text') }),
    run: async (input, ctx) => ctx.browser('hover', { tab: input.tab, index: input.index, selector: input.selector, text: input.text })
  },
  {
    name: 'browser_scroll', category: 'control',
    description: 'Scroll a browser tab by pixels (negative = up).',
    input_schema: obj({ tab: str('Tab id, or title/url fragment'), dy: num('Pixels') }, ['dy']),
    run: async (input, ctx) => ctx.browser('scroll', { tab: input.tab, dy: input.dy })
  },
  {
    name: 'browser_wait', category: 'control',
    description: 'Wait for an element (selector) in a browser tab, or for some milliseconds.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment'), selector: str('CSS selector'), ms: num('Milliseconds (default 10000, max 30000)') }),
    run: async (input, ctx) => ctx.browser('wait', { tab: input.tab, selector: input.selector, ms: input.ms })
  },
  {
    name: 'browser_back', category: 'control',
    description: 'Go back one page in a browser tab.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment') }),
    run: async (input, ctx) => ctx.browser('back', { tab: input.tab })
  },
  {
    name: 'browser_forward', category: 'control',
    description: 'Go forward one page in a browser tab.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment') }),
    run: async (input, ctx) => ctx.browser('forward', { tab: input.tab })
  },
  {
    name: 'browser_activate', category: 'control',
    description: 'Bring a browser tab to the front for the user to see.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment') }),
    run: async (input, ctx) => ctx.browser('activate', { tab: input.tab })
  },
  {
    name: 'browser_close_tab', category: 'control',
    description: 'Close a browser tab.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment') }, ['tab']),
    run: async (input, ctx) => ctx.browser('close', { tab: input.tab })
  },
  {
    name: 'browser_eval', category: 'control',
    description: 'Run JavaScript in a browser tab and return the result.',
    input_schema: obj({ tab: str('Tab id, or title/url fragment'), code: str('JavaScript') }, ['code']),
    run: async (input, ctx) => ctx.browser('eval', { tab: input.tab, code: input.code })
  },
  // ------------------------------------------------------- memory
  {
    name: 'show_visual', category: 'read',
    description: 'Show information visually: write a small self-contained HTML page (a chart, table, dashboard, comparison, timeline, diagram, cards) and display it as a card in the chat (where: "chat", default) or as a widget on the desktop (where: "desktop"). Inline your CSS and JS and embed the data - the page cannot make network requests. Libraries may be loaded only from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com (e.g. Chart.js). The page has a dark transparent background and light text by default, and the title is already shown above it (do not repeat it as a heading); keep it compact - chat cards are about 400 px wide. Pass id to replace an earlier visual instead of making a new one. Returns the visual id. In your reply, describe what the visual shows in plain language; never repeat its HTML or code.',
    input_schema: obj({
      title: str('Short title shown above the visual'),
      html: str('The page: an HTML fragment or a full document'),
      where: { type: 'string', enum: ['chat', 'desktop'], description: 'chat (inline card, default) or desktop (its own widget)' },
      id: str('Optional: id of an existing visual to update')
    }, ['title', 'html']),
    run: async (input, ctx) => {
      if (!ctx.visuals) return { error: 'visuals are not available' };
      const rec = ctx.visuals.show({ id: input.id, title: input.title, html: input.html, where: input.where || 'chat' });
      return { ok: true, visual: rec.id, where: rec.where, title: rec.title };
    }
  },
  {
    name: 'close_visual', category: 'read',
    description: 'Remove a visual made with show_visual (from the chat card store or the desktop).',
    input_schema: obj({ id: str('Visual id') }, ['id']),
    run: async (input, ctx) => ({ ok: !!(ctx.visuals && ctx.visuals.close(input.id)) })
  },
  {
    name: 'list_visuals', category: 'read',
    description: 'List the visuals made with show_visual (id, title, where, last update).',
    input_schema: obj({}),
    run: async (_in, ctx) => ({ visuals: ctx.visuals ? ctx.visuals.list().slice(0, 50).map((v) => ({ id: v.id, title: v.title, where: v.where, updatedAt: new Date(v.updatedAt).toISOString() })) : [] })
  },
  {
    name: 'memory_remember', category: 'read',
    description: "Save a lasting fact to your global memory - about the user (name, role, preferences, how they like things done), their work, or the machine. Memory persists across all conversations and is shown to you at the start of each one. Don't store transient details.",
    input_schema: obj({ text: str('The fact, in one or two sentences'), tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags, e.g. ["preference"], ["project"]' } }, ['text']),
    run: async (input, ctx) => { const m = ctx.memory.remember(input.text, input.tags); return { ok: true, id: m.id }; }
  },
  {
    name: 'memory_recall', category: 'read',
    description: 'Search your global memory (all entries when query is empty).',
    input_schema: obj({ query: str('Words to look for') }),
    run: async (input, ctx) => ({ memories: ctx.memory.recall(input.query || '').map((m) => ({ id: m.id, text: m.text, tags: m.tags })) })
  },
  {
    name: 'memory_forget', category: 'read',
    description: 'Delete a memory entry by id (see memory_recall).',
    input_schema: obj({ id: str('Memory id') }, ['id']),
    run: async (input, ctx) => ({ ok: ctx.memory.forget(input.id) })
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
