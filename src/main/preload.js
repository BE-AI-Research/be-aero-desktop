// Safe bridge between the widget UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('aero', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getTelemetry: () => ipcRenderer.invoke('telemetry:get'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  saveScratchpad: (text) => ipcRenderer.invoke('scratchpad:save-as', text),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  updateStatus: () => ipcRenderer.invoke('updates:status'),
  openUpdate: () => ipcRenderer.invoke('updates:open'),
  onUpdateStatus: (cb) => subscribe('updates:status', cb),
  exportSettings: () => ipcRenderer.invoke('settings:export'),
  importSettings: () => ipcRenderer.invoke('settings:import'),
  replaceSettings: (key, value) => ipcRenderer.invoke('settings:replace', key, value),
  listThemes: () => ipcRenderer.invoke('themes:list'),

  onSettingsChanged: (cb) => subscribe('settings:changed', cb),
  onOpenSettings: (cb) => subscribe('settings:open', cb),
  onTelemetry: (cb) => subscribe('telemetry:update', cb),

  platform: process.platform,
  setIgnoreMouse: (ignore) => ipcRenderer.send('window:ignore-mouse', ignore),
  setInputShape: (rects) => ipcRenderer.send('window:input-shape', rects),
  onMouseProbe: (cb) => subscribe('mouse:probe', cb),
  openMenu: () => ipcRenderer.send('menu:popup'),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('app:quit'),
  openExternal: (url) => ipcRenderer.send('shell:open', url),
  openSearch: (query) => ipcRenderer.send('search:open', query),
  searchHotkey: () => ipcRenderer.invoke('search:hotkey'),
  // AI assistant
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiSetKey: (key) => ipcRenderer.invoke('ai:set-key', key),
  aiModels: () => ipcRenderer.invoke('ai:models'),
  aiConversations: () => ipcRenderer.invoke('ai:conversations'),
  aiConversation: (id) => ipcRenderer.invoke('ai:conversation', id),
  aiNew: () => ipcRenderer.invoke('ai:new'),
  aiRename: (id, title) => ipcRenderer.invoke('ai:rename', id, title),
  aiDelete: (id) => ipcRenderer.invoke('ai:delete', id),
  aiSend: (id, text) => ipcRenderer.invoke('ai:send', id, text),
  aiStop: (id) => ipcRenderer.invoke('ai:stop', id),
  aiPin: (on) => ipcRenderer.invoke('ai:pin', on),
  onAiEvent: (cb) => subscribe('ai:event', cb),
  onAiAsk: (cb) => subscribe('ai:ask', cb),
  onAiWebOp: (cb) => subscribe('ai:web-op', cb),
  aiWebOpResult: (opId, result) => ipcRenderer.send('ai:web-op:result', { opId, result }),
  // Notification center
  notifyList: () => ipcRenderer.invoke('notifications:list'),
  notifyRead: (id) => ipcRenderer.invoke('notifications:read', id),
  notifyRemove: (id) => ipcRenderer.invoke('notifications:remove', id),
  notifyClear: () => ipcRenderer.invoke('notifications:clear'),
  notifyOpen: (id) => ipcRenderer.invoke('notifications:open', id),
  notifyFromWeb: (payload) => ipcRenderer.send('notifications:from-web', payload),
  onNotificationsChanged: (cb) => subscribe('notifications:changed', cb),
  onNotificationOpen: (cb) => subscribe('notifications:open', cb),
  dockHotkey: () => ipcRenderer.invoke('dock:hotkey'),
  onDockSummon: (cb) => subscribe('dock:summon', cb),

  // --- Extensions: plugin widgets and app panes ---
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  reloadPlugins: () => ipcRenderer.invoke('plugins:reload'),
  setPluginEnabled: (id, on) => ipcRenderer.invoke('plugins:set-enabled', id, on),
  openPluginsFolder: () => ipcRenderer.invoke('plugins:open-folder'),
  setPluginSetting: (id, key, value) => ipcRenderer.invoke('plugins:set-setting', id, key, value),
  onPluginsChanged: (cb) => subscribe('plugins:changed', cb),

  // Called on a plugin's behalf by the iframe bridge; main checks permissions.
  pluginStorageGet: (id) => ipcRenderer.invoke('plugin:storage-get', id),
  pluginStorageSet: (id, patch) => ipcRenderer.invoke('plugin:storage-set', id, patch),
  pluginTelemetry: (id) => ipcRenderer.invoke('plugin:telemetry', id),
  pluginTheme: (id) => ipcRenderer.invoke('plugin:theme', id),
  pluginOpenExternal: (id, url) => ipcRenderer.invoke('plugin:open-external', id, url),
  pluginNotify: (id, body) => ipcRenderer.invoke('plugin:notify', id, body),
  pluginPermissionQuery: (id, p) => ipcRenderer.invoke('plugin:permission-query', id, p),
  pluginPermissionRequest: (id, p) => ipcRenderer.invoke('plugin:permission-request', id, p),

  permissionCatalog: () => ipcRenderer.invoke('permissions:catalog'),
  setPermission: (id, p, state) => ipcRenderer.invoke('permissions:set', id, p, state),
  resetPermissions: (id) => ipcRenderer.invoke('permissions:reset', id),

  listPanes: () => ipcRenderer.invoke('panes:list'),
  onPanesChanged: (cb) => subscribe('panes:changed', cb),
  onWebWidgetFailed: (cb) => subscribe('webwidget:failed', cb),
  onWebWidgetCert: (cb) => subscribe('webwidget:cert', cb),
  trustCert: (host, fp) => ipcRenderer.invoke('certs:trust', host, fp),
  revokeCert: (host) => ipcRenderer.invoke('certs:revoke', host),
  listCerts: () => ipcRenderer.invoke('certs:list'),

  listTasks: () => ipcRenderer.invoke('tasks:list'),
  taskAction: (name, hwnd) => ipcRenderer.invoke('tasks:action', name, hwnd),
  taskIcon: (exe) => ipcRenderer.invoke('tasks:icon', exe),
  dockMenu: (tile) => ipcRenderer.invoke('dock:menu', tile),
  dockLaunch: (exe) => ipcRenderer.invoke('dock:launch', exe),
  apiStatus: () => ipcRenderer.invoke('api:status'),
  setApiEnabled: (on) => ipcRenderer.invoke('api:set-enabled', on),
  regenerateApiToken: () => ipcRenderer.invoke('api:regenerate-token'),
  appCapabilityCatalog: () => ipcRenderer.invoke('api:capability-catalog'),
  setAppGrant: (id, cap, state) => ipcRenderer.invoke('api:set-app-grant', id, cap, state),
  revokeApp: (id) => ipcRenderer.invoke('api:revoke-app', id),
  onApiChanged: (cb) => subscribe('api:changed', cb)
});
