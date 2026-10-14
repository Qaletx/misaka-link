const {test}=require('node:test')
const assert=require('node:assert/strict')
const {EventEmitter}=require('node:events')
const {ConnectionController}=require('../electron/connection-controller.cjs')
const pause=ms=>new Promise(r=>setTimeout(r,ms))
function fixture(t){
  const manager=new EventEmitter();manager.value={phase:'idle',connected:false};manager.status=()=>({...manager.value});manager.update=patch=>{Object.assign(manager.value,patch);manager.emit('status',manager.status())}
  manager.checkHealth=async()=>({ok:true});manager.log=()=>{}
  const state={starts:[],stops:0,probes:0,online:true,saved:[]}
  const account={current:{user:{role:'user'}},cancelRequests(){},request:async()=>({nodes:[{id:'one',name:'One'},{id:'two',name:'Two'}]}),resolve:async p=>({...p,uri:`socks5://localhost:${p.nodeId==='two'?2222:1111}`})}
  const session={account,setSession:async()=>({ok:true,user:{username:'test'}}),disconnect:async()=>{state.stops++;manager.update({phase:'idle',connected:false});return {ok:true}},clearSession:async()=>{account.current=null;return{ok:true}},connect:async p=>{state.starts.push(p);manager.update({phase:'connected',connected:true,nodeId:p.nodeId});return {ok:true}},createProbe:()=>({closed:false,test:async uri=>{state.probes++;return{ok:true,latencyMs:uri.includes('2222')?20:100}},async close(){this.closed=true}})}
  const control=new ConnectionController({manager,session,preferences:{autoRecover:true,automatic:false,selections:{}},save:p=>state.saved.push(p),online:()=>state.online,healthInterval:100000,networkInterval:100000})
  t.after(()=>control.close());return {control,manager,session,state}
}
test('default manual selection and wakeup restore the original node; explicit disconnect clears recovery intent',async t=>{
  const {control,state}=fixture(t);await control.connect({nodeId:'one'});assert.equal(state.probes,0)
  await control.suspend();control.resume();clearTimeout(control.retryTimer);control.retryTimer=null
  await control.recover(control.epoch);assert.equal(state.starts.at(-1).nodeId,'one')
  await control.disconnect();control.resume();assert.equal(control.retryTimer,null);assert.equal(control.intent,null)
})
test('automatic mode tests authorized nodes and uses the successful lower-latency candidate',async t=>{
  const {control,state}=fixture(t);control.configure({automatic:true});await control.connect({nodeId:'one'})
  assert.equal(state.probes,2);assert.equal(state.starts.at(-1).nodeId,'two')
})
test('explicit manual selection is honored even in automatic mode, until automatic selection is requested again',async t=>{
  const {control,state}=fixture(t);control.configure({automatic:true});control.select({nodeId:'one',manual:true})
  await control.connect({nodeId:'one'});assert.equal(state.probes,0);assert.equal(state.starts.at(-1).nodeId,'one')
  control.configure({automatic:true});await control.connect({nodeId:'one'});assert.equal(state.starts.at(-1).nodeId,'two')
})
test('core and account outages emitted after cleanup still schedule recovery',async t=>{
  const {control,manager}=fixture(t);await control.connect({nodeId:'one'})
  manager.update({phase:'idle',connected:false});manager.update({phase:'error',errorCode:'ACCOUNT_OFFLINE',error:'无法验证线路授权'})
  assert.ok(control.retryTimer);assert.ok(control.intent);assert.equal(control.retryCount,1)
  await control.disconnect();await control.connect({nodeId:'one'})
  manager.update({phase:'idle',connected:false});manager.update({phase:'error',errorCode:'CORE_EXIT',error:'核心意外退出'})
  assert.ok(control.retryTimer);assert.ok(control.intent)
})
test('a newer connect supersedes an older request waiting for cleanup',async t=>{
  const {control,session,state}=fixture(t)
  const original=session.disconnect;let release
  session.disconnect=async()=>{if(!release)await new Promise(r=>release=r);return original()}
  const first=control.connect({nodeId:'one'});await pause(0)
  const second=control.connect({nodeId:'two'});release()
  assert.equal((await first).ok,false);assert.equal((await second).ok,true)
  assert.deepEqual(state.starts.map(x=>x.nodeId),['two']);assert.equal(control.intent.nodeId,'two')
})
test('cancellation during auto selection cannot launch a late connection',async t=>{
  const {control,session,state}=fixture(t);control.configure({automatic:true});const releases=[]
  session.createProbe=()=>({closed:false,test:async()=>{await new Promise(r=>releases.push(r));return {ok:true,latencyMs:1}},async close(){this.closed=true;releases.forEach(r=>r())}})
  const pending=control.connect({nodeId:'one'});await pause(5);await control.disconnect();await pending
  assert.equal(state.starts.length,0);assert.equal(control.intent,null)
})
test('authorization and quota failures stop automatic recovery rather than switch around a restriction',async t=>{
  const {control,manager}=fixture(t);await control.connect({nodeId:'one'})
  manager.update({phase:'idle',connected:false});manager.update({phase:'error',errorCode:'AUTH_STOP',error:'授权已失效'})
  control.resume();assert.equal(control.intent,null);assert.equal(control.retryTimer,null)
})
test('failed proxy cleanup blocks recovery, preserving the journal and avoiding another startup',async t=>{
  const {control,session,state}=fixture(t);await control.connect({nodeId:'one'});session.disconnect=async()=>({ok:false,message:'系统代理恢复失败'})
  await control.recover(control.epoch);assert.equal(state.starts.length,1);assert.equal(control.intent,null)
})
