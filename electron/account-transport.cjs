'use strict'

const http = require('node:http')
const https = require('node:https')
const dns = require('node:dns')

class AccountError extends Error {
  constructor(message, status = 0, code = 'NETWORK') {
    super(message); this.status = status; this.code = code
  }
}

function accountOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw new AccountError('服务器地址无效', 0, 'CONFIG') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new AccountError('服务器地址必须是 HTTP(S) 来源地址', 0, 'CONFIG')
  }
  return url.origin
}

function networkError(error) {
  if (error instanceof AccountError) return error
  const code = error?.code || ''
  if (code === 'ABORT_ERR') return new AccountError('操作已取消', 0, 'CANCELLED')
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return new AccountError('账号服务域名解析失败，请检查网络后重试', 0, 'DNS')
  if (code === 'ECONNREFUSED') return new AccountError('账号服务拒绝连接，请管理员检查服务是否启动', 0, 'REFUSED')
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)) return new AccountError('账号服务连接超时，请稍后重试', 0, 'TIMEOUT')
  if (/CERT|TLS|SSL|SELF_SIGNED|VERIFY_LEAF/.test(code)) return new AccountError('账号服务证书验证失败，请管理员检查 HTTPS 证书', 0, 'TLS')
  return new AccountError('无法连接账号服务，请检查网络或稍后重试', 0, 'NETWORK')
}

