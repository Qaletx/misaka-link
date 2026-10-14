'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),crypto=require('node:crypto')
const {spawn,execFileSync}=require('node:child_process')
const {NodeProbe}=require('../electron/node-probe.cjs')
const root=path.join(__dirname,'..'),binary=process.env.QALETX_TEST_HYSTERIA||path.join(root,'test-artifacts','hysteria-windows-amd64.exe')
const core=path.join(root,'core','sing-box.exe'),pause=ms=>new Promise(r=>setTimeout(r,ms))
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port}
test('real Hysteria2, standalone account server and sing-box prove managed credentials, real accounting and quota rejection',{skip:process.platform!=='win32'||!fs.existsSync(binary)||!fs.existsSync(core)},async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'qaletx-managed-real-')),children=[]
  t.after(async()=>{
    for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(()=>{try{child.kill('SIGKILL')}catch{};r()},1500).unref()})}
    const resolved=path.resolve(folder);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('qaletx-managed-real-'));fs.rmSync(folder,{recursive:true,force:true})
  })
  execFileSync('python',['-c',`from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
import datetime,ipaddress,sys,pathlib
p=pathlib.Path(sys.argv[1]);key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
now=datetime.datetime.now(datetime.timezone.utc)
cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(days=1)).not_valid_after(now+datetime.timedelta(days=2)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(key,hashes.SHA256())
(p/'test.crt').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
(p/'test.key').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.TraditionalOpenSSL,serialization.NoEncryption()))`,folder],{windowsHide:true,stdio:'ignore'})
  const [port,authPort,statsPort,hyPort]=await Promise.all([freePort(),freePort(),freePort(),freePort()])
  const url=`http://127.0.0.1:${port}`,secret=crypto.randomBytes(20).toString('hex')
  fs.copyFileSync(path.join(root,'server.js'),path.join(folder,'server.js'))
  fs.writeFileSync(path.join(folder,'.env'),[`MISAKA_HOST=127.0.0.1`,`MISAKA_PORT=${port}`,`MISAKA_TOKEN_SECRET=${crypto.randomBytes(32).toString('hex')}`,'MISAKA_ROOT_PASSWORD=isolated-root-123456','MISAKA_USER_PASSWORD=isolated-user-123456',`MISAKA_PRIVATE_NODE_URI=hysteria2://obsolete@127.0.0.1:${hyPort}?sni=localhost&insecure=1`,`MISAKA_HY2_AUTH_PORT=${authPort}`,'MISAKA_HY2_POLL_MS=250',`MISAKA_HY2_SERVICES=${JSON.stringify([{id:'primary',statsUrl:`http://127.0.0.1:${statsPort}`,secret}])}`].join('\n'))
  const environment={...process.env};for(const key of Object.keys(environment))if(key.startsWith('MISAKA_'))delete environment[key]
  const server=spawn(process.execPath,[path.join(folder,'server.js')],{env:environment,windowsHide:true,stdio:'ignore'});children.push(server)
  const until=async fn=>{for(let i=0;i<100;i++){try{const value=await fn();if(value)return value}catch{}await pause(50)}assert.fail('isolated managed integration did not become ready')}
  const request=async(endpoint,method='GET',body,token)=>{const r=await fetch(url+endpoint,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(3000)});return{status:r.status,data:await r.json()}}
  await until(async()=>(await request('/api/health')).status===200)
  const admin=(await request('/api/login','POST',{username:'root',password:'isolated-root-123456'})).data.token
  const user=(await request('/api/login','POST',{username:'user',password:'isolated-user-123456'})).data.token
  assert.equal((await request('/api/users/user','PATCH',{privateNodeAccess:true,privateNodeIds:['misaka']},admin)).status,200)
  assert.equal((await request('/api/private-nodes/misaka','PATCH',{revision:1,managedServiceId:'primary'},admin)).status,200)
  assert.equal((await fetch(`http://127.0.0.1:${authPort}/boot/primary`,{method:'POST',body:'{}'})).status,200)
  const yaml=`listen: 127.0.0.1:${hyPort}\ntls:\n  cert: ${JSON.stringify(path.join(folder,'test.crt').replaceAll('\\','/'))}\n  key: ${JSON.stringify(path.join(folder,'test.key').replaceAll('\\','/'))}\nauth:\n  type: http\n  http:\n    url: http://127.0.0.1:${authPort}/auth/primary\ntrafficStats:\n  listen: 127.0.0.1:${statsPort}\n  secret: ${secret}\n`
  fs.writeFileSync(path.join(folder,'hysteria.yaml'),yaml)
  const hy=spawn(binary,['server','-c',path.join(folder,'hysteria.yaml')],{windowsHide:true,stdio:'ignore'});children.push(hy)
  await until(async()=>(await request('/api/me/usage','GET',undefined,user)).data.usage.live)
  const target=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/octet-stream'});res.end(Buffer.alloc(1024*1024,65))})
  await new Promise(r=>target.listen(0,'127.0.0.1',r));t.after(()=>{target.closeAllConnections();return new Promise(r=>target.close(r))})
  const probe=new NodeProbe({binary:core,directory:path.join(folder,'probes'),probeUrls:[`http://127.0.0.1:${target.address().port}/payload`]});t.after(()=>probe.close())
  const config=(await request('/api/nodes/misaka/config','GET',undefined,user)).data
  assert.match(new URL(config.uri).username,/^ql1\./)
  assert.equal((await probe.test(config.uri)).ok,true,'managed session credentials must establish an actual QUIC proxy')
  const usage=await until(async()=>{const u=(await request('/api/me/usage','GET',undefined,user)).data.usage;return u.usedBytes>0?u:null})
  assert.ok(usage.uploadBytes>0&&usage.downloadBytes>0,'both directions must come from real Hysteria counters')
  await request('/api/users/user/quota','PATCH',{quotaBytes:1},admin)
  assert.equal((await request('/api/nodes/misaka/config','GET',undefined,user)).data.code,'QUOTA_EXCEEDED')
  assert.equal((await probe.test(config.uri)).ok,false,'reusing the old credential outside the config API must still be denied by Hysteria authentication')
  await request('/api/users/user/quota','PATCH',{quotaBytes:null},admin)
  assert.equal((await probe.test(config.uri)).ok,true,'removing the limit allows the same still-authorized session to connect again')
  await request('/api/users/user','PATCH',{privateNodeAccess:false,privateNodeIds:[]},admin)
  assert.equal((await probe.test(config.uri)).ok,false,'revocation must also deny a credential already copied to another client')
  await request('/api/users/user','PATCH',{privateNodeAccess:true,privateNodeIds:['misaka']},admin)
  assert.equal((await probe.test(config.uri)).ok,true,'regrant must not reuse a lingering kick identity')
})
