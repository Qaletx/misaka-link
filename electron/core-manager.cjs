const fs = require('fs')
const path = require('path')
const http = require('http')
const net = require('net')
const crypto = require('crypto')
const {EventEmitter} = require('events')
const {spawn,execFile} = require('child_process')
const {promisify} = require('util')
const {singBoxConfig} = require('./protocols.cjs')
const execute = promisify(execFile)
const pause = ms => new Promise(r=>setTimeout(r,ms))

function freePort() {
  return new Promise((resolve,reject)=>{
    const server=net.createServer()
    server.once('error',reject)
    server.listen(0,'127.0.0.1',()=>{ const port=server.address().port; server.close(()=>resolve(port)) })
  })
}
function reservePort(port) {
  return new Promise((resolve,reject)=>{
    // This temporary listener only reserves the port. Other applications may
    // still try to use the previous proxy endpoint while we validate a node.
    // Never retain those sockets: server.close() waits for every client to end.
    const sockets=new Set()
    const server=net.createServer(socket=>{
      sockets.add(socket)
      socket.on('error',()=>{})
      socket.on('close',()=>sockets.delete(socket))
      socket.destroy()
    })
    server.once('error',()=>reject(new Error(`本地代理端口 ${port} 已被占用或无法使用，请关闭占用该端口的软件后重试`)))
    server.listen({port,host:'127.0.0.1',exclusive:true},()=>{
      let closing
      resolve(()=>{
        if(closing) return closing
        closing=new Promise((done,fail)=>{
          const timer=setTimeout(()=>fail(new Error(`释放本地代理端口 ${port} 超时，请重试`)),2000)
          server.close(error=>{clearTimeout(timer);error?fail(error):done()})
          for(const socket of sockets) socket.destroy()
        })
        return closing
      })
    })
  })
}
function controller(port,secret,route,timeout=2500,signal) {
  return new Promise((resolve,reject)=>{
    const request=http.get({host:'127.0.0.1',port,path:route,headers:{Authorization:`Bearer ${secret}`},timeout,signal},res=>{
      let body=''
      res.on('data',chunk=>{body+=chunk; if(body.length>1048576) request.destroy(new Error('核心响应过大'))})
      res.on('end',()=>{
        if(res.statusCode!==200) return reject(new Error('核心请求未成功'))
        try { resolve(JSON.parse(body)) } catch { reject(new Error('核心响应无效')) }
      })
      res.on('error',reject)
    })
    request.on('timeout',()=>request.destroy(new Error('核心请求超时')))
    request.on('error',reject)
  })
}
function httpProbe(port,url,timeout=7000,signal) {
  // sing-box's delay API replaces plain HTTP URLs with its public HTTPS default.
  // Explicit HTTP probes instead traverse the mixed inbound (global mode only),
  // which also permits isolated local integration checks without internet access.
  const target=new URL(url)
  return new Promise((resolve,reject)=>{
    const request=http.get({host:'127.0.0.1',port,path:target.href,headers:{Host:target.host},agent:false,timeout,signal},res=>{
      res.on('error',reject)
      res.resume()
      if(res.statusCode>=200 && res.statusCode<300) resolve()
      else reject(new Error('探测地址没有返回成功状态'))
    })
    request.on('timeout',()=>request.destroy(new Error('节点探测超时')))
    request.on('error',reject)
  })
}
class CoreManager extends EventEmitter {
  constructor(options) {
    super()
    Object.assign(this,{binary:options.binary,directory:options.directory,proxy:options.proxy,onSpawn:options.onSpawn||(()=>null)})
    this.proxyPort=options.proxyPort===undefined?10808:options.proxyPort
    if(!Number.isInteger(this.proxyPort)||this.proxyPort<1||this.proxyPort>65535) throw new Error('本地代理端口必须为 1–65535 之间的整数')
    this.probeUrls=options.probeUrls||['https://www.gstatic.com/generate_204','https://www.apple.com/library/test/success.html']
    this.queue=Promise.resolve(); this.child=null; this.logs=[]; this.timer=null; this.guardian=null; this.cancel=false; this.cancelEpoch=0; this.connectionAbort=null
    this.state={phase:'idle',stage:'',stageStartedAt:null,timings:[],connected:false,nodeId:null,name:'',startedAt:null,up:0,down:0,error:'',errorCode:'',systemProxy:false,mode:'global',port:this.proxyPort}
  }
  status() { return {...this.state} }
  update(patch) {
    if('stage' in patch && patch.stage!==this.state.stage) {
      const now=Date.now()
      if(this.state.stage&&this.state.stageStartedAt) this.state.timings=[...this.state.timings,{stage:this.state.stage,durationMs:Math.max(0,now-this.state.stageStartedAt)}].slice(-12)
      patch.stageStartedAt=patch.stage?now:null
    }
    Object.assign(this.state,patch); this.emit('status',this.status())
  }
  async checkHealth(signal) {
    if(!this.state.connected||!this.api) return {ok:false}
    for(const url of this.probeUrls) {
      if(signal?.aborted) return {ok:false}
      try {
        if(url.startsWith('http://')) await httpProbe(this.proxyPort,url,5000,signal)
        else {const result=await controller(this.api.port,this.api.secret,`/proxies/proxy/delay?url=${encodeURIComponent(url)}&timeout=5000`,5500,signal);if(!Number.isFinite(result.delay)||result.delay<0)throw new Error('连通性响应无效')}
        return {ok:true,checkedAt:Date.now()}
      } catch { if(signal?.aborted) return {ok:false} }
    }
    return {ok:false,checkedAt:Date.now()}
  }
  log(level,message) { this.logs.push({time:new Date().toISOString(),level,message}); if(this.logs.length>150) this.logs.shift() }
  serial(operation) { const result=this.queue.then(operation,operation); this.queue=result.catch(()=>{}); return result }
  connect(payload) {
    const epoch=this.cancelEpoch
    return this.serial(()=>this.start(payload,epoch))
  }
  disconnect() { this.cancel=true; this.cancelEpoch++; this.connectionAbort?.abort(); return this.serial(()=>this.stop()) }
  async checkPort() {
    try { const release=await reservePort(this.proxyPort); await release(); return {ok:true} }
    catch(error) { return {ok:false,message:error.message} }
  }
  alive() {
    if(this.cancel) throw new Error('连接已取消')
    if(!this.child || this.child.exitCode!==null || this.child.signalCode!==null || this.spawnFailed) throw new Error('代理核心启动失败或已退出')
  }
  async start(payload,epoch=this.cancelEpoch) {
    const previous=await this.stop(false)
    // A queued request can be cancelled before it starts. Never clear a newer
    // cancellation, nor replace a core while its system proxy cannot be restored.
    if(!previous.ok) return previous
    if(epoch!==this.cancelEpoch) return {ok:false,message:'连接已取消'}
    const abort=new AbortController(); this.connectionAbort=abort
    this.cancel=false
    this.update({phase:'connecting',stage:'正在校验线路',connected:false,error:'',nodeId:payload.id||payload.privateId||null,name:payload.name||'节点',up:0,down:0,startedAt:null,mode:payload.mode||'global'})
    let configPath,releasePort
    try {
      if(!this.binary || !fs.existsSync(this.binary)) throw new Error('安装包缺少代理核心，请重新安装完整版本')
      const port=this.proxyPort
      releasePort=await reservePort(port)
      let apiPort=await freePort()
      while(apiPort===port) apiPort=await freePort()
      const secret=crypto.randomBytes(32).toString('hex')
      this.api={port:apiPort,secret}
      const config=singBoxConfig(payload.uri,{port,apiPort,apiSecret:secret,mode:payload.mode||'global'})
      fs.mkdirSync(this.directory,{recursive:true})
      configPath=path.join(this.directory,`session-${crypto.randomBytes(8).toString('hex')}.json`)
      fs.writeFileSync(configPath,config,{mode:0o600})
      try { await execute(this.binary,['check','-c',configPath],{windowsHide:true,timeout:8000,maxBuffer:65536,signal:abort.signal}) }
      catch { throw new Error(abort.signal.aborted?'连接已取消':'节点配置未通过核心校验，请检查协议和链接参数') }
      if(this.cancel) throw new Error('连接已取消')
      this.spawnFailed=false
      await releasePort(); releasePort=null
      this.update({stage:'正在启动代理核心'})
      const child=spawn(this.binary,['run','-c',configPath],{windowsHide:true,stdio:['ignore','ignore','pipe']})
      this.child=child
      // Do not forward raw core errors: they can contain node addresses and credentials.
      child.stderr.on('data',()=>{})
      child.once('error',()=>{this.spawnFailed=true})
      child.once('exit',()=>{
        if(this.child!==child || this.state.phase!=='connected') return
        this.serial(async()=>{
          if(this.child!==child) return
          await this.stop(false)
          this.update({phase:'error',error:'代理核心意外退出，已尝试恢复系统代理',errorCode:'CORE_EXIT'})
          this.log('error','代理核心意外退出')
        }).catch(()=>{})
      })
      this.guardian=await this.onSpawn(child.pid)
      const deadline=Date.now()+8000
      let ready=false
      while(Date.now()<deadline) {
        this.alive()
        try { await controller(apiPort,secret,'/version',600,abort.signal); ready=true; break } catch { if(abort.signal.aborted) throw new Error('连接已取消'); await pause(150) }
      }
      if(!ready) throw new Error('代理核心未能就绪，请重试')
      // A listening port does not prove the upstream node works. Test through the outbound.
      this.update({stage:'正在测试线路连通性'})
      let reachable=false
      for(const url of this.probeUrls) {
        this.alive()
        try {
          if(url.startsWith('http://')) {
            if((payload.mode||'global')!=='global') throw new Error('HTTP 探测仅适用于全局模式')
            await httpProbe(port,url,5000,abort.signal)
            reachable=true; break
          } else {
            const result=await controller(apiPort,secret,`/proxies/proxy/delay?url=${encodeURIComponent(url)}&timeout=5000`,5500,abort.signal)
            if(Number.isFinite(result.delay) && result.delay>=0) { reachable=true; break }
          }
        } catch { if(abort.signal.aborted) throw new Error('连接已取消') }
      }
      this.alive()
      if(!reachable) throw new Error('节点连通性检测失败，请检查网络或更换节点后重试')
      this.update({stage:'正在设置系统代理'})
      await this.proxy.enable(port)
      this.alive()
      this.update({phase:'connected',stage:'',connected:true,systemProxy:true,startedAt:Date.now(),error:''})
      this.log('info','节点连通性检测通过，系统代理已开启')
      let polling=false,failures=0
      this.timer=setInterval(async()=>{
        if(polling || this.state.phase!=='connected' || this.child!==child) return
        polling=true
        try {
          const data=await controller(apiPort,secret,'/connections')
          if(this.child===child && this.state.phase==='connected') this.update({up:Number(data.uploadTotal)||0,down:Number(data.downloadTotal)||0})
          failures=0
        } catch {
          if(++failures>=3 && this.child===child) this.serial(async()=>{
            if(this.child!==child) return
            await this.stop(false)
            this.update({phase:'error',error:'代理核心失去响应，已尝试恢复系统代理',errorCode:'CORE_UNRESPONSIVE'})
          }).catch(()=>{})
        } finally { polling=false }
      },1500)
      return {ok:true,message:'已连接，系统代理已开启'}
    } catch(error) {
      const message=error.message||'连接失败'
      const stopped=await this.stop(false)
      this.update({phase:'error',stage:'',error:stopped.ok?message:`${message}；${stopped.message}`})
      this.log('error',this.state.error)
      return {ok:false,message:this.state.error}
    } finally {
      if(releasePort) try { await releasePort() } catch(error) { this.log('warn',error.message) }
      if(configPath) try { fs.unlinkSync(configPath) } catch {}
      if(this.connectionAbort===abort) this.connectionAbort=null
    }
  }
  async stop(publish=true) {
    clearInterval(this.timer); this.timer=null
    if(publish) this.update({phase:'disconnecting'})
    let restoreError=''
    try { await this.proxy.restore() } catch { restoreError='系统代理恢复失败，请在系统设置关闭代理，或重新启动本软件恢复' }
    const child=this.child; this.child=null
    if(child && child.exitCode===null && child.signalCode===null) {
      await new Promise(resolve=>{
        const timer=setTimeout(()=>{try{child.kill('SIGKILL')}catch{};resolve()},3000)
        child.once('exit',()=>{clearTimeout(timer);resolve()})
        try { child.kill() } catch {clearTimeout(timer);resolve()}
      })
    }
    if(this.guardian && !restoreError) { try{this.guardian.kill()}catch{}; this.guardian=null }
    this.update({phase:restoreError?'error':'idle',stage:'',connected:false,systemProxy:Boolean(restoreError),startedAt:null,error:restoreError})
    if(publish) this.log(restoreError?'error':'info',restoreError||'已断开，系统代理已恢复')
    return {ok:!restoreError,message:restoreError||'已断开连接'}
  }
}
module.exports={CoreManager,controller,freePort,httpProbe,reservePort}
