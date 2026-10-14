const {_electron:electron}=require('playwright-core')
const fs=require('fs'),os=require('os'),path=require('path')
const assert=require('node:assert/strict')
const {SystemProxy}=require('../electron/system-proxy.cjs')
async function run() {
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'qaletx-electron-'))
  const root=path.join(__dirname,'..')
  const output=path.join(root,'test-artifacts');fs.mkdirSync(output,{recursive:true})
  const env={...process.env,QALETX_TEST_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE
  let app
  let childPids=[]
  const recovery=new SystemProxy(path.join(profile,'proxy-recovery.json'))
  const live=process.env.QALETX_LIVE_SMOKE==='1'
  const before=live?await recovery.snapshot():null
  try {
    const packed=process.env.QALETX_PACKAGED_EXE
    app=await electron.launch({executablePath:packed||require('electron'),args:packed?[`--user-data-dir=${profile}`]:[root],env,timeout:30000})
    const actualProfile=await app.evaluate(({app})=>app.getPath('userData'))
    assert.equal(path.resolve(actualProfile),path.resolve(profile),'Smoke checks must never write the real user profile')
    const page=await app.firstWindow();const errors=[]
    page.on('pageerror',e=>errors.push(e.message))
    await page.getByRole('button',{name:/登录|进入/}).first().waitFor()
    const info=await page.evaluate(()=>window.misaka.getInfo())
    assert.equal(info.core,true);assert.equal(info.privateNode,true);assert.equal(info.tray,true)
    const status=await page.evaluate(()=>window.misaka.getStatus());assert.equal(status.phase,'idle')
    const fields=await page.locator('input').count();assert.equal(fields,2)
    assert.equal((await page.locator('body').innerText()).includes('147.189.'),false)
    await page.screenshot({path:path.join(output,'login.png')})
    // API fixtures test the real Electron preload and renderer, without touching live accounts.
    const user={username:'root',role:'root',disabled:false,expiresAt:null}
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url())
      const data=url.pathname==='/api/users'?{users:[user,{username:'user',role:'user',disabled:false,expiresAt:null}]}:url.pathname==='/api/stats'?{userCount:2,activeSessions:1}:{user}
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data),headers:{'Access-Control-Allow-Origin':'null'}})
    })
    await page.evaluate(()=>localStorage.setItem('misakaAccount',JSON.stringify({username:'root',role:'root',token:'isolated-test-token',apiUrl:'http://127.0.0.1:19999'})))
    await page.reload();await page.locator('.connect-button').waitFor()
    assert.equal(await page.locator('.node-row').count(),1)
    assert.equal(await page.getByRole('button',{name:'复制链接'}).count(),0)
    const size=await page.evaluate(()=>({viewport:innerHeight,document:document.documentElement.scrollHeight,button:document.querySelector('.connect-button').getBoundingClientRect().bottom}))
    assert.ok(size.button<size.viewport)
    assert.ok(size.document<=size.viewport+1)
    await page.screenshot({path:path.join(output,'dashboard.png')})
    if(live) {
      const result=await page.evaluate(()=>window.misaka.connect({privateId:'misaka',id:'misaka',name:'qaletx 主线路',mode:'global'}))
      assert.equal(result.ok,true,result.message)
      const running=await page.evaluate(()=>window.misaka.getStatus())
      assert.equal(running.phase,'connected');assert.equal(running.systemProxy,true)
      const actual=await recovery.snapshot()
      assert.match(actual.server,/^127\.0\.0\.1:\d+$/);assert.equal(actual.flags,3)
      await page.screenshot({path:path.join(output,'connected.png')})
      assert.equal((await page.evaluate(()=>window.misaka.disconnect())).ok,true)
      assert.deepEqual(await recovery.snapshot(),before,'Original system proxy must be restored exactly')
    }
    const validation=await page.evaluate(()=>window.misaka.validateNodes('socks5://127.0.0.1:1080#Local\nsocks5://127.0.0.1:1080#Local\nbad://x'))
    assert.equal(validation.nodes.length,1);assert.equal(validation.errors.length,1)
    // Closing only the window must hide it while keeping the tray process available.
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close())
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false)
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show())
    assert.deepEqual(errors,[])
    if(live) {
      assert.equal((await page.evaluate(()=>window.misaka.connect({privateId:'misaka',id:'misaka',name:'qaletx 主线路',mode:'global'}))).ok,true)
      childPids=await app.evaluate(({app})=>app.getAppMetrics().map(metric=>metric.pid))
      const terminatingApp=app
      // On Windows Playwright launches through cmd.exe; .process() is that
      // wrapper. Kill the actual Electron main process to exercise the guardian.
      const mainPid=await app.evaluate(()=>process.pid)
      process.kill(mainPid);app=null
      for(const pid of childPids) try{process.kill(pid)}catch{}
      await terminatingApp.close().catch(()=>{})
      const deadline=Date.now()+15000
      while(Date.now()<deadline && fs.existsSync(path.join(profile,'proxy-recovery.json'))) await new Promise(r=>setTimeout(r,250))
      assert.equal(fs.existsSync(path.join(profile,'proxy-recovery.json')),false,'Detached guardian must recover after forced termination')
      assert.deepEqual(await recovery.snapshot(),before,'Guardian must restore original proxy after forced termination')
    } else {await app.close();app=null}
    console.log(JSON.stringify({electronSmoke:'passed',version:info.version,packaged:Boolean(packed),tray:info.tray,loginInputs:fields,layout:size,realConnectionVerified:live,forcedExitRecoveryVerified:live,systemProxyRestored:live?true:'not modified'}))
  } finally {
    if(app) await app.close().catch(()=>{})
    if(live) await recovery.restore()
    for(const pid of childPids) try{process.kill(pid)}catch{}
    try {fs.rmSync(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250})} catch {console.error('Test profile retained because a test browser file is still locked.')}
  }
}
run().catch(e=>{console.error(e);process.exitCode=1})
