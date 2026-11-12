// Runs a sandbox-mode AI tool: a hidden, sandboxed Chromium page with no
// Node, in its own session where every network request is cancelled. The
// page sees only window.aeroTool (tool-sandbox-preload.js): call() another
// app tool - through the caller's permission checks - log(), done(), fail().
const path = require('path');

const PARTITION = 'tool-sandbox';
let sessionReady = false;
const runs = new Map();        // webContents id -> { resolve, callTool, logs, timer }

function setupSession(electron) {
  if (sessionReady) return;
  sessionReady = true;
  const ses = electron.session.fromPartition(PARTITION);
  // Nothing leaves: no http(s), no file, no ws. Only the page's own data: URL.
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !/^(data|devtools):/i.test(details.url) }));
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  const { ipcMain } = electron;
  ipcMain.handle('tool-sandbox:call', async (e, name, input) => {
    const r = runs.get(e.sender.id);
    if (!r) throw new Error('no tool run');
    if (r.calls++ >= 25) throw new Error('too many tool calls in one run (25)');
    const out = await r.callTool(String(name || ''), input && typeof input === 'object' ? input : {});
    return JSON.parse(JSON.stringify(out === undefined ? null : out));
  });
  ipcMain.on('tool-sandbox:log', (e, text) => { const r = runs.get(e.sender.id); if (r && r.logs.length < 200) r.logs.push(String(text).slice(0, 2000)); });
  ipcMain.on('tool-sandbox:done', (e, value) => { const r = runs.get(e.sender.id); if (r) r.finish({ ok: true, output: value }); });
  ipcMain.on('tool-sandbox:fail', (e, message) => { const r = runs.get(e.sender.id); if (r) r.finish({ ok: false, error: String(message).slice(0, 4000) }); });
}

// The page: the input, the tool's code, then the call into run().
function pageFor(code, input) {
  const safe = (s) => String(s).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">
<script>window.onerror=function(m,s,l,c,e){aeroTool.fail((e&&e.stack)||(m+' (line '+l+')'));};window.onunhandledrejection=function(ev){aeroTool.fail(String(ev.reason&&ev.reason.stack||ev.reason));};
window.__input=${safe(JSON.stringify(input === undefined ? {} : input))};</script>
<script>
${safe(code)}
</script>
<script>(async function(){try{if(typeof run!=='function')throw new Error('the tool must define: async function run(input, aero)');
var out=await run(window.__input,{call:function(n,i){return aeroTool.call(n,i||{});},log:function(){aeroTool.log(Array.prototype.map.call(arguments,function(a){return typeof a==='string'?a:JSON.stringify(a);}).join(' '));}});
aeroTool.done(out===undefined?null:JSON.parse(JSON.stringify(out)));}catch(e){aeroTool.fail(String((e&&e.stack)||e));}})();</script>
</head><body></body></html>`;
}

// -> { ok, output | error, logs }
function runSandbox(code, input, callTool, { timeoutMs = 30000 } = {}) {
  const electron = require('electron');
  setupSession(electron);
  return new Promise((resolve) => {
    const win = new electron.BrowserWindow({
      show: false, width: 400, height: 300, skipTaskbar: true,
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        partition: PARTITION, preload: path.join(__dirname, '..', 'tool-sandbox-preload.js'),
        spellcheck: false, backgroundThrottling: false, devTools: false
      }
    });
    const id = win.webContents.id;
    const r = {
      callTool, logs: [], calls: 0, done: false,
      finish: (res) => {
        if (r.done) return;
        r.done = true;
        clearTimeout(r.timer);
        runs.delete(id);
        // A page stuck in a loop never yields: end its renderer first.
        try { if (!win.isDestroyed()) win.webContents.forcefullyCrashRenderer(); } catch { /* gone */ }
        setImmediate(() => { try { if (!win.isDestroyed()) win.destroy(); } catch { /* gone */ } });
        resolve({ ...res, ...(r.logs.length ? { logs: r.logs.join('\n').slice(-4000) } : {}) });
      }
    };
    r.timer = setTimeout(() => r.finish({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    runs.set(id, r);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('render-process-gone', () => r.finish({ ok: false, error: 'the tool crashed' }));
    // A real load failure ends the run; an aborted load (the window was
    // closed on timeout, or the page is still busy) is not an error.
    win.webContents.on('did-fail-load', (_e, errCode, desc, _url, isMain) => {
      if (isMain && errCode !== -3) r.finish({ ok: false, error: `could not start the tool (${desc || errCode})` });
    });
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageFor(code, input))}`).catch(() => { /* reported by did-fail-load, or the timeout */ });
  });
}

module.exports = { runSandbox, pageFor };
