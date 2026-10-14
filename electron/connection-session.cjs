const crypto=require('crypto')
const {AccountSession}=require('./account-session.cjs')
const fingerprint=uri=>crypto.createHash('sha256').update(uri).digest('hex')
class ConnectionSession {
  constructor({manager,createProbe,account=new AccountSession(),interval=15000}) {
    Object.assign(this,{manager,createProbe,account,interval})
    this.generation=0;this.connectionEpoch=0;this.probe=null;this.active=null;this.timer=null;this.failures=0;this.checking=null;this.mutations=Promise.resolve();this.connectionsInFlight=0
    this.manager.on('status',state=>{if(!['connected','connecting'].includes(state.phase))this.stopWatch()})
  }
  stopWatch(){clearInterval(this.timer);this.timer=null;this.active=null;this.failures=0;this.checking=null}
  async clearSession() {
    ++this.generation;++this.connectionEpoch;this.account.clear();this.stopWatch()
    const probe=this.probe;this.probe=null
    const [stopped]=await Promise.all([this.manager.disconnect(),probe?.close()])
    return stopped
  }
  async setSession(credentials) {
    const clearing=this.clearSession(),generation=this.generation
    const task=async()=>{
      await clearing
      if(generation!==this.generation)return {ok:false,message:'账号会话已切换'}
      try{
        const user=await this.account.set(credentials)
        if(generation!==this.generation)return {ok:false,message:'账号会话已切换'}
        this.probe=this.createProbe()
        return {ok:true,user}
      }catch(error){return {ok:false,message:error.message}}
    }
    const result=this.mutations.then(task,task);this.mutations=result.catch(()=>{});return result
  }
  async connect(payload) {
    this.connectionsInFlight++
    const generation=this.generation,attempt=++this.connectionEpoch
    const current=()=>generation===this.generation&&attempt===this.connectionEpoch
    const cancelled=()=>({ok:false,message:'连接已取消'})
    // Cancel an earlier startup synchronously, before this request performs
    // authorization. A failed replacement must never leave an unmonitored core.
    this.stopWatch()
    try{
      const stopped=await this.manager.disconnect()
      if(!current())return cancelled()
      if(!stopped.ok)return stopped
      if(this.manager.checkPort){
        const available=await this.manager.checkPort()
        if(!current())return cancelled()
        if(!available.ok){this.manager.update({phase:'error',stage:'',error:available.message});return available}
      }
      this.manager.update({phase:'connecting',stage:'正在确认线路权限',error:''})
      const node=await this.account.resolve(payload)
      if(!current())return cancelled()
      const result=await this.manager.connect({...node,mode:payload.mode||'global'})
      if(!current())return cancelled()
      if(result.ok){
        this.active={nodeId:node.nodeId,local:node.nodeId?null:{uri:node.uri,id:node.id,name:node.name},hash:fingerprint(node.uri)}
        this.failures=0
        clearInterval(this.timer);this.timer=setInterval(()=>this.checkAccess(),this.interval)
      }
      return result
    }catch(error){
      if(!current())return cancelled()
      this.manager.update({phase:'error',stage:'',error:error.message,errorCode:error.code||(error.status?'AUTH_'+error.status:'NETWORK')})
      return {ok:false,message:error.message,code:error.code||(error.status?'AUTH_'+error.status:'NETWORK')}
    }finally{this.connectionsInFlight--}
  }
  disconnect(){++this.connectionEpoch;this.account.cancelRequests?.();this.stopWatch();return this.manager.disconnect()}
  async testNode(payload) {
    const generation=this.generation,probe=this.probe
    try{
      if(!probe)throw new Error('请先登录')
      const node=await this.account.resolve(payload)
      if(generation!==this.generation||this.probe!==probe)throw new Error('测速已取消')
      const result=await probe.test(node.uri)
      if(generation!==this.generation)throw new Error('测速已取消')
      return result
    }catch(error){return {ok:false,latencyMs:null,message:error.message,checkedAt:new Date().toISOString()}}
  }
  async checkAccess() {
    if(this.checking||!this.active||!this.manager.status().connected)return
    const active=this.active,generation=this.generation,epoch=this.connectionEpoch
    const check={active,generation,epoch}
    this.checking=check
    const current=()=>this.checking===check&&active===this.active&&generation===this.generation&&epoch===this.connectionEpoch
    let reason='',stopCode='AUTH_STOP'
    try{
      const node=await this.account.resolve(active.nodeId?{nodeId:active.nodeId}:active.local)
      if(!current())return
      if(fingerprint(node.uri)!==active.hash)reason='线路配置已更新，请刷新后重新连接'
      this.failures=0
    }catch(error){
      if(!current())return
      if([401,403,404].includes(error.status)){reason=error.code==='QUOTA_EXCEEDED'?error.message:'登录或线路授权已失效，连接已断开';stopCode=error.code==='QUOTA_EXCEEDED'?error.code:'AUTH_STOP'}
      else if(++this.failures>=2){reason='连续两次无法验证线路授权，已断开；请恢复账号服务器连接';stopCode='ACCOUNT_OFFLINE'}
    }finally{if(this.checking===check)this.checking=null}
    if(reason&&active===this.active&&generation===this.generation&&epoch===this.connectionEpoch){
      const disconnecting=this.disconnect(),disconnectEpoch=this.connectionEpoch
      const stopped=await disconnecting
      // A newer connection may start while cleanup is pending. Its status and
      // outage counter belong to that connection, never to this old check.
      if(generation!==this.generation||disconnectEpoch!==this.connectionEpoch)return
      const message=stopped.ok?reason:`${reason}；${stopped.message}`
      this.manager.update({phase:'error',error:message,errorCode:stopped.ok?stopCode:'PROXY_RESTORE_FAILED'})
      this.manager.log('warn',message)
    }
  }

}
module.exports={ConnectionSession}
