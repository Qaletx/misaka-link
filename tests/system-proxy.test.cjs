const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('fs'),os=require('os'),path=require('path')
const {SystemProxy,parseMacProxy}=require('../electron/system-proxy.cjs')
function harness(t,initial) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qaletx-proxy-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const journal=path.join(dir,'recovery.json')
  let state={...initial},fail=false
  const win=async(action,value)=>{
    if(action==='get') return {...state}
    state={...value}
    if(fail) {fail=false;throw new Error('partial failure')}
  }
  return {proxy:new SystemProxy(journal,{platform:'win32',win}),journal,win,get:()=>state,set:value=>state=value,fail:()=>fail=true}
}
test('restores original PAC, discovery flags, bypass and upstream proxy',async t=>{
  const original={flags:13,server:'old.example:8000',bypass:'*.internal',pac:'https://example.invalid/pac'}
  const h=harness(t,original)
  await h.proxy.enable(12000)
  assert.equal(h.get().server,'127.0.0.1:12000')
  assert.equal(h.get().flags,3)
  await h.proxy.restore()
  assert.deepEqual(h.get(),original)
  assert.equal(fs.existsSync(h.journal),false)
})
test('next process restores from disk, including differently ordered object keys',async t=>{
  const original={flags:1,server:'',bypass:'',pac:''}
  const h=harness(t,original)
  await h.proxy.enable(12001)
  h.set({pac:'',bypass:'<local>;localhost;127.*;[::1]',server:'127.0.0.1:12001',flags:3})
  const recovery=new SystemProxy(h.journal,{platform:'win32',win:h.win})
  assert.equal((await recovery.restore()).restored,true)
  assert.deepEqual(h.get(),original)
})
test('preserves proxy settings subsequently changed by another application',async t=>{
  const h=harness(t,{flags:1,server:'',bypass:'',pac:''})
  await h.proxy.enable(12002)
  const foreign={flags:3,server:'127.0.0.1:7890',bypass:'',pac:''}
  h.set(foreign)
  assert.equal((await h.proxy.restore()).externalChange,true)
  assert.deepEqual(h.get(),foreign)
})
test('partially failed enable rolls back and removes its recovery journal',async t=>{
  const original={flags:1,server:'',bypass:'',pac:''}
  const h=harness(t,original);h.fail()
  await assert.rejects(h.proxy.enable(12003),/partial failure/)
  assert.deepEqual(h.get(),original)
  assert.equal(fs.existsSync(h.journal),false)
})
test('empty macOS proxy server does not consume the next field',()=>{
  assert.deepEqual(parseMacProxy('Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0'),{enabled:false,server:'',port:0,authenticated:false})
  assert.deepEqual(parseMacProxy('Enabled: Yes\nServer: 127.0.0.1\nPort: 1080\nAuthenticated Proxy Enabled: 1'),{enabled:true,server:'127.0.0.1',port:1080,authenticated:true})
})
test('third-party bypass additions do not leave a dead local proxy after disconnect',async t=>{
  const original={flags:3,server:'127.0.0.1:10808',bypass:'<local>;10.*;*.internal;security.example',pac:''}
  const h=harness(t,original)
  await h.proxy.enable(12004)
  h.set({...h.get(),bypass:h.get().bypass+';security.example;added.example'})
  assert.equal((await h.proxy.restore()).restored,true)
  assert.equal(h.get().server,original.server)
  assert.equal(h.get().bypass,original.bypass+';added.example')
})
test('restoration preserves a user disabling proxy and editing PAC while replacing our endpoint',async t=>{
  const original={flags:3,server:'old.example:1080',bypass:'<local>;10.*',pac:''}
  const h=harness(t,original)
  await h.proxy.enable(12005)
  h.set({...h.get(),flags:1,pac:'https://example.invalid/changed.pac'})
  await h.proxy.restore()
  assert.equal(h.get().flags,1)
  assert.equal(h.get().server,original.server)
  assert.equal(h.get().pac,'https://example.invalid/changed.pac')
})

