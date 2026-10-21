const {AccountTransport,AccountError,accountOrigin}=require('./account-transport.cjs')
class AccountSession {
  constructor({timeout=12500,transport}={}) {this.transport=transport||new AccountTransport({totalTimeout:timeout,timeout:Math.min(timeout,6000)});this.current=null;this.epoch=0;this.requests=new Set()}
  clear() {
    this.epoch++;this.current=null
    this.cancelRequests('账号会话已切换')
  }
  cancelRequests(message='操作已取消') {
    for(const request of this.requests) request.abort(new AccountError(message,0,'CANCELLED'))
    this.requests.clear()
  }
  async request(credentials,route,signal) {
    const request=new AbortController()
    const abort=()=>request.abort(new AccountError('操作已取消',0,'CANCELLED'))
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
    this.requests.add(request)
    try {
      const response=await this.transport.request({baseUrl:credentials.apiUrl,path:route,token:credentials.token,signal:request.signal})
      if(response.status===401)throw new AccountError('登录已失效，请重新登录',401,'AUTH_401')
      if(response.status===403)throw new AccountError(response.data.error||'当前账号没有这条线路的使用权限',403,response.data.code||'ACCESS_DENIED')
      if(response.status===404)throw new AccountError('线路不存在或服务器版本过旧，请刷新线路',404,'AUTH_404')
      if(!response.ok)throw new AccountError(response.data.error||`服务器请求失败（${response.status}）`,response.status,'HTTP_'+response.status)
      return response.data
    }finally{signal?.removeEventListener('abort',abort);this.requests.delete(request)}
  }
  async set(credentials) {
    this.clear();const epoch=this.epoch
    const apiUrl=accountOrigin(credentials?.apiUrl)
    if(typeof credentials?.token!=='string'||credentials.token.length<1||credentials.token.length>4096||/[\r\n]/.test(credentials.token)) throw new AccountError('登录凭据无效')
    const current={apiUrl,token:credentials.token}
    const {user}=await this.request(current,'/api/me')
    if(epoch!==this.epoch) throw new AccountError('账号会话已切换')
    if(!user || !['admin','user','shared'].includes(user.role) || !user.permissions) throw new AccountError('请先更新到 0.5 版服务端，再登录新版客户端')
    this.current={...current,user}
    return user
  }
  async resolve(payload,{signal}={}) {
    const current=this.current,epoch=this.epoch
    if(!current) throw new AccountError('请先登录',401)
    if(!payload || typeof payload!=='object') throw new AccountError('请选择线路')
    let result
    if(typeof payload.nodeId==='string' && payload.nodeId.length>0 && payload.nodeId.length<=200) {
      const data=await this.request(current,`/api/nodes/${encodeURIComponent(payload.nodeId)}/config`,signal)
      if(typeof data.uri!=='string'||data.uri.length>32768||!data.node||data.node.id!==payload.nodeId) throw new AccountError('服务器返回的线路配置无效')
      result={uri:data.uri,id:data.node.id,name:String(data.node.name||'线路').slice(0,100),private:Boolean(data.node.private),nodeId:data.node.id}
    } else {
      const {user}=await this.request(current,'/api/me',signal)
      if(user?.role!=='shared') throw new AccountError('请先将个人线路保存到云端后再连接',403)
      if(typeof payload.uri!=='string'||!payload.uri||payload.uri.length>32768) throw new AccountError('本机线路无效')
      result={uri:payload.uri,id:String(payload.id||'local').slice(0,200),name:String(payload.name||'本机线路').slice(0,100),private:false,nodeId:null}
    }
    if(epoch!==this.epoch||this.current!==current) throw new AccountError('账号会话已切换')
    return result
  }
}
module.exports={AccountSession,AccountError}
