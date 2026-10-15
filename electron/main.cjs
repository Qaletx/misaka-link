const {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,powerMonitor} = require('electron')
const path=require('path')
const fs=require('fs')
const crypto=require('crypto')
const os=require('os')
const {net:electronNet}=require('electron')
const {spawn}=require('child_process')
const {CoreManager}=require('./core-manager.cjs')
const {SystemProxy}=require('./system-proxy.cjs')
const {describeNode}=require('./protocols.cjs')
const {NodeProbe}=require('./node-probe.cjs')
const {ConnectionSession}=require('./connection-session.cjs')
const {validProxyPort,loadProxyPort,saveProxyPort,loadPreferences,savePreferences}=require('./preferences.cjs')
const {ConnectionController}=require('./connection-controller.cjs')
if(!app.isPackaged && process.env.QALETX_TEST_PROFILE) app.setPath('userData',process.env.QALETX_TEST_PROFILE)
let mainWindow,tray,manager,accountSession,control,quitting=false,quitReady=false,trayNodes=[]
const dataPath=app.getPath('userData')
const journal=path.join(dataPath,'proxy-recovery.json')
const preferencesFile=path.join(dataPath,'preferences.json')
const proxy=new SystemProxy(journal)
let preferences=loadPreferences(preferencesFile)
if(!preferences.deviceId){preferences.deviceId=crypto.randomUUID();savePreferences(preferencesFile,{deviceId:preferences.deviceId})}
const safeText=value=>String(value||'').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi,'[地址已隐藏]').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[地址已隐藏]').replace(/\b[A-Za-z0-9_-]{32,}\b/g,'[凭据已隐藏]')
function diagnosticReport(result){
  const state=manager.status()
  return ['qaletx link 诊断报告',`版本：${app.getVersion()} · ${process.platform} ${os.release()} ${process.arch}`,`核心：${locateCore()?'已安装':'缺失'}`,`本地端口：${manager.proxyPort}`,`状态：${state.phase} · 系统代理：${state.systemProxy?'已接管/待恢复':'未接管'}`,`连通测试：${result?result.ok?`${result.latencyMs} ms`:safeText(result.message):'未执行'}`,`错误：${safeText(state.error)||'无'}`,'阶段耗时：',...(state.timings||[]).map(x=>`${safeText(x.stage)} ${(x.durationMs/1000).toFixed(1)} 秒`),'最近日志：',...manager.logs.slice(-30).map(x=>`${x.time} [${x.level}] ${safeText(x.message)}`)].join('\n')
}
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
    {label:state.connected?`已连接 · ${state.name}`:state.phase==='connecting'?'正在连接':'未连接',enabled:false},
    {label:'打开 qaletx link',click:showWindow},
    {label:state.connected?'重新连接':'连接',enabled:Boolean(accountSession.account.current)&&!quitting&&!['connecting','disconnecting'].includes(state.phase),click:()=>control.connect().catch(()=>{})},
    {label:state.phase==='connecting'?'取消连接':'断开连接',enabled:state.phase==='connected'||state.phase==='connecting'||Boolean(state.retryAt),click:()=>control.disconnect().catch(()=>{})},
    {label:'切换线路',enabled:trayNodes.length>0&&!['connecting','disconnecting'].includes(state.phase),submenu:trayNodes.map(node=>({label:node.name,type:'radio',checked:(control.selection()?.nodeId||control.selection()?.id)===node.id,click:()=>{const payload=node.local?{id:node.id,uri:node.uri,mode:state.mode,manual:true}:{nodeId:node.id,mode:state.mode,manual:true};if(state.connected)control.connect(payload).catch(()=>{});else{control.select(payload);updateTray();mainWindow?.webContents.send('app:selection',node.id)}}}))},
    {label:'连接诊断',click:()=>{showWindow();mainWindow.webContents.send('app:open-diagnostics')}},
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
    width:1080,height:700,minWidth:860,minHeight:580,show:false,
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
    mainWindow.webContents.on('render-process-gone',()=>control.clearSession())
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
    manager=new CoreManager({binary:locateCore(),directory:path.join(dataPath,'sessions'),proxy,onSpawn:guardian,proxyPort:loadProxyPort(preferencesFile)})
    accountSession=new ConnectionSession({manager,createProbe:()=>new NodeProbe({binary:locateCore(),directory:path.join(dataPath,'probes'),onSpawn:guardian})})
    control=new ConnectionController({session:accountSession,manager,preferences,save:patch=>{savePreferences(preferencesFile,patch);preferences=loadPreferences(preferencesFile)},online:()=>electronNet.isOnline()})
    try { await proxy.restore() } catch { manager.update({phase:'error',systemProxy:true,error:'上次代理设置恢复失败，请在系统网络设置关闭代理后重试'});manager.log('error','启动时代理恢复失败') }
    const sessions=path.join(dataPath,'sessions')
    if(fs.existsSync(sessions)) for(const name of fs.readdirSync(sessions)) if(/^session-[a-f0-9]+\.json$/.test(name)) try{fs.unlinkSync(path.join(sessions,name))}catch{}
    handle('app:get-info',()=>({platform:process.platform,version:app.getVersion(),core:Boolean(locateCore()),coreName:'sing-box',privateNodeSource:'server',port:manager.proxyPort,tray:Boolean(tray),device:{id:preferences.deviceId,name:os.hostname().slice(0,80),platform:process.platform,version:app.getVersion()}}))
    handle('account:set-session',async credentials=>{const result=await control.setSession(credentials);trayNodes=[];updateTray();return result})
    handle('account:clear-session',async()=>{const result=await control.clearSession();trayNodes=[];updateTray();return result})
    handle('app:get-preferences',()=>({...control.settings(),selection:control.selection()}))
    handle('app:set-preferences',patch=>control.configure(patch))
    handle('app:set-selection',payload=>{control.select(payload);updateTray();return {ok:true}})
    handle('app:set-catalog',nodes=>{trayNodes=Array.isArray(nodes)?nodes.filter(n=>n&&typeof n.id==='string'&&typeof n.name==='string').slice(0,200):[];control.setLocalNodes(trayNodes.filter(n=>n.local));updateTray();return {ok:true}})
    handle('app:diagnostics',async()=>{const payload=control.selection();const result=payload?await accountSession.testNode(payload):{ok:false,message:'请先选择线路'};return {result,report:diagnosticReport(result)}})
    handle('app:diagnostic-report',()=>diagnosticReport())
    handle('core:get-status',()=>manager.status())
    handle('core:get-logs',()=>manager.logs.slice())
    handle('core:set-port',port=>{
      if(!validProxyPort(port)) return {ok:false,message:'本地代理端口必须为 1–65535 之间的整数'}
      const state=manager.status()
      if(accountSession.connectionsInFlight||state.connected||state.systemProxy||['connecting','disconnecting'].includes(state.phase)) return {ok:false,message:'请先断开连接并等待当前操作完成，再修改代理端口'}
      try { saveProxyPort(preferencesFile,port) }
      catch { return {ok:false,message:'端口设置保存失败，请检查应用数据目录权限'} }
      manager.proxyPort=port
      manager.update({port,error:'',phase:'idle'})
      return {ok:true,port}
    })
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
    handle('core:connect',payload=>control.connect(payload))
    handle('nodes:test',payload=>accountSession.testNode(payload))
    handle('core:disconnect',()=>control.disconnect())
    handle('app:quit',()=>{app.quit();return {ok:true}})
    let lastPhase=''
    manager.on('status',state=>{
      if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('core:status',state)
      if(lastPhase!==state.phase) {lastPhase=state.phase;updateTray()}
    })
    createTray();createWindow()
    app.on('activate',showWindow)
    powerMonitor.on('suspend',()=>control.suspend())
    powerMonitor.on('resume',()=>control.resume())
  })
  app.on('before-quit',event=>{
    if(quitReady) return
    event.preventDefault(); if(quitting) return
    quitting=true
    if(tray){
      tray.setToolTip('qaletx link · 正在安全退出')
      tray.setContextMenu(Menu.buildFromTemplate([{label:'正在断开连接并恢复系统代理…',enabled:false}]))
    }
    Promise.resolve().then(()=>control?.close()).catch(()=>{
      manager?.log('error','退出时未能完成代理清理，下次启动将重试恢复')
    }).then(()=>{
      quitReady=true
      try {tray?.destroy()} catch {}
      app.quit()
    })
  })
  app.on('window-all-closed',()=>{if(!tray&&!quitting) app.quit()})
}
