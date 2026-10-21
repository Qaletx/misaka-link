const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('misaka',{
  getInfo:()=>ipcRenderer.invoke('app:get-info'),
  setSession:credentials=>ipcRenderer.invoke('account:set-session',credentials),
  clearSession:()=>ipcRenderer.invoke('account:clear-session'),
  accountRequest:input=>ipcRenderer.invoke('account:request',input),
  getStatus:()=>ipcRenderer.invoke('core:get-status'),
  getLogs:()=>ipcRenderer.invoke('core:get-logs'),
  setProxyPort:port=>ipcRenderer.invoke('core:set-port',port),
  validateNodes:text=>ipcRenderer.invoke('nodes:validate',text),
  getNodeAddresses:nodes=>ipcRenderer.invoke('nodes:addresses',nodes),
  testNode:payload=>ipcRenderer.invoke('nodes:test',payload),
  connect:payload=>ipcRenderer.invoke('core:connect',payload),
  disconnect:()=>ipcRenderer.invoke('core:disconnect'),
  quit:()=>ipcRenderer.invoke('app:quit'),
  getPreferences:()=>ipcRenderer.invoke('app:get-preferences'),
  setPreferences:patch=>ipcRenderer.invoke('app:set-preferences',patch),
  setSelection:payload=>ipcRenderer.invoke('app:set-selection',payload),
  setCatalog:nodes=>ipcRenderer.invoke('app:set-catalog',nodes),
  diagnose:()=>ipcRenderer.invoke('app:diagnostics'),
  diagnosticReport:()=>ipcRenderer.invoke('app:diagnostic-report'),
  onSelection:callback=>{const listener=(_event,id)=>callback(id);ipcRenderer.on('app:selection',listener);return()=>ipcRenderer.removeListener('app:selection',listener)},
  onDiagnostics:callback=>{const listener=()=>callback();ipcRenderer.on('app:open-diagnostics',listener);return()=>ipcRenderer.removeListener('app:open-diagnostics',listener)},
  onStatus:callback=>{
    const listener=(_event,state)=>callback(state)
    ipcRenderer.on('core:status',listener)
    return ()=>ipcRenderer.removeListener('core:status',listener)
  }
})