// Node's HTTP client connects directly. It does not inherit Chromium's system
// proxy, PAC, CORS or preflight state, even while the local proxy is starting.
class AccountTransport {
  constructor({ timeout = 6000, totalTimeout = 12500, retryDelay = 250, lookup = dns.lookup, onEvent = () => {} } = {}) {
    Object.assign(this, { timeout, totalTimeout, retryDelay, lookup, onEvent })
    this.operations = new Set()
    this.closed = false
  }
  cancel(message = '操作已取消') {
    for (const operation of this.operations) operation.abort(new AccountError(message, 0, 'CANCELLED'))
  }
  close() { this.closed = true; this.cancel() }
  async request({ baseUrl, path, method = 'GET', token, body, signal } = {}) {
    if (this.closed) throw new AccountError('操作已取消', 0, 'CANCELLED')
    const origin = accountOrigin(baseUrl)
    if (typeof path !== 'string' || path.length > 2048 || !/^\/api\/[a-z0-9/?%=&_.~-]+$/i.test(path) || path.includes('..') || /%2f|%5c|%2e/i.test(path)) {
      throw new AccountError('账号请求路径无效', 0, 'CONFIG')
    }
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new AccountError('账号请求方法无效', 0, 'CONFIG')
    if (token !== undefined && (typeof token !== 'string' || !token || token.length > 4096 || /[\r\n]/.test(token))) throw new AccountError('登录凭据无效', 0, 'CONFIG')
    let content
    if (body !== undefined) {
      try { content = Buffer.from(JSON.stringify(body)) } catch { throw new AccountError('账号请求内容无效', 0, 'CONFIG') }
      if (content.length > 65536) throw new AccountError('账号请求内容过大', 0, 'CONFIG')
      if (method === 'GET') throw new AccountError('账号请求内容无效', 0, 'CONFIG')
    }
    const target = new URL(path, origin)
    if (target.origin !== origin) throw new AccountError('账号请求地址无效', 0, 'CONFIG')
    const operation = new AbortController()
    const abort = () => operation.abort(signal?.reason instanceof AccountError ? signal.reason : new AccountError('操作已取消', 0, 'CANCELLED'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    this.operations.add(operation)
    const deadline = Date.now() + this.totalTimeout
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (operation.signal.aborted) throw operation.signal.reason
        let connected = false
        try {
          const response = await this.once(target, { method, token, content, attempt, signal: operation.signal,
            timeout: Math.max(1, Math.min(this.timeout, deadline - Date.now())), onConnect: () => { connected = true } })
          this.onEvent({ method, status: response.status, attempt: attempt + 1 })
          if (attempt === 0 && method === 'GET' && [502, 503, 504].includes(response.status)) {
            await this.delay(operation.signal, deadline); continue
          }
          return response
        } catch (error) {
          const issue = networkError(error)
          this.onEvent({ method, code: issue.code, attempt: attempt + 1 })
          // Never replay a login/password change after the request was sent.
          // GETs are safe to retry; a login is retried only before TCP connects.
          const replaySafe = method === 'GET' || (method === 'POST' && path === '/api/login' && !connected)
          if (attempt === 0 && replaySafe && ['DNS', 'REFUSED', 'TIMEOUT', 'NETWORK'].includes(issue.code) && Date.now() + this.retryDelay < deadline && !operation.signal.aborted) {
            await this.delay(operation.signal, deadline); continue
          }
          throw operation.signal.aborted ? operation.signal.reason : issue
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      this.operations.delete(operation)
    }
  }
  delay(signal, deadline) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, Math.max(0, Math.min(this.retryDelay, deadline - Date.now())))
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  once(target, { method, token, content, signal, timeout, attempt, onConnect }) {
    return new Promise((resolve, reject) => {
      let request, settled = false, timer
      const finish = (error, value) => {
        if (settled) return
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
        error ? reject(error) : resolve(value)
      }
      const abort = () => { request?.destroy(); finish(signal.reason || new AccountError('操作已取消', 0, 'CANCELLED')) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) return abort()
      timer = setTimeout(() => { request?.destroy(); finish(new AccountError('账号服务连接超时，请稍后重试', 0, 'TIMEOUT')) }, timeout)
      const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
      if (content) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': content.length })
      try {
        request = (target.protocol === 'https:' ? https : http).request(target, {
          method, headers, agent: false,
          // Electron 22/Node 16 does not provide automatic family selection.
          // A retry uses the other family when a DNS name has both A and AAAA.
          lookup: (hostname, options, callback) => this.lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error)
            const valid = (addresses || []).filter(value => value.address && [4, 6].includes(value.family))
            if (!valid.length) return callback(Object.assign(new Error('DNS failed'), { code: 'ENOTFOUND' }))
            const selected = attempt ? valid.find(value => value.family !== valid[0].family) || valid[0] : valid[0]
            // Newer Node may request all addresses for its own happy eyeballs.
            if (options?.all) return callback(null, [selected, ...valid.filter(value => value !== selected)])
            callback(null, selected.address, selected.family)
          }),
        }, response => {
          const chunks = []; let size = 0
          response.on('data', chunk => {
            size += chunk.length
            if (size > 2 * 1024 * 1024) { request.destroy(); finish(new AccountError('账号服务响应过大', 0, 'RESPONSE')) }
            else chunks.push(chunk)
          })
          response.on('error', error => finish(networkError(error)))
          response.on('aborted', () => finish(new AccountError('账号服务连接中断，请稍后重试', 0, 'NETWORK')))
          response.on('end', () => {
            const status = response.statusCode || 0
            const text = Buffer.concat(chunks).toString('utf8')
            let data
            try { data = JSON.parse(text) } catch {
              if (status >= 500) data = { error: `账号服务暂时不可用（HTTP ${status}），请稍后重试` }
              else if (status >= 300 && status < 400) data = { error: '账号服务返回重定向，请管理员检查客户端地址与 HTTPS 配置' }
              else return finish(new AccountError('账号服务返回的不是有效 JSON，请管理员检查反向代理配置', status, 'RESPONSE'))
            }
            if (!data || typeof data !== 'object' || Array.isArray(data)) return finish(new AccountError('账号服务返回了无效数据', status, 'RESPONSE'))
            finish(null, { ok: status >= 200 && status < 300, status, data })
          })
        })
        request.once('socket', socket => {
          if (socket.connecting) socket.once('connect', onConnect)
          else onConnect()
        })
        request.on('error', error => finish(networkError(error)))
        request.end(content)
      } catch (error) { finish(networkError(error)) }
    })
  }
}

// Renderer access is deliberately narrower than the internal authorization
// client: private /config responses must stay in the Electron main process.
async function rendererAccountRequest(transport, input) {
  try {
    if (!input || typeof input !== 'object' || /\/config(?:[/?]|$)/i.test(input.path || '')) throw new AccountError('不允许读取线路凭据', 0, 'CONFIG')
    return await transport.request({ baseUrl: input.baseUrl, path: input.path, method: input.method, token: input.token, body: input.body })
  } catch (error) {
    const issue = networkError(error)
    return { transportError: true, status: issue.status, message: issue.message, code: issue.code }
  }
}

module.exports = { AccountTransport, AccountError, accountOrigin, rendererAccountRequest }
