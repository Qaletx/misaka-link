const {test}=require('node:test')
const assert=require('node:assert/strict')
const http=require('http')
const {EventEmitter}=require('events')
const {AccountSession}=require('../electron/account-session.cjs')
const {ConnectionSession}=require('../electron/connection-session.cjs')
const pause=ms=>new Promise(r=>setTimeout(r,ms))
async function fixture(t,handler){
  const server=http.createServer(async(req,res)=>{
    const result=await handler(req)
    if(res.destroyed)return
    res.writeHead(result.status||200,{'Content-Type':'application/json',...(result.headers||{})});res.end(JSON.stringify(result.body||{}))
  });await new Promise(r=>server.listen(0,'127.0.0.1',r))
  t.after(()=>new Promise(r=>server.close(r)))
  return {apiUrl:`http://127.0.0.1:${server.address().port}`,token:'fixture-token'}
}
const user=role=>({username:'account',role,permissions:{changePassword:role!=='shared',syncNodes:role!=='shared'}})
function managerStub(){
  const manager=new EventEmitter();manager.value={phase:'idle',connected:false};manager.starts=0;manager.stops=0
  manager.status=()=>({...manager.value});manager.update=patch=>{Object.assign(manager.value,patch);manager.emit('status',manager.status())};manager.log=()=>{}
  manager.connect=async()=>{manager.starts++;manager.update({phase:'connected',connected:true});return{ok:true}}
  manager.disconnect=async()=>{manager.stops++;manager.update({phase:'idle',connected:false});return{ok:true}}
  return manager
}
test('private configuration has no offline or built-in credential fallback',async()=>{
  const session=new AccountSession()
  await assert.rejects(session.resolve({privateId:'misaka'}),e=>e.status===401)
})
test('cloud config authorizes the requested node before use and rejects a different returned id',async t=>{
  let allowed=true,wrongId=false
  const credentials=await fixture(t,req=>req.url==='/api/me'?{body:{user:user('user')}}:!allowed?{status:403}:{body:{uri:'socks5://127.0.0.1:3333',node:{id:wrongId?'other':'mine',name:'云线路',private:true}}})
  const session=new AccountSession();t.after(()=>session.clear());await session.set(credentials)
  assert.equal((await session.resolve({nodeId:'mine'})).private,true)
  allowed=false;await assert.rejects(session.resolve({nodeId:'mine'}),e=>e.status===403)
  allowed=true;wrongId=true;await assert.rejects(session.resolve({nodeId:'mine'}),/配置无效/)
})
test('shared accounts can use local imports, other roles must sync before connecting',async t=>{
  let role='shared'
  const credentials=await fixture(t,()=>({body:{user:user(role)}}))
  const session=new AccountSession();t.after(()=>session.clear());await session.set(credentials)
  const payload={uri:'socks5://127.0.0.1:3333',id:'local-one'}
  assert.equal((await session.resolve(payload)).id,'local-one')
  role='user';await assert.rejects(session.resolve(payload),e=>e.status===403)
})
test('clearing a session cancels an in-flight authorization without returning credentials',async t=>{
  const credentials=await fixture(t,async req=>{
    if(req.url==='/api/me')return{body:{user:user('user')}}
    await pause(100);return{body:{uri:'socks5://127.0.0.1:3333',node:{id:'mine'}}}
  })
  const session=new AccountSession();await session.set(credentials)
  const pending=assert.rejects(session.resolve({nodeId:'mine'}),/会话已切换/)
  session.clear();await pending
})
test('legacy servers and redirected credential requests are rejected explicitly',async t=>{
  let legacy=true
  const credentials=await fixture(t,()=>legacy?{body:{user:{username:'root',role:'root'}}}:{status:302,headers:{Location:'http://example.invalid/leak'}})
  const session=new AccountSession();t.after(()=>session.clear())
  await assert.rejects(session.set(credentials),/0.5/)
  legacy=false;await assert.rejects(session.set(credentials),e=>e.status===302)
})
test('an unauthorized probe never reaches the core and never interrupts the active manager',async()=>{
  const manager=managerStub();let probes=0
  const account={clear(){},async set(){return user('user')},async resolve(){const e=new Error('拒绝访问');e.status=403;throw e}}
  const session=new ConnectionSession({manager,account,createProbe:()=>({async test(){probes++;return{ok:true}},async close(){}})})
  await session.setSession({});const stops=manager.stops
  const result=await session.testNode({nodeId:'secret'})
  assert.equal(result.ok,false);assert.equal(probes,0);assert.equal(manager.stops,stops)
  await session.clearSession()
})

