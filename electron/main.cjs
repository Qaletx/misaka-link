const {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,powerMonitor} = require('electron')
const path=require('path')
const fs=require('fs')
const {spawn}=require('child_process')
const {CoreManager}=require('./core-manager.cjs')
const {SystemProxy}=require('./system-proxy.cjs')
const {describeNode}=require('./protocols.cjs')
const {NodeProbe}=require('./node-probe.cjs')
const {ConnectionSession}=require('./connection-session.cjs')
if(!app.isPackaged && process.env.QALETX_TEST_PROFILE) app.setPath('userData',process.env.QALETX_TEST_PROFILE)
let mainWindow,tray,manager,accountSession,quitting=false,quitReady=false
const dataPath=app.getPath('userData')
const journal=path.join(dataPath,'proxy-recovery.json')
const proxy=new SystemProxy(journal)
function asset(name) {
  return [path.join(process.resourcesPath,'assets',name),path.join(__dirname,'..','assets',name)].find(p=>fs.existsSync(p))
}
function locateCore() {
  const name=process.platform==='win32'?'sing-box.exe':`sing-box-${process.arch==='arm64'?'arm64':'amd64'}`
  return [path.join(process.resourcesPath,'core',name),path.join(__dirname,'..','core',name)].find(p=>fs.existsSync(p))
}
function showWindow() { if(!mainWindow||mainWindow.isDestroyed()) createWindow(); if(mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus() }
function updateTray() {
  if(!tray || !manager) return
  if(quitting) {
    tray.setToolTip('qaletx link · 正在安全退出')
    tray.setContextMenu(Menu.buildFromTemplate([{label:'正在断开连接并恢复系统代理…',enabled:false}]))
    return
  }
  const state=manager.status()
  tray.setToolTip(`qaletx link · ${state.connected?'已连接':'未连接'}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:state.connected?'已连接':'未连接',enabled:false},
    {label:'打开 qaletx link',click:showWindow},
    {label:'断开连接',enabled:state.phase==='connected'||state.phase==='connecting',click:()=>accountSession.disconnect()},
    {type:'separator'},
    {label:'退出 qaletx link',click:()=>app.quit()}
  ]))
}
function createTray() {
  try {
    const icon=asset(process.platform==='win32'?'qaletx-link.ico':'qaletx-link.png')
    if(!icon) throw new Error('Missing tray icon')
    let bitmap=nativeImage.createFromPath(icon)
    if(process.platform==='darwin') bitmap=bitmap.resize({width:20,height:20})
    tray=new Tray(bitmap)
    tray.on('double-click',showWindow)
    if(process.platform==='darwin') tray.on('click',showWindow)
    updateTray()
  } catch { tray=null; manager.log('warn','托盘不可用，关闭窗口将退出软件') }
}
function createWindow() {
  mainWindow=new BrowserWindow({
    width:1020,height:700,minWidth:900,minHeight:600,show:false,
    title:'qaletx link',backgroundColor:'#fbf7f5',icon:asset('qaletx-link.png'),
    autoHideMenuBar:true,titleBarStyle:process.platform==='darwin'?'hiddenInset':'default',
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}
  })
  mainWindow.once('ready-to-show',()=>mainWindow.show())
  mainWindow.on('close',event=>{
    if(!quitting && tray) {event.preventDefault();mainWindow.hide()}
    else if(!quitting) {event.preventDefault();app.quit()}
  })
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}))
  mainWindow.webContents.on('will-navigate',event=>event.preventDefault())
  mainWindow.webContents.on('render-process-gone',()=>accountSession.clearSession())
  const devUrl=!app.isPackaged && process.argv.includes('--dev')?'http://127.0.0.1:5173':null
  if(devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadFile(path.join(__dirname,'..','dist','index.html'))
}
function guardian(corePid) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(__dirname,'guardian.cjs'),String(process.pid),String(corePid),journal,proxy.ownerToken],{
      env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,detached:true,stdio:['ignore','pipe','ignore']
    })
    const timer=setTimeout(()=>{child.kill();reject(new Error('代理恢复守护进程未能启动'))},5000)
    child.once('error',()=>{clearTimeout(timer);reject(new Error('代理恢复守护进程启动失败'))})
    child.stdout.once('data',()=>{clearTimeout(timer);child.stdout.destroy();child.unref();resolve(child)})
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('代理恢复守护进程已退出'))})
  })
}
function handle(name,callback) {
  ipcMain.handle(name,(event,...args)=>{
    if(!mainWindow || event.sender!==mainWindow.webContents || event.senderFrame!==mainWindow.webContents.mainFrame) throw new Error('不允许的调用来源')
    return callback(...args)
  })
}
if(!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance',()=>{if(manager) showWindow()})
  app.whenReady().then(async()=>{
    Menu.setApplicationMenu(null)
    manager=new CoreManager({binary:locateCore(),directory:path.join(dataPath,'sessions'),proxy,onSpawn:guardian})
    accountSession=new ConnectionSession({manager,createProbe:()=>new NodeProbe({binary:locateCore(),directory:path.join(dataPath,'probes'),onSpawn:guardian})})
    try { await proxy.restore() } catch { manager.update({phase:'error',systemProxy:true,error:'上次代理设置恢复失败，请在系统网络设置关闭代理后重试'});manager.log('error','启动时代理恢复失败') }
    const sessions=path.join(dataPath,'sessions')
    if(fs.existsSync(sessions)) for(const name of fs.readdirSync(sessions)) if(/^session-[a-f0-9]+\.json$/.test(name)) try{fs.unlinkSync(path.join(sessions,name))}catch{}
    handle('app:get-info',()=>({platform:process.platform,version:app.getVersion(),core:Boolean(locateCore()),coreName:'sing-box',privateNodeSource:'server',port:10808,tray:Boolean(tray)}))
    handle('account:set-session',credentials=>accountSession.setSession(credentials))
    handle('account:clear-session',()=>accountSession.clearSession())
    handle('core:get-status',()=>manager.status())
    handle('core:get-logs',()=>manager.logs.slice())
    handle('nodes:validate',text=>{
      if(typeof text!=='string'||text.length>262144) return {ok:false,nodes:[],errors:['导入内容过大']}
      const nodes=[],errors=[]; const seen=new Set()
      text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).slice(0,201).forEach((uri,index)=>{
        if(index>=200) {errors.push('单次最多导入 200 个节点');return}
        try {const {name,protocol}=describeNode(uri); if(!seen.has(uri)) nodes.push({uri,name,protocol});seen.add(uri)}
        catch(e) {errors.push(`第 ${index+1} 行：${e.message}`)}
      })
      return {ok:nodes.length>0,nodes,errors}
    })
    handle('core:connect',payload=>accountSession.connect(payload))
    handle('nodes:test',payload=>accountSession.testNode(payload))
    handle('core:disconnect',()=>accountSession.disconnect())
    handle('app:quit',()=>{app.quit();return {ok:true}})
    let lastPhase=''
    manager.on('status',state=>{
      if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('core:status',state)
      if(lastPhase!==state.phase) {lastPhase=state.phase;updateTray()}
    })
    createTray();createWindow()
    app.on('activate',showWindow)
    powerMonitor.on('suspend',()=>accountSession.disconnect())
  })
  app.on('before-quit',event=>{
    if(quitReady) return
    event.preventDefault(); if(quitting) return
    quitting=true
    if(tray){
      tray.setToolTip('qaletx link · 正在安全退出')
      tray.setContextMenu(Menu.buildFromTemplate([{label:'正在断开连接并恢复系统代理…',enabled:false}]))
    }
    Promise.resolve().then(()=>accountSession?.clearSession()).catch(()=>{
      manager?.log('error','退出时未能完成代理清理，下次启动将重试恢复')
    }).then(()=>{
      quitReady=true
      try {tray?.destroy()} catch {}
      app.quit()
    })
  })
  app.on('window-all-closed',()=>{if(!tray&&!quitting) app.quit()})
}
