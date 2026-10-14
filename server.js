'use strict'

// Standalone: upload server.js + .env and run node server.js (no npm install).
// Account access is enforced here; Hysteria2 credentials are managed separately.
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const net = require('net')

function loadEnv(file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) throw new Error('.env 格式错误，请使用 KEY=value，每行一个配置项')
    if (process.env[match[1]] !== undefined) continue
    let value = match[2].trim()
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) throw new Error('.env 中的引号没有闭合')
      value = value.slice(1, -1)
    }
    process.env[match[1]] = value
  }
}
loadEnv(path.join(__dirname, '.env'))

const HOST = process.env.MISAKA_HOST || '0.0.0.0'
const PORT = Number(process.env.MISAKA_PORT || 8787)
const TOKEN_SECRET = process.env.MISAKA_TOKEN_SECRET
const USER_PASSWORD = process.env.MISAKA_USER_PASSWORD
const ROOT_PASSWORD = process.env.MISAKA_ROOT_PASSWORD
const CORS_ORIGINS = (process.env.MISAKA_CORS_ORIGIN || 'null').split(',').map(value => value.trim())
const DATA_DIR = path.join(__dirname, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const MAX_BODY_BYTES = 64 * 1024
const SESSION_MS = 7 * 24 * 60 * 60 * 1000
const RATE_WINDOW_MS = 10 * 60 * 1000
const MAX_RATE_ENTRIES = 10000
const MAX_SESSIONS = 10000
const MAX_USER_SESSIONS = 10

function normalizeAddress(address) { return address.startsWith('::ffff:') ? address.slice(7) : address }
const TRUSTED_PROXIES = new Set((process.env.MISAKA_TRUSTED_PROXIES || '').split(',')
  .map(value => normalizeAddress(value.trim())).filter(Boolean))

if (!TOKEN_SECRET || TOKEN_SECRET.length < 32 || TOKEN_SECRET.includes('请替换')) {
  throw new Error('请在同目录 .env 中把 MISAKA_TOKEN_SECRET 设置为至少 32 字符的随机密钥')
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('MISAKA_PORT 必须是 1-65535 的整数')
for (const address of TRUSTED_PROXIES) {
  if (!net.isIP(address)) throw new Error('MISAKA_TRUSTED_PROXIES 只支持用逗号分隔的明确 IP 地址')
}
for (const origin of CORS_ORIGINS) {
  if (origin === '*' || origin === 'null') continue
  try {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error()
  } catch { throw new Error('MISAKA_CORS_ORIGIN 应为 null、* 或完整来源（如 https://example.com），多个用逗号分隔') }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
function passwordValid(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 256
}
function requirePassword(password) {
  if (!passwordValid(password)) throw new HttpError(400, '密码长度需为 8-256 位')
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') }
}
function verifyPassword(password, user) {
  const actual = crypto.scryptSync(password, user.salt, 64)
  const expected = Buffer.from(user.hash, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}
function parseExpiry(value) {
  if (value === null) return null
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  if (!match) {
    throw new HttpError(400, 'expiresAt 必须是带时区的 ISO 日期时间或 null')
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) {
    throw new HttpError(400, 'expiresAt 日期时间无效')
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new HttpError(400, 'expiresAt 日期时间无效')
  return date.toISOString()
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
function saveUsers(value) {
  const temporary = path.join(DATA_DIR, '.users-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.tmp')
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, USERS_FILE)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}
function seedUsers() {
  if (fs.existsSync(USERS_FILE)) {
    const value = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
    if (!Array.isArray(value)) throw new Error('data/users.json 格式无效，请从备份恢复，勿删除用户数据')
    const names = new Set()
    for (const user of value) {
      if (!user || typeof user.username !== 'string' || !/^[a-z][a-z0-9_-]{2,31}$/.test(user.username)
        || names.has(user.username) || user.role !== (user.username === 'root' ? 'root' : 'user')
        || typeof user.hash !== 'string' || !/^[a-f0-9]{128}$/.test(user.hash)
        || typeof user.salt !== 'string' || !/^[a-f0-9]{32}$/.test(user.salt)
        || (user.disabled !== undefined && typeof user.disabled !== 'boolean')) {
        throw new Error('data/users.json 用户记录无效，请从备份恢复')
      }
      names.add(user.username)
      user.disabled = user.disabled === true
      user.expiresAt = user.expiresAt == null ? null : parseExpiry(user.expiresAt)
      if (user.role === 'root' && (user.disabled || user.expiresAt)) throw new Error('root 账号不可禁用或设置有效期')
    }
    if (!names.has('root')) throw new Error('data/users.json 缺少 root 账号，请从备份恢复')
    return value
  }
  if (!passwordValid(USER_PASSWORD) || !passwordValid(ROOT_PASSWORD)
    || USER_PASSWORD.includes('请替换') || ROOT_PASSWORD.includes('请替换')) {
    throw new Error('首次启动请在 .env 设置 MISAKA_USER_PASSWORD 和 MISAKA_ROOT_PASSWORD（8-256 位）')
  }
  const now = new Date().toISOString()
  const value = [
    { username: 'root', role: 'root', ...hashPassword(ROOT_PASSWORD), disabled: false, expiresAt: null, createdAt: now, updatedAt: now },
    { username: 'user', role: 'user', ...hashPassword(USER_PASSWORD), disabled: false, expiresAt: null, createdAt: now, updatedAt: now }
  ]
  saveUsers(value)
  return value
}
let users = seedUsers()
function persistUsers(next) { saveUsers(next); users = next }
const dummyPassword = hashPassword(crypto.randomBytes(32).toString('hex'))
const sessions = new Map()
const loginAttempts = new Map()

function isActive(user, now = Date.now()) {
  return user && !user.disabled && (!user.expiresAt || Date.parse(user.expiresAt) > now)
}
function pruneSessions() {
  const now = Date.now()
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now || !isActive(users.find(user => user.username === session.username), now)) sessions.delete(token)
  }
  for (const [key, attempt] of loginAttempts) if (attempt.resetAt <= now) loginAttempts.delete(key)
}
const cleanupTimer = setInterval(pruneSessions, 60 * 1000)
cleanupTimer.unref()

function clientAddress(req) {
  const peer = normalizeAddress(req.socket.remoteAddress || 'unknown')
  if (!TRUSTED_PROXIES.has(peer)) return peer
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded !== 'string' || forwarded.length > 4096) return peer
  const chain = forwarded.split(',').map(value => normalizeAddress(value.trim()))
  if (!chain.every(address => net.isIP(address))) return peer
  // Walk from the actual socket peer, trusting only explicitly configured hops.
  let address = peer
  for (let index = chain.length - 1; index >= 0 && TRUSTED_PROXIES.has(address); index -= 1) address = chain[index]
  return address
}
function requireAttempt(req, purpose = 'login') {
  const key = purpose + ':' + clientAddress(req)
  const now = Date.now()
  let entry = loginAttempts.get(key)
  if (!entry || entry.resetAt <= now) {
    if (!entry && loginAttempts.size >= MAX_RATE_ENTRIES) {
      pruneSessions()
      if (loginAttempts.size >= MAX_RATE_ENTRIES) throw new HttpError(429, '请求过多，请稍后再试')
    }
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS }
    loginAttempts.set(key, entry)
  }
  entry.count += 1
  if (entry.count > 20) throw new HttpError(429, '尝试次数过多，请 10 分钟后再试')
}
function revokeUserSessions(username) {
  for (const [token, session] of sessions) if (session.username === username) sessions.delete(token)
}
function safeUser(user) {
  return { username: user.username, role: user.role, disabled: user.disabled === true, expiresAt: user.expiresAt || null, createdAt: user.createdAt, updatedAt: user.updatedAt }
}
function issueToken(username) {
  pruneSessions()
  const owned = [...sessions].filter(([, session]) => session.username === username)
  while (owned.length >= MAX_USER_SESSIONS) sessions.delete(owned.shift()[0])
  if (sessions.size >= MAX_SESSIONS) throw new HttpError(503, '登录会话已达上限，请稍后再试')
  const token = crypto.createHmac('sha256', TOKEN_SECRET).update(crypto.randomBytes(32)).digest('base64url')
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_MS })
  return token
}
function bearer(req) {
  const value = req.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : ''
}
function authenticate(req) {
  const token = bearer(req)
  const session = sessions.get(token)
  if (!session) return null
  const user = users.find(item => item.username === session.username)
  if (session.expiresAt <= Date.now() || !isActive(user)) { sessions.delete(token); return null }
  return user
}
function send(res, status, body) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(status === 413 ? { Connection: 'close' } : {}),
    ...(status === 429 ? { 'Retry-After': '600' } : {})
  })
  res.end(status === 204 ? undefined : JSON.stringify(body))
}
function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume()
    return Promise.reject(new HttpError(413, '请求内容过大，最大 64 KiB'))
  }
  return new Promise((resolve, reject) => {
    let size = 0
    let chunks = []
    let finished = false
    const fail = error => {
      if (finished) return
      finished = true
      chunks = []
      reject(error)
    }
    req.on('data', chunk => {
      if (finished) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) return fail(new HttpError(413, '请求内容过大，最大 64 KiB'))
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (finished) return
      let body
      try { body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} }
      catch { return fail(new HttpError(400, '请求必须是有效的 JSON')) }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(new HttpError(400, '请求必须是 JSON 对象'))
      finished = true
      chunks = []
      resolve(body)
    })
    req.on('error', () => fail(new HttpError(400, '请求读取失败')))
    req.on('aborted', () => fail(new HttpError(400, '请求已中断')))
  })
}
function decodeName(value) {
  try { return decodeURIComponent(value) } catch { throw new HttpError(400, '用户路径编码无效') }
}
function requireRoot(actor) { if (actor.role !== 'root') throw new HttpError(403, '没有权限') }
// Request bodies arrive asynchronously. Re-check the session before any mutation.
function requireCurrentActor(req) {
  const actor = authenticate(req)
  if (!actor) throw new HttpError(401, '登录已过期或账号不可用，请重新登录')
  return actor
}

