// Bridge for the Spotlight launcher window.
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('spotlight', {
  query: (q) => ipcRenderer.invoke('spotlight:query', q),
  icon: (p) => ipcRenderer.invoke('spotlight:icon', p),
  preview: (item) => ipcRenderer.invoke('spotlight:preview', item),
  reindex: () => ipcRenderer.invoke('spotlight:reindex'),
  info: () => ipcRenderer.invoke('spotlight:info'),
  open: (item) => ipcRenderer.send('spotlight:open', item),
  reveal: (item) => ipcRenderer.send('spotlight:reveal', item),
  hide: () => ipcRenderer.send('spotlight:hide'),
  copy: (text) => ipcRenderer.send('spotlight:copy', text),
  web: (q) => ipcRenderer.send('spotlight:web', q),
  clearHistory: () => ipcRenderer.send('spotlight:clear-history'),
  onShow: (cb) => subscribe('spotlight:show', cb),
  onTheme: (cb) => subscribe('spotlight:theme', cb),
  onHidden: (cb) => subscribe('spotlight:hidden', cb),
  onIndexed: (cb) => subscribe('spotlight:indexed', cb)
});
