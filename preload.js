const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubbleAPI', {
  moveWindow: (dx, dy) => ipcRenderer.send('move-window', { dx, dy }),
  resizeBubble: (visualSize) => ipcRenderer.send('resize-bubble', { visualSize }),
  expandPanel: (width, height) => ipcRenderer.send('expand-panel', { width, height }),
  resizePanel: (width, height) => ipcRenderer.send('resize-panel', { width, height }),
  collapseBubble: () => ipcRenderer.send('collapse-bubble'),
  showPreviewStack: (extraWidth, stackHeight) => ipcRenderer.send('show-preview-stack', { extraWidth, stackHeight }),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore)
  ,hideWindow: () => ipcRenderer.send('hide-window')
});

contextBridge.exposeInMainWorld('ghzAPI', {
  checkLoginStatus: () => ipcRenderer.invoke('ghz:check-login'),
  login: (email, password, remember) => ipcRenderer.invoke('ghz:login', { email, password, remember }),
  logout: () => ipcRenderer.invoke('ghz:logout'),
  getNotifications: () => ipcRenderer.invoke('ghz:get-notifications'),
  saveCustomSound: (name, data) => ipcRenderer.invoke('ghz:save-custom-sound', { name, data }),
  loadCustomSound: () => ipcRenderer.invoke('ghz:load-custom-sound'),
  renameCustomSound: (id, name) => ipcRenderer.invoke('ghz:rename-custom-sound', { id, name }),
  deleteCustomSound: (id) => ipcRenderer.invoke('ghz:delete-custom-sound', { id }),
  getUpdateState: () => ipcRenderer.invoke('ghz:update-state'),
  installUpdate: () => ipcRenderer.invoke('ghz:install-update'),
  openExternal: (url) => ipcRenderer.invoke('ghz:open-external', url),
  showTicketPanel: (url, width, height, headerHeight) =>
    ipcRenderer.invoke('ghz:show-ticket-panel', { url, width, height, headerHeight }),
  hideTicketPanel: (width, height) => ipcRenderer.send('ghz:hide-ticket-panel', { width, height })
});
