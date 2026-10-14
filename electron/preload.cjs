const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('misaka', {
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  connect: (payload) => ipcRenderer.invoke('core:connect', payload),
  disconnect: () => ipcRenderer.invoke('core:disconnect'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  onCoreExit: (callback) => { const listener = (_event, ...args) => callback(...args); ipcRenderer.on('core:exit', listener); return () => ipcRenderer.removeListener('core:exit', listener) }
})

