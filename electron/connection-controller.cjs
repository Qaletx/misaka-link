'use strict'
const crypto=require('node:crypto')
const os=require('node:os')

const permanent=result=>['ACCOUNT_OFFLINE','NETWORK','METER_OFFLINE'].includes(result.code)?false:/AUTH_|ACCESS|QUOTA|PORT|CONFIG/.test(result.code||'')||/权限|授权|登录|额度|端口|校验|配置|恢复失败/.test(result.message||'')
class ConnectionController {
  constructor({session,manager,preferences,save,online=()=>true,healthInterval=30000,networkInterval=2000,selectionTimeout=30000,retryDelays=[2000,5000,10000,20000,30000]}) {
    Object.assign(this,{session,manager,preferences,save,online,healthInterval,selectionTimeout,retryDelays})
    this.epoch=0;this.intent=null;this.retryTimer=null;this.healthTimer=null;this.healthAbort=null;this.roundProbe=null
    this.recovering=false;this.retryCount=0;this.healthFailures=0;this.suspended=false;this.localNodes=[];this.lastSwitch=0;this.closed=false
    this.network=this.networkKey()
    this.tick=setInterval(()=>this.networkChanged(),networkInterval);this.tick.unref?.()
    let last='idle'
    manager.on('status',state=>{
      const previous=last;last=state.phase
      if(state.phase==='error'&&permanent({code:state.errorCode,message:state.error}))this.intent=null
      if(state.phase==='connected'){this.armHealth();return}
      clearTimeout(this.healthTimer);this.healthTimer=null
      if(state.phase==='error'&&previous!=='error'&&(previous==='connected'||/CORE_|ACCOUNT_OFFLINE/.test(state.errorCode||''))&&this.intent&&!this.recovering) {
        if(permanent({code:state.errorCode,message:state.error}))this.intent=null
        else if(this.preferences.autoRecover||this.preferences.automatic)this.scheduleRecovery('连接中断，正在恢复原线路')
      }
    })
  }
  networkKey(){return JSON.stringify([this.online(),Object.values(os.networkInterfaces()).flat().filter(x=>x&&!x.internal).map(x=>`${x.family}:${x.address}`).sort()])}
  networkChanged(){
    const next=this.networkKey();if(next===this.network)return;this.network=next
    if(this.intent&&this.preferences.autoRecover&&!this.suspended&&!this.closed)this.scheduleRecovery(this.online()?'网络已变化，正在检查原线路':'等待网络恢复')
  }
  settings(){return {autoRecover:this.preferences.autoRecover,automatic:this.preferences.automatic}}
  configure(patch){
    if(!patch||Object.keys(patch).some(k=>!['autoRecover','automatic'].includes(k))||Object.values(patch).some(v=>typeof v!=='boolean'))throw new Error('连接偏好无效')
    this.preferences={...this.preferences,...patch};this.save(patch)
    if(patch.automatic===true&&this.selection())this.select({...this.selection(),manual:false})
    if(!this.preferences.autoRecover){clearTimeout(this.retryTimer);this.retryTimer=null}
    return this.settings()
  }
  async setSession(credentials){await this.cancel();const result=await this.session.setSession(credentials);if(result.ok)this.accountKey=crypto.createHash('sha256').update(`${credentials.apiUrl}:${result.user.username}`).digest('hex');return result}
  selection(){return this.preferences.selections?.[this.accountKey]||null}
  select(payload){
    if(!payload||typeof payload!=='object')throw new Error('请选择线路')
    const previous=this.selection(),id=payload.nodeId||payload.id
    const manual=typeof payload.manual==='boolean'?payload.manual:Boolean(previous?.manual&&(previous.nodeId||previous.id)===id)
    const value=typeof payload.nodeId==='string'?{nodeId:payload.nodeId,id:payload.nodeId,mode:payload.mode||'global',manual}:{id:payload.id,uri:payload.uri,mode:payload.mode||'global',manual}
    this.preferences.selections={...this.preferences.selections,[this.accountKey]:value};this.save({selections:this.preferences.selections})
    return value
  }
  setLocalNodes(nodes){this.localNodes=Array.isArray(nodes)?nodes.filter(x=>x&&typeof x.uri==='string'&&x.uri.length<=32768).slice(0,200):[]}
  async catalog(signal){
    const current=this.session.account.current;if(!current)return []
    const data=await this.session.account.request(current,'/api/nodes',signal)
    return [...(data.nodes||[]).map(n=>({nodeId:n.id,id:n.id,name:n.name,private:n.private})),...(current.user.role==='shared'?this.localNodes:[])]
  }
  async choose(payload,epoch,exclude=false){
    const abort=new AbortController();this.roundAbort=abort
    const probe=this.session.createProbe();this.roundProbe=probe
    const timer=setTimeout(()=>{abort.abort();probe.close()},this.selectionTimeout)
    try {
      const catalog=await this.catalog(abort.signal);if(epoch!==this.epoch)throw new Error('连接已取消')
      const id=payload.nodeId||payload.id
      const pool=catalog.filter(n=>!exclude||(n.nodeId||n.id)!==id).sort((a,b)=>Number((b.nodeId||b.id)===id)-Number((a.nodeId||a.id)===id)).slice(0,6)
      if(!pool.length)throw new Error('没有可用的获授权线路')
      const results=[];let index=0
      const worker=async()=>{
        while(index<pool.length&&epoch===this.epoch&&!probe.closed){
          const candidate=pool[index++]
          try{const node=await this.session.account.resolve(candidate,{signal:abort.signal});if(epoch!==this.epoch)break
            const result=await probe.test(node.uri);if(result.ok)results.push({candidate,latency:result.latencyMs})
          }catch(error){if(error.status===401||error.code==='QUOTA_EXCEEDED')throw error}
        }
      }
      await Promise.all([worker(),worker()])
      if(epoch!==this.epoch)throw new Error('连接已取消')
      const best=results.sort((a,b)=>a.latency-b.latency)[0];if(!best)throw new Error('已测试的线路暂时无法连通')
      return {...best.candidate,mode:payload.mode||'global'}
    }finally{clearTimeout(timer);abort.abort();await probe.close();if(this.roundProbe===probe)this.roundProbe=null;if(this.roundAbort===abort)this.roundAbort=null}
  }
  async connect(payload=this.selection()){
    const cancelling=this.cancel(),epoch=this.epoch;await cancelling
    if(epoch!==this.epoch)return {ok:false,message:'连接已取消'}
    if(!payload)return {ok:false,message:'请先选择线路'}
    this.closed=false;this.retryCount=0;this.intent=this.select(payload)
    try{
      if(this.preferences.automatic&&!this.intent.manual){this.manager.update({phase:'connecting',stage:'正在选择可用线路',error:'',errorCode:''});payload=await this.choose(payload,epoch)}
      if(epoch!==this.epoch)return {ok:false,message:'连接已取消'}
      this.manager.update({errorCode:'',timings:[],retryCount:0,retryAt:null,recoveryReason:''})
      const result=await this.session.connect(payload)
      if(epoch!==this.epoch)return {ok:false,message:'连接已取消'}
      if(result.ok){this.intent=this.select(payload);this.healthFailures=0;this.retryCount=0}
      else this.intent=null
      return result
    }catch(error){if(epoch!==this.epoch)return {ok:false,message:'连接已取消'};this.intent=null;this.manager.update({phase:'error',stage:'',error:error.message});return {ok:false,message:error.message}}
  }
  async cancel(){
    ++this.epoch;this.intent=null;this.retryCount=0
    clearTimeout(this.retryTimer);clearTimeout(this.healthTimer);this.retryTimer=null;this.healthTimer=null
    this.healthAbort?.abort();this.session.account.cancelRequests?.()
    this.roundAbort?.abort();this.roundAbort=null
    this.manager.update({retryAt:null,recoveryReason:'',retryCount:0})
    const probe=this.roundProbe;this.roundProbe=null
    const [result]=await Promise.all([this.session.disconnect(),probe?.close()])
    return result
  }
  disconnect(){return this.cancel()}
  async clearSession(){this.closed=true;await this.cancel();this.localNodes=[];this.accountKey=null;return this.session.clearSession()}
  armHealth(){
    if(this.healthTimer||this.healthAbort||this.closed)return
    this.healthTimer=setTimeout(()=>{this.healthTimer=null;this.health().catch(()=>{})},this.healthFailures?5000:this.healthInterval)
    this.healthTimer.unref?.()
  }
  async health(){
    if(!this.intent||!this.manager.status().connected||this.suspended)return
    const epoch=this.epoch,abort=new AbortController();this.healthAbort=abort
    try{
      const result=await this.manager.checkHealth(abort.signal)
      if(epoch!==this.epoch||abort.signal.aborted)return
      this.healthFailures=result.ok?0:this.healthFailures+1
      this.manager.update({health:{...result,failures:this.healthFailures}})
      if(this.healthFailures>=3&&(this.preferences.autoRecover||this.preferences.automatic)){this.scheduleRecovery('连续检测失败，正在恢复连接');return}
    }finally{if(this.healthAbort===abort)this.healthAbort=null}
    this.armHealth()
  }
  scheduleRecovery(reason){
    if(!this.intent||this.closed||this.suspended||this.retryTimer||this.recovering)return
    const epoch=this.epoch,attempt=++this.retryCount
    if(attempt>this.retryDelays.length){this.manager.update({recoveryReason:'自动恢复未成功，请点击重试',retryAt:null});return}
    const delay=this.retryDelays[attempt-1]
    this.retryTimer=setTimeout(()=>{this.retryTimer=null;this.recover(epoch).catch(()=>{})},delay);this.retryTimer.unref?.()
    this.manager.update({recoveryReason:reason,retryCount:attempt,retryAt:Date.now()+delay})
  }
  async recover(epoch){
    if(epoch!==this.epoch||!this.intent||this.closed||this.suspended)return
    if(!this.online()){this.manager.update({recoveryReason:'等待网络恢复',retryAt:null});return}
    this.recovering=true;let again=false
    try{
      const stopped=await this.session.disconnect();if(epoch!==this.epoch)return
      if(!stopped.ok){this.intent=null;return}
      let payload=this.intent
      if(this.preferences.automatic&&this.healthFailures>=3&&Date.now()-this.lastSwitch>=60000){
        this.manager.update({phase:'connecting',stage:'正在寻找备用线路'})
        try{payload=await this.choose(payload,epoch,true);this.lastSwitch=Date.now()}catch(error){if(error.status===401||error.code==='QUOTA_EXCEEDED')throw error}
      }
      if(epoch!==this.epoch)return
      const result=await this.session.connect(payload);if(epoch!==this.epoch)return
      if(result.ok){this.intent=this.select(payload);this.retryCount=0;this.healthFailures=0;this.manager.update({retryAt:null,recoveryReason:'',retryCount:0})}
      else if(permanent(result))this.intent=null
      else again=true
    }catch(error){if(epoch===this.epoch){this.manager.update({phase:'error',stage:'',error:error.message});if(error.status===401||error.code==='QUOTA_EXCEEDED')this.intent=null;else again=true}}
    finally{this.recovering=false}
    if(again&&epoch===this.epoch)this.scheduleRecovery('连接尚未恢复，将再次尝试')
  }
  suspend(){this.suspended=true;clearTimeout(this.retryTimer);this.retryTimer=null;this.healthAbort?.abort();return this.session.disconnect()}
  resume(){this.suspended=false;this.network=this.networkKey();if(this.preferences.autoRecover&&this.intent){this.retryCount=0;this.scheduleRecovery('电脑已唤醒，正在恢复原线路')}}
  async close(){this.closed=true;clearInterval(this.tick);return this.clearSession()}
}
module.exports={ConnectionController,permanent}