test('an occupied proxy port is reported before requesting private node credentials',async()=>{
  const manager=managerStub();let authorizations=0
  manager.checkPort=async()=>({ok:false,message:'本地代理端口 10808 已被占用'})
  const account={clear(){},async set(){return user('user')},async resolve(){authorizations++;throw new Error('should not request configuration')}}
  const session=new ConnectionSession({manager,account,createProbe:()=>({close:async()=>{}})})
  await session.setSession({})
  const result=await session.connect({nodeId:'mine'})
  assert.equal(result.ok,false);assert.match(result.message,/10808/)
  assert.equal(authorizations,0);assert.equal(manager.starts,0)
  assert.equal(manager.status().phase,'error')
  await session.clearSession()
})
test('revocation and configuration changes disconnect an active cloud node',async()=>{
  const manager=managerStub();let allowed=true,uri='socks5://127.0.0.1:3333'
  const account={clear(){},async set(){return user('user')},async resolve(){if(!allowed){const e=new Error('denied');e.status=403;throw e}return{uri,id:'mine',nodeId:'mine',name:'Mine'}}}
  const session=new ConnectionSession({manager,account,createProbe:()=>({close:async()=>{}})})
  await session.setSession({});await session.connect({nodeId:'mine'});allowed=false;await session.checkAccess()
  assert.equal(manager.status().connected,false);assert.match(manager.status().error,/授权已失效/)
  allowed=true;await session.connect({nodeId:'mine'});uri='socks5://127.0.0.1:4444';await session.checkAccess()
  assert.equal(manager.status().connected,false);assert.match(manager.status().error,/配置已更新/)
  await session.clearSession()
})
test('disconnect while authorization is pending prevents a late core startup',async()=>{
  const manager=managerStub()
  const account={clear(){},async set(){return user('user')},async resolve(){await pause(50);return{uri:'socks5://127.0.0.1:3333',id:'mine',nodeId:'mine'}}}
  const session=new ConnectionSession({manager,account,createProbe:()=>({close:async()=>{}})})
  await session.setSession({});const pending=session.connect({nodeId:'mine'});await pause(0);await session.disconnect()
  assert.equal((await pending).ok,false);assert.equal(manager.starts,0)
  await session.clearSession()
})
test('two consecutive server outages disconnect, but a single timeout does not',async()=>{
  const manager=managerStub();let offline=false
  const account={clear(){},async set(){return user('user')},async resolve(){if(offline)throw new Error('offline');return{uri:'socks5://127.0.0.1:3333',id:'mine',nodeId:'mine'}}}
  const session=new ConnectionSession({manager,account,createProbe:()=>({close:async()=>{}})})
  await session.setSession({});await session.connect({nodeId:'mine'});offline=true
  await session.checkAccess();assert.equal(manager.status().connected,true)
  await session.checkAccess();assert.equal(manager.status().connected,false)
  await session.clearSession()
})


function deferred() {
  let resolve,reject
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no})
  return {promise,resolve,reject}
}
const node=id=>({uri:`socks5://127.0.0.1:${id==='A'?3333:4444}`,id,nodeId:id,name:id})

test('a failed replacement cancels an already starting connection instead of leaving it without authorization monitoring',async()=>{
  const manager=managerStub(),startup=deferred()
  let cancellation=0,starting=false
  manager.connect=async()=>{
    manager.starts++;starting=true;const epoch=cancellation
    manager.update({phase:'connecting',connected:false})
    await startup.promise
    if(epoch!==cancellation)return{ok:false,message:'cancelled'}
    manager.update({phase:'connected',connected:true});return{ok:true}
  }
  manager.disconnect=async()=>{cancellation++;manager.stops++;manager.update({phase:'idle',connected:false});return{ok:true}}
  const account={clear(){},async set(){return user('user')},async resolve(payload){
    if(payload.nodeId==='B'){const error=new Error('not authorized');error.status=403;throw error}
    return node('A')
  }}
  const session=new ConnectionSession({manager,account,createProbe:()=>({close:async()=>{}})})
  await session.setSession({})
  const first=session.connect({nodeId:'A'})
  await pause(0);assert.equal(starting,true)
  const second=await session.connect({nodeId:'B'})
  assert.equal(second.ok,false)
  startup.resolve()
  assert.equal((await first).ok,false)
  assert.equal(manager.status().connected,false)
  assert.equal(session.active,null);assert.equal(session.timer,null)
  await session.clearSession()
})

