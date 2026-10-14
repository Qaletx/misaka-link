const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('misaka',{
  getInfo:()=>ipcRenderer.invoke('app:get-info'),
  setSession:credentials=>ipcRenderer.invoke('account:set-session',credentials),
  clearSession:()=>ipcRenderer.invoke('account:clear-session'),
  getStatus:()=>ipcRenderer.invoke('core:get-status'),
  getLogs:()=>ipcRenderer.invoke('core:get-logs'),
  validateNodes:text=>ipcRenderer.invoke('nodes:validate',text),
  testNode:payload=>ipcRenderer.invoke('nodes:test',payload),
  connect:payload=>ipcRenderer.invoke('core:connect',payload),
  disconnect:()=>ipcRenderer.invoke('core:disconnect'),
  quit:()=>ipcRenderer.invoke('app:quit'),
  onStatus:callback=>{
    const listener=(_event,state)=>callback(state)
    ipcRenderer.on('core:status',listener)
    return ()=>ipcRenderer.removeListener('core:status',listener)
  }
})
