// Runs independently of the Electron UI to recover a proxy after an abrupt app exit.
const {SystemProxy}=require('./system-proxy.cjs')
const [parent,core,journal,ownerToken]=process.argv.slice(2)
const parentPid=Number(parent),corePid=Number(core)
if(!Number.isInteger(parentPid)||parentPid<=0||!Number.isInteger(corePid)||corePid<=0||!journal||!ownerToken) process.exit(1)
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
let restoring=false
const timer=setInterval(async()=>{
  if(restoring||alive(parentPid)) return
  restoring=true; clearInterval(timer)
  try{if(alive(corePid)) process.kill(corePid)}catch{}
  try { await new SystemProxy(journal).restore({ownerToken}); process.exit(0) }
  catch { process.exit(1) } // Journal stays on disk for recovery at next launch.
},1000)
process.stdout.write('ready\n')