test('an old guardian cannot restore or delete a newer owner journal',async t=>{
  const h=harness(t,{flags:1,server:'',bypass:'',pac:''})
  await h.proxy.enable(12004)
  const oldOwner=h.proxy.ownerToken
  await h.proxy.restore()
  const replacement=new SystemProxy(h.journal,{platform:'win32',win:h.win})
  await replacement.enable(12005)
  const oldGuardian=new SystemProxy(h.journal,{platform:'win32',win:h.win})
  assert.equal((await oldGuardian.restore({ownerToken:oldOwner})).differentOwner,true)
  assert.equal(h.get().server,'127.0.0.1:12005')
  assert.equal(JSON.parse(fs.readFileSync(h.journal,'utf8')).ownerToken,replacement.ownerToken)
  await replacement.restore()
})

test('enable waits for in-flight restore and keeps the new journal',async t=>{
  const original={flags:1,server:'',bypass:'',pac:''}
  const h=harness(t,original)
  await h.proxy.enable(12006)
  let release,entered
  const gate=new Promise(resolve=>{release=resolve})
  const snapshotStarted=new Promise(resolve=>{entered=resolve})
  const recovery=new SystemProxy(h.journal,{platform:'win32',win:async(action,value)=>{
    if(action==='get') {entered();await gate}
    return h.win(action,value)
  }})
  const restoring=recovery.restore({ownerToken:h.proxy.ownerToken})
  await snapshotStarted
  const replacement=new SystemProxy(h.journal,{platform:'win32',win:h.win})
  let enabled=false
  const enabling=replacement.enable(12007).then(()=>{enabled=true})
  await new Promise(resolve=>setTimeout(resolve,75))
  assert.equal(enabled,false)
  assert.equal(h.get().server,'127.0.0.1:12006')
  release()
  await restoring
  await enabling
  assert.equal(h.get().server,'127.0.0.1:12007')
  assert.deepEqual(JSON.parse(fs.readFileSync(h.journal,'utf8')).previous,original)
  assert.equal(JSON.parse(fs.readFileSync(h.journal,'utf8')).ownerToken,replacement.ownerToken)
  assert.equal(fs.existsSync(h.journal+'.lock'),false)
  await replacement.restore()
  assert.deepEqual(h.get(),original)
})

test('recovery does not apply or unlink a journal externally replaced during snapshot',async t=>{
  const h=harness(t,{flags:1,server:'',bypass:'',pac:''})
  await h.proxy.enable(12008)
  const replacement={...JSON.parse(fs.readFileSync(h.journal,'utf8')),ownerToken:'another-process'}
  const recovery=new SystemProxy(h.journal,{platform:'win32',win:async(action,value)=>{
    if(action==='get') fs.writeFileSync(h.journal,JSON.stringify(replacement))
    return h.win(action,value)
  }})
  assert.equal((await recovery.restore({ownerToken:h.proxy.ownerToken})).differentOwner,true)
  assert.equal(h.get().server,'127.0.0.1:12008')
  assert.equal(JSON.parse(fs.readFileSync(h.journal,'utf8')).ownerToken,'another-process')
  await h.proxy.restore()
})

test('a live process lock is not reclaimed just because acquisition times out',async t=>{
  const h=harness(t,{flags:1,server:'',bypass:'',pac:''})
  fs.writeFileSync(h.journal+'.lock',JSON.stringify({pid:process.pid,token:'still-live'}))
  const waiting=new SystemProxy(h.journal,{platform:'win32',win:h.win,lockTimeout:80})
  await assert.rejects(waiting.enable(12009),/其他进程/)
  assert.equal(JSON.parse(fs.readFileSync(h.journal+'.lock','utf8')).token,'still-live')
  fs.unlinkSync(h.journal+'.lock')
})

