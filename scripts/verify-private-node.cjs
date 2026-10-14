// Explicit, read-only network smoke check; never switches the operating system proxy.
const fs=require('fs'),os=require('os'),path=require('path')
const {spawn,execFileSync}=require('child_process')
const {singBoxConfig}=require('../electron/protocols.cjs')
const {controller,freePort}=require('../electron/core-manager.cjs')
const crypto=require('crypto')
async function run() {
  const uri=require('../electron/private-node.cjs').misaka
  if(!uri) throw new Error('No private node configured')
  const binary=path.join(__dirname,'..','core',process.platform==='win32'?'sing-box.exe':`sing-box-${process.arch==='arm64'?'arm64':'amd64'}`)
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qaletx-network-check-'))
  let child
  try {
    const port=await freePort(); let apiPort=await freePort();while(apiPort===port) apiPort=await freePort()
    const secret=crypto.randomBytes(32).toString('hex')
    const config=path.join(directory,'config.json')
    fs.writeFileSync(config,singBoxConfig(uri,{port,apiPort,apiSecret:secret}),{mode:0o600})
    execFileSync(binary,['check','-c',config],{stdio:'ignore',windowsHide:true,timeout:8000})
    child=spawn(binary,['run','-c',config],{stdio:'ignore',windowsHide:true})
    const deadline=Date.now()+8000
    while(true) {
      try{await controller(apiPort,secret,'/version',500);break}catch{if(Date.now()>deadline) throw new Error('Core readiness timeout');await new Promise(r=>setTimeout(r,150))}
    }
    const result=await controller(apiPort,secret,`/proxies/proxy/delay?url=${encodeURIComponent('https://www.gstatic.com/generate_204')}&timeout=10000`,11000)
    if(!Number.isFinite(result.delay)) throw new Error('Invalid delay response')
    console.log(JSON.stringify({privateNodeReachable:true,delayMs:result.delay,systemProxyChanged:false}))
  } finally {
    if(child) {const closed=new Promise(r=>child.once('exit',r));child.kill();await closed}
    fs.rmSync(directory,{recursive:true,force:true})
  }
}
run().catch(()=>{console.error('Private node check failed (address and credentials redacted).');process.exitCode=1})
