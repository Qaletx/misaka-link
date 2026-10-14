const http=require('http')
const https=require('https')
class AccountError extends Error {
  constructor(message,status=0) {super(message);this.status=status}
}
class AccountSession {
  constructor({timeout=10000}={}) {this.timeout=timeout;this.current=null;this.epoch=0;this.requests=new Set()}
  clear() {
    this.epoch++;this.current=null
    for(const request of this.requests) request.destroy(new AccountError('账号会话已切换'))
    this.requests.clear()
  }
  async request(credentials,route) {
    const target=new URL(route,credentials.apiUrl)
    return new Promise((resolve,reject)=>{
      const request=(target.protocol==='https:'?https:http).get(target,{headers:{Authorization:`Bearer ${credentials.token}`,Accept:'application/json'},agent:false,timeout:this.timeout},res=>{
        let body=''
        res.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>262144)request.destroy(new AccountError('服务器响应过大'))})
        res.on('error',()=>reject(new AccountError('服务器连接中断')))
        res.on('end',()=>{
          if(res.statusCode===401) return reject(new AccountError('登录已失效，请重新登录',401))
          if(res.statusCode===403) return reject(new AccountError('当前账号没有这条线路的使用权限',403))
          if(res.statusCode===404) return reject(new AccountError('线路不存在或服务器版本过旧，请刷新线路',404))
          if(res.statusCode!==200) return reject(new AccountError(`服务器请求失败（${res.statusCode}）`,res.statusCode))
          try{resolve(JSON.parse(body))}catch{reject(new AccountError('服务器返回了无效数据'))}
        })
      })
      this.requests.add(request)
      request.on('close',()=>this.requests.delete(request))
      request.on('timeout',()=>request.destroy(new AccountError('服务器请求超时，请检查网络')))
      request.on('error',error=>reject(error instanceof AccountError?error:new AccountError('无法连接账号服务器，请检查网络')))
    })
  }
  async set(credentials) {
    this.clear();const epoch=this.epoch
    let url
    try{url=new URL(credentials?.apiUrl)}catch{throw new AccountError('服务器地址无效')}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/') throw new AccountError('服务器地址必须是 HTTP(S) 来源地址')
    if(typeof credentials?.token!=='string'||credentials.token.length<1||credentials.token.length>4096||/[\r\n]/.test(credentials.token)) throw new AccountError('登录凭据无效')
    const current={apiUrl:url.origin,token:credentials.token}
    const {user}=await this.request(current,'/api/me')
    if(epoch!==this.epoch) throw new AccountError('账号会话已切换')
    if(!user || !['admin','user','shared'].includes(user.role) || !user.permissions) throw new AccountError('请先更新到 0.5 版服务端，再登录新版客户端')
    this.current={...current,user}
    return user
  }
  async resolve(payload) {
    const current=this.current,epoch=this.epoch
    if(!current) throw new AccountError('请先登录',401)
    if(!payload || typeof payload!=='object') throw new AccountError('请选择线路')
    let result
    if(typeof payload.nodeId==='string' && payload.nodeId.length>0 && payload.nodeId.length<=200) {
      const data=await this.request(current,`/api/nodes/${encodeURIComponent(payload.nodeId)}/config`)
      if(typeof data.uri!=='string'||data.uri.length>32768||!data.node||data.node.id!==payload.nodeId) throw new AccountError('服务器返回的线路配置无效')
      result={uri:data.uri,id:data.node.id,name:String(data.node.name||'线路').slice(0,100),private:Boolean(data.node.private),nodeId:data.node.id}
    } else {
      const {user}=await this.request(current,'/api/me')
      if(user?.role!=='shared') throw new AccountError('请先将个人线路保存到云端后再连接',403)
      if(typeof payload.uri!=='string'||!payload.uri||payload.uri.length>32768) throw new AccountError('本机线路无效')
      result={uri:payload.uri,id:String(payload.id||'local').slice(0,200),name:String(payload.name||'本机线路').slice(0,100),private:false,nodeId:null}
    }
    if(epoch!==this.epoch||this.current!==current) throw new AccountError('账号会话已切换')
    return result
  }
}
module.exports={AccountSession,AccountError}