const server = http.createServer(async (req, res) => {
  try {
    const origin = req.headers.origin
    if (origin && !CORS_ORIGINS.includes('*') && !CORS_ORIGINS.includes(origin)) throw new HttpError(403, '不允许此页面来源')
    res.setHeader('Vary', 'Origin')
    if (origin) res.setHeader('Access-Control-Allow-Origin', CORS_ORIGINS.includes('*') ? '*' : origin)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') return send(res, 204)
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { throw new HttpError(400, '请求路径无效') }
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, service: 'qaletx-link-server', time: new Date().toISOString() })
    if (req.method === 'POST' && url.pathname === '/api/login') {
      requireAttempt(req)
      const { username, password } = await readBody(req)
      if (typeof username !== 'string' || username.length > 64 || !passwordValid(password)) throw new HttpError(400, '账号或密码格式不正确')
      const user = users.find(item => item.username === username.trim().toLowerCase())
      const correct = verifyPassword(password, user || dummyPassword)
      if (!user || !correct) throw new HttpError(401, '用户名或密码不正确')
      if (!isActive(user)) throw new HttpError(403, user.disabled ? '账号已停用，请联系管理员' : '账号已到期，请联系管理员')
      const token = issueToken(user.username)
      return send(res, 200, { token, user: safeUser(user) })
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      sessions.delete(bearer(req))
      return send(res, 200, { ok: true })
    }
    const actor = requireCurrentActor(req)
    if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, { user: safeUser(actor) })
    if (req.method === 'POST' && url.pathname === '/api/me/password') {
      requireAttempt(req, 'password')
      const { currentPassword, password } = await readBody(req)
      const currentActor = requireCurrentActor(req)
      requirePassword(currentPassword)
      requirePassword(password)
      if (!verifyPassword(currentPassword, currentActor)) throw new HttpError(400, '当前密码不正确')
      const updated = { ...currentActor, ...hashPassword(password), updatedAt: new Date().toISOString() }
      persistUsers(users.map(user => user.username === currentActor.username ? updated : user))
      revokeUserSessions(currentActor.username)
      return send(res, 200, { ok: true, user: safeUser(updated), reLoginRequired: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/users') {
      requireRoot(actor)
      return send(res, 200, { users: users.map(safeUser) })
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      requireRoot(actor)
      pruneSessions()
      return send(res, 200, { userCount: users.length, activeSessions: sessions.size, uptime: process.uptime() })
    }
    if (req.method === 'POST' && url.pathname === '/api/users') {
      requireRoot(actor)
      const { username, password } = await readBody(req)
      requireRoot(requireCurrentActor(req))
      if (typeof username !== 'string') throw new HttpError(400, '账号必须是字符串')
      const cleanName = username.trim().toLowerCase()
      if (!/^[a-z][a-z0-9_-]{2,31}$/.test(cleanName) || cleanName === 'root') throw new HttpError(400, '账号需以字母开头，为 3-32 位字母、数字、下划线或短横线')
      if (users.some(item => item.username === cleanName)) throw new HttpError(409, '账号已存在')
      requirePassword(password)
      const now = new Date().toISOString()
      const record = { username: cleanName, role: 'user', ...hashPassword(password), disabled: false, expiresAt: null, createdAt: now, updatedAt: now }
      persistUsers([...users, record])
      return send(res, 201, { user: safeUser(record) })
    }
    const passwordMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/)
    if (req.method === 'PATCH' && passwordMatch) {
      requireRoot(actor)
      const target = decodeName(passwordMatch[1])
      const { password } = await readBody(req)
      requireRoot(requireCurrentActor(req))
      requirePassword(password)
      const record = users.find(item => item.username === target)
      if (!record) throw new HttpError(404, '用户不存在')
      const updated = { ...record, ...hashPassword(password), updatedAt: new Date().toISOString() }
      persistUsers(users.map(user => user.username === target ? updated : user))
      revokeUserSessions(target)
      return send(res, 200, { ok: true, user: safeUser(updated) })
    }
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/)
    if (req.method === 'PATCH' && userMatch) {
      requireRoot(actor)
      const target = decodeName(userMatch[1])
      const body = await readBody(req)
      requireRoot(requireCurrentActor(req))
      const keys = Object.keys(body)
      if (!keys.length || keys.some(key => key !== 'disabled' && key !== 'expiresAt')) throw new HttpError(400, '仅支持 disabled 和 expiresAt 字段')
      if ('disabled' in body && typeof body.disabled !== 'boolean') throw new HttpError(400, 'disabled 必须为 true 或 false')
      const record = users.find(item => item.username === target)
      if (!record) throw new HttpError(404, '用户不存在')
      const updated = { ...record, updatedAt: new Date().toISOString() }
      if ('disabled' in body) updated.disabled = body.disabled
      if ('expiresAt' in body) updated.expiresAt = parseExpiry(body.expiresAt)
      if (target === 'root' && (updated.disabled || updated.expiresAt !== null)) throw new HttpError(400, 'root 账号不能停用或设置有效期')
      persistUsers(users.map(user => user.username === target ? updated : user))
      revokeUserSessions(target)
      return send(res, 200, { ok: true, user: safeUser(updated) })
    }
    if (req.method === 'DELETE' && userMatch) {
      requireRoot(actor)
      const target = decodeName(userMatch[1])
      if (target === 'root') throw new HttpError(400, 'root 账号不能删除')
      if (!users.some(user => user.username === target)) throw new HttpError(404, '用户不存在')
      persistUsers(users.filter(user => user.username !== target))
      revokeUserSessions(target)
      return send(res, 200, { ok: true })
    }
    throw new HttpError(404, '接口不存在')
  } catch (error) {
    if (error instanceof HttpError) return send(res, error.status, { error: error.message })
    console.error('API error:', error.code || error.name)
    return send(res, 500, { error: '服务器内部错误，请查看服务日志' })
  }
})

server.requestTimeout = 15000
server.headersTimeout = 10000
server.keepAliveTimeout = 5000
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? '端口 ' + PORT + ' 已被占用，请检查是否重复启动' : '服务启动失败：' + (error.code || error.message))
  process.exitCode = 1
})
server.listen(PORT, HOST, () => console.log('qaletx link server listening on http://' + HOST + ':' + PORT))
