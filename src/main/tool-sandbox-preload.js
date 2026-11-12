// The only thing an AI tool's sandbox page can reach: calls back to the app
// (checked there against the run that owns this page).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aeroTool', {
  call: (name, input) => ipcRenderer.invoke('tool-sandbox:call', String(name || ''), input),
  log: (text) => ipcRenderer.send('tool-sandbox:log', String(text)),
  done: (value) => ipcRenderer.send('tool-sandbox:done', value),
  fail: (message) => ipcRenderer.send('tool-sandbox:fail', String(message))
});