test('an obsolete authorization response cannot start over the latest connection or report success',async()=>{
  const manager=managerStub(),authorization=deferred()
  const account={clear(){},async set(){return user('user')},async resolve(payload){return payload.nodeId==='A'?authorization.promise:node('B')}}
  const session=new ConnectionSession({manager,account,createProbe:()=>({close:async()=>{}})})
  await session.setSession({})
  const first=session.connect({nodeId:'A'});await pause(0)
  const latest=await session.connect({nodeId:'B'});assert.equal(latest.ok,true)
  authorization.resolve(node('A'))
  assert.equal((await first).ok,false)
  assert.equal(manager.starts,1)
  assert.equal(manager.status().connected,true)
  assert.equal(session.active.nodeId,'B');assert.ok(session.timer)
  await session.clearSession()
})

test('a failed proxy cleanup prevents authorization and startup of the requested replacement',async()=>{
  const manager=managerStub();let resolutions=0
  manager.disconnect=async()=>({ok:false,message:'proxy recovery failed'})
  const account={clear(){},async resolve(){resolutions++;return node('A')}}
  const session=new ConnectionSession({manager,account,createProbe:()=>({close:async()=>{}})})
  const result=await session.connect({nodeId:'A'})
  assert.equal(result.ok,false);assert.match(result.message,/recovery/)
  assert.equal(resolutions,0);assert.equal(manager.starts,0)
  assert.equal(session.active,null);assert.equal(session.timer,null)
})

test('a previous connection authorization failure cannot increment the new connection outage counter',async()=>{
  const manager=managerStub(),oldCheck=deferred();let pending=false,offline=false
  const account={clear(){},async set(){return user('user')},async resolve(payload){
    if(pending&&payload.nodeId==='A')return oldCheck.promise
    if(offline)throw new Error('server offline')
    return node(payload.nodeId)
  }}
  const session=new ConnectionSession({manager,account,createProbe:()=>({close:async()=>{}})})
  await session.setSession({});await session.connect({nodeId:'A'})
  pending=true;const stale=session.checkAccess()
  await session.connect({nodeId:'B'})
  oldCheck.reject(new Error('old server timeout'));await stale
  assert.equal(session.failures,0);assert.equal(session.active.nodeId,'B')
  offline=true;await session.checkAccess()
  assert.equal(session.failures,1);assert.equal(manager.status().connected,true)
  await session.checkAccess();assert.equal(manager.status().connected,false)
  await session.clearSession()
})

test('a stale successful check cannot reset a newer connection outage counter or unlock its active check',async()=>{
  const manager=managerStub(),oldCheck=deferred(),newCheck=deferred()
  let stage='connect'
  const account={clear(){},async set(){return user('user')},async resolve(payload){
    if(stage==='old'&&payload.nodeId==='A')return oldCheck.promise
    if(stage==='new'&&payload.nodeId==='B')return newCheck.promise
    if(stage==='offline')throw new Error('offline')
    return node(payload.nodeId)
  }}
  const session=new ConnectionSession({manager,account,createProbe:()=>({close:async()=>{}})})
  await session.setSession({});await session.connect({nodeId:'A'})
  stage='old';const stale=session.checkAccess()
  stage='connect';await session.connect({nodeId:'B'})
  stage='offline';await session.checkAccess();assert.equal(session.failures,1)
  stage='new';const current=session.checkAccess();const currentCheck=session.checking
  assert.ok(currentCheck)
  oldCheck.resolve(node('A'));await stale
  assert.equal(session.failures,1);assert.equal(session.checking,currentCheck)
  newCheck.resolve(node('B'));await current
  assert.equal(session.failures,0);assert.equal(session.checking,null)
  await session.clearSession()
})

test('a stale authorization cleanup cannot overwrite a newer successful connection status',async()=>{
  const manager=managerStub(),cleanup=deferred();let deny=false,holdNextStop=false
  const originalStop=manager.disconnect
  manager.disconnect=async()=>{await originalStop();if(holdNextStop){holdNextStop=false;return cleanup.promise}return{ok:true}}
  const account={clear(){},async set(){return user('user')},async resolve(payload){
    if(deny&&payload.nodeId==='A'){const error=new Error('revoked');error.status=403;throw error}
    return node(payload.nodeId)
  }}
  const session=new ConnectionSession({manager,account,createProbe:()=>({close:async()=>{}})})
  await session.setSession({});await session.connect({nodeId:'A'})
  deny=true;holdNextStop=true;const stale=session.checkAccess();await pause(0)
  assert.equal((await session.connect({nodeId:'B'})).ok,true)
  cleanup.resolve({ok:true});await stale
  assert.equal(manager.status().phase,'connected');assert.equal(manager.status().connected,true)
  assert.equal(session.active.nodeId,'B')
  await session.clearSession()
})