test('an exited process lock can be recovered',async t=>{
  const {spawn}=require('child_process')
  const {once}=require('events')
  const child=spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'})
  await once(child,'exit')
  const h=harness(t,{flags:1,server:'',bypass:'',pac:''})
  fs.writeFileSync(h.journal+'.lock',JSON.stringify({pid:child.pid,token:'stale'}))
  await h.proxy.enable(12010)
  assert.equal(h.get().server,'127.0.0.1:12010')
  await h.proxy.restore()
})

test('a lock held by a different process serializes enable',async t=>{
  const {spawn}=require('child_process')
  const {once}=require('events')
  const h=harness(t,{flags:1,server:'',bypass:'',pac:''})
  const code="const {SystemProxy}=require(process.argv[1]);const p=new SystemProxy(process.argv[2]);p.locked(async()=>{process.stdout.write('locked\\n');await new Promise(r=>process.stdin.once('data',r));}).then(()=>process.exit(0)).catch(()=>process.exit(1));"
  const child=spawn(process.execPath,['-e',code,require.resolve('../electron/system-proxy.cjs'),h.journal],{windowsHide:true,stdio:['pipe','pipe','pipe']})
  t.after(()=>{if(child.exitCode===null && child.signalCode===null) child.kill()})
  await once(child.stdout,'data')
  let enabled=false
  const enabling=h.proxy.enable(12012).then(()=>{enabled=true})
  await new Promise(resolve=>setTimeout(resolve,75))
  assert.equal(enabled,false)
  assert.equal(h.get().server,'')
  const exited=once(child,'exit')
  child.stdin.end('release')
  assert.equal((await exited)[0],0)
  await enabling
  assert.equal(h.get().server,'127.0.0.1:12012')
  await h.proxy.restore()
})

test('macOS restores partially applied owned fields even on a disabled network service',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qaletx-proxy-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const journal=path.join(dir,'recovery.json')
  const original={service:'Wi-Fi',web:{enabled:false,server:'old.proxy',port:8080,authenticated:false},secure:{enabled:false,server:'old.proxy',port:8080,authenticated:false},pac:{url:'https://example.invalid/pac',enabled:true},discovery:true}
  const owned={...original,web:{enabled:true,server:'127.0.0.1',port:12011,authenticated:false},secure:{enabled:true,server:'127.0.0.1',port:12011,authenticated:false},pac:{...original.pac,enabled:false},discovery:false}
  const actual={...original,web:{...owned.web}}
  fs.writeFileSync(journal,JSON.stringify({platform:'darwin',ownerToken:'old-app',previous:[original],owned:[owned]}))
  const commands=[]
  const describe=value=>'Enabled: '+(value.enabled?'Yes':'No')+'\nServer: '+value.server+'\nPort: '+value.port+'\nAuthenticated Proxy Enabled: 0'
  const mac=async(...args)=>{
    commands.push(args)
    switch(args[0]) {
      case '-listallnetworkservices': return 'An asterisk denotes a disabled service.\n*Wi-Fi'
      case '-getwebproxy': return describe(actual.web)
      case '-getsecurewebproxy': return describe(actual.secure)
      case '-getautoproxyurl': return 'URL: '+actual.pac.url+'\nEnabled: Yes'
      case '-getproxyautodiscovery': return 'Auto Proxy Discovery: On'
      default: return ''
    }
  }
  const proxy=new SystemProxy(journal,{platform:'darwin',mac})
  assert.equal((await proxy.restore({ownerToken:'old-app'})).restored,true)
  assert.ok(commands.some(args=>args[0]==='-setwebproxy' && args[2]==='old.proxy'))
  assert.ok(commands.some(args=>args[0]==='-setwebproxystate' && args[2]==='off'))
  assert.ok(!commands.some(args=>args[0].startsWith('-setsecure')))
  assert.ok(!commands.some(args=>args[0].startsWith('-setautoproxy')))
  assert.ok(!fs.existsSync(journal))
})
