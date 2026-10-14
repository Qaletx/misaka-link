const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('misaka',{
  getInfo:()=>ipcRenderer.invoke('app:get-info'),
  getStatus:()=>ipcRenderer.invoke('core:get-status'),
  getLogs:()=>ipcRenderer.invoke('core:get-logs'),
  validateNodes:text=>ipcRenderer.invoke('nodes:validate',text),
  connect:payload=>ipcRenderer.invoke('core:connect',payload),
  disconnect:()=>ipcRenderer.invoke('core:disconnect'),
  quit:()=>ipcRenderer.invoke('app:quit'),
  onStatus:callback=>{
    const listener=(_event,state)=>callback(state)
    ipcRenderer.on('core:status',listener)
    return ()=>ipcRenderer.removeListener('core:status',listener)
  }
})
