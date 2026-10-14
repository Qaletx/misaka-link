const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execute = promisify(execFile)

async function win(action, settings) {
  const file = path.join(__dirname, 'windows-proxy.ps1').replace('app.asar'+path.sep, 'app.asar.unpacked'+path.sep)
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file], {windowsHide:true,timeout:15000}, (error, stdout) => {
      if(error) return reject(new Error('Windows 系统代理操作失败，请检查 PowerShell 与系统权限'))
      try { resolve(JSON.parse(stdout.trim())) } catch { reject(new Error('Windows 系统代理返回无效数据')) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({action,settings}))
  })
}
async function mac(...args) {
  const {stdout,stderr} = await execute('/usr/sbin/networksetup', args, {timeout:10000})
  if(/error|not a valid|authorization/i.test(stdout+stderr)) throw new Error('macOS 系统代理操作失败，请检查网络设置权限')
  return stdout.trim()
}
function parseMacProxy(output) {
  return {enabled:/^Enabled:[ \t]*Yes/im.test(output),server:output.match(/^Server:[ \t]*([^\r\n]*)/im)?.[1]?.trim()||'',port:Number(output.match(/^Port:[ \t]*(\d+)/im)?.[1]||0),authenticated:/Authenticated Proxy Enabled:[ \t]*(1|Yes)/i.test(output)}
}
function equal(a,b) {
  if(a===b) return true
  if(!a || !b || typeof a!=='object' || typeof b!=='object') return false
  const keys=Object.keys(a)
  return keys.length===Object.keys(b).length && keys.every(k=>equal(a[k],b[k]))
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function processAlive(pid) {
  if(!Number.isInteger(pid) || pid<=0) return true // Malformed locks must not be discarded.
  try { process.kill(pid,0); return true } catch(error) { return error.code!=='ESRCH' }
}
class SystemProxy {
  constructor(journal, options={}) {
    this.journal=journal; this.platform=options.platform||process.platform; this.win=options.win||win; this.mac=options.mac||mac
    this.ownerToken=options.ownerToken||crypto.randomBytes(24).toString('hex')
    this.lockPath=journal+'.lock'
    this.lockTimeout=options.lockTimeout||120000
  }
  async locked(operation) {
    fs.mkdirSync(path.dirname(this.journal),{recursive:true})
    const token=crypto.randomBytes(24).toString('hex')
    const deadline=Date.now()+this.lockTimeout
    const candidate=this.lockPath+'.'+process.pid+'.'+token+'.candidate'
    // Publish a complete owner record atomically. Dying between open and write
    // must not leave an empty lock that no recovery process can identify.
    let descriptor
    try {
      descriptor=fs.openSync(candidate,'wx',0o600)
      fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,token}))
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor);descriptor=undefined
      for(;;) {
        try { fs.linkSync(candidate,this.lockPath); break }
        catch(error) {
          if(error.code!=='EEXIST') throw error
          try {
            const content=fs.readFileSync(this.lockPath,'utf8')
            const owner=JSON.parse(content)
            // Never remove a lock by age: a slow networksetup call may still own it.
            if(typeof owner.token==='string' && !processAlive(owner.pid)
              && fs.readFileSync(this.lockPath,'utf8')===content) fs.unlinkSync(this.lockPath)
          } catch(error) { if(error.code && error.code!=='ENOENT') throw error }
          if(Date.now()>=deadline) throw new Error('系统代理正由其他进程处理，请稍后重试')
          await pause(50)
        }
      }
    } finally {
      if(descriptor!==undefined) fs.closeSync(descriptor)
      if(fs.existsSync(candidate)) fs.unlinkSync(candidate)
    }
    try { return await operation() }
    finally {
      try {
        const owner=JSON.parse(fs.readFileSync(this.lockPath,'utf8'))
        if(owner.pid===process.pid && owner.token===token) fs.unlinkSync(this.lockPath)
      } catch(error) { if(error.code!=='ENOENT') throw error }
    }
  }
  async snapshot(includeServices) {
    if(this.platform==='win32') return this.win('get')
    if(this.platform!=='darwin') throw new Error('目前只支持 Windows 与 macOS 系统代理')
    // Capture all enabled services so switching Wi-Fi/Ethernet does not lose protection.
    const listed=(await this.mac('-listallnetworkservices')).split(/\r?\n/).slice(1).filter(Boolean)
    const services=includeServices ? listed.map(s=>s.replace(/^\*/, '')).filter(s=>includeServices.includes(s)) : listed.filter(s=>!s.startsWith('*'))
    const result=[]
    for(const service of services) {
      const web=parseMacProxy(await this.mac('-getwebproxy',service))
      const secure=parseMacProxy(await this.mac('-getsecurewebproxy',service))
      const pacText=await this.mac('-getautoproxyurl',service)
      result.push({service,web,secure,pac:{url:pacText.match(/^URL:[ \t]*([^\r\n]*)/m)?.[1]||'',enabled:/Enabled:[ \t]*Yes/i.test(pacText)},discovery:/On/i.test(await this.mac('-getproxyautodiscovery',service))})
    }
    if(!result.length && !includeServices) throw new Error('未找到可配置的网络服务')
    return result
  }
  async apply(state, fields) {
    if(this.platform==='win32') { await this.win('set',state); return }
    for(const s of state) {
      for(const [kind,value] of [['web',s.web],['secureweb',s.secure]]) {
        if(fields && !fields.includes(kind)) continue
        if(value.server && value.port) await this.mac(`-set${kind}proxy`,s.service,value.server,String(value.port))
        await this.mac(`-set${kind}proxystate`,s.service,value.enabled?'on':'off')
      }
      if(!fields || fields.includes('pac')) {
        if(s.pac.url && s.pac.url!=='(null)') await this.mac('-setautoproxyurl',s.service,s.pac.url)
        await this.mac('-setautoproxystate',s.service,s.pac.enabled?'on':'off')
      }
      if(!fields || fields.includes('discovery')) await this.mac('-setproxyautodiscovery',s.service,s.discovery?'on':'off')
    }
  }
  enable(port) { return this.locked(()=>this._unlockedEnable(port)) }
  async _unlockedEnable(port) {
    if(fs.existsSync(this.journal)) await this._unlockedRestore()
    const previous=await this.snapshot()
    if(this.platform==='darwin' && previous.some(s=>s.web.authenticated||s.secure.authenticated)) throw new Error('现有 macOS 代理使用身份验证，请先在系统设置清除代理认证后重试')
    const owned=this.platform==='win32' ? {flags:3,server:`127.0.0.1:${port}`,bypass:'<local>;localhost;127.*;[::1]',pac:''} : previous.map(s=>({...s,web:{enabled:true,server:'127.0.0.1',port,authenticated:false},secure:{enabled:true,server:'127.0.0.1',port,authenticated:false},pac:{...s.pac,enabled:false},discovery:false}))
    fs.mkdirSync(path.dirname(this.journal),{recursive:true})
    fs.writeFileSync(this.journal,JSON.stringify({platform:this.platform,ownerToken:this.ownerToken,ownerPid:process.pid,previous,owned}),{mode:0o600})
    try { await this.apply(owned) } catch(error) {
      // The write may have failed halfway through; roll back every captured field.
      try { await this.apply(previous); fs.unlinkSync(this.journal) } catch {}
      throw error
    }
  }
  restore(options={}) { return this.locked(()=>this._unlockedRestore(options)) }
  async _unlockedRestore(options={}) {
    if(!fs.existsSync(this.journal)) return {restored:false}
    const record=fs.readFileSync(this.journal,'utf8')
    const {platform,ownerToken,previous,owned}=JSON.parse(record)
    if(options.ownerToken && options.ownerToken!==ownerToken) return {restored:false,differentOwner:true}
    if(platform!==this.platform) throw new Error('代理恢复记录不属于此操作系统')
    const current=await this.snapshot(this.platform==='darwin'?previous.map(s=>s.service):undefined)
    // All supported writers hold the lock. Also fail closed if an external writer
    // replaced the journal while the OS snapshot was in progress.
    if(!fs.existsSync(this.journal) || fs.readFileSync(this.journal,'utf8')!==record) return {restored:false,differentOwner:true}
    let restored=false
    if(this.platform==='win32') {
      // Security software can append bypass entries while our endpoint stays
      // active. Endpoint ownership must not depend on an exact bypass string,
      // otherwise disconnect leaves the OS pointing to our now-dead port.
      if(current.server===owned.server) {
        const entries=value=>String(value||'').split(';').map(s=>s.trim()).filter(Boolean)
        const ownedBypass=new Set(entries(owned.bypass)),currentBypass=new Set(entries(current.bypass))
        const removed=new Set([...ownedBypass].filter(item=>!currentBypass.has(item)))
        const additions=[...currentBypass].filter(item=>!ownedBypass.has(item))
        const bypass=[...new Set([...entries(previous.bypass).filter(item=>!removed.has(item)),...additions])].join(';')
        await this.apply({
          ...previous,
          flags:current.flags===owned.flags?previous.flags:current.flags,
          pac:current.pac===owned.pac?previous.pac:current.pac,
          bypass:current.bypass===owned.bypass?previous.bypass:bypass
        })
        restored=true
      }
    } else {
      // Restore each owned field independently. A crash during multi-command
      // networksetup changes may leave only HTTP configured, while HTTPS or PAC
      // are unchanged. Disabled services still need their saved fields restored.
      for(const original of previous) {
        const actual=current.find(s=>s.service===original.service)
        const expected=owned.find(s=>s.service===original.service)
        if(!actual || !expected) continue
        const fields=[]
        if(equal(actual.web,expected.web)) fields.push('web')
        if(equal(actual.secure,expected.secure)) fields.push('secureweb')
        if(equal(actual.pac,expected.pac)) fields.push('pac')
        if(actual.discovery===expected.discovery) fields.push('discovery')
        if(fields.length) { await this.apply([original],fields); restored=true }
      }
    }
    if(fs.existsSync(this.journal) && fs.readFileSync(this.journal,'utf8')===record) fs.unlinkSync(this.journal)
    return {restored,externalChange:!restored}
  }
}
module.exports={SystemProxy,parseMacProxy}
