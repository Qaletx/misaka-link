const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('misaka', {
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  connect: (payload) => ipcRenderer.invoke('core:connect', payload),
  disconnect: () => ipcRenderer.invoke('core:disconnect'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  onCoreExit: (callback) => ipcRenderer.on('core:exit', callback)
})
