const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Loads a simple KEY=value file without requiring dotenv or npm install.
function loadEnv(file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match || process.env[match[1]] !== undefined) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
const CORS_ORIGIN = process.env.MISAKA_CORS_ORIGIN || '*'
const DATA_DIR = path.join(__dirname, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')

if (!TOKEN_SECRET || !USER_PASSWORD || !ROOT_PASSWORD) {
  throw new Error('请在同目录 .env 中设置 MISAKA_TOKEN_SECRET、MISAKA_USER_PASSWORD 和 MISAKA_ROOT_PASSWORD')
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('MISAKA_PORT 无效')

fs.mkdirSync(DATA_DIR, { recursive: true })
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') }
}
function verifyPassword(password, user) {
  const actual = Buffer.from(crypto.scryptSync(password, user.salt, 64).toString('hex'), 'hex')
  const expected = Buffer.from(user.hash, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}
function saveUsers(value) { fs.writeFileSync(USERS_FILE, JSON.stringify(value, null, 2), 'utf8') }
function seedUsers() {
  if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
  const now = new Date().toISOString()
  const users = [
    { username: 'root', role: 'root', ...hashPassword(ROOT_PASSWORD), createdAt: now, updatedAt: now },
    { username: 'user', role: 'user', ...hashPassword(USER_PASSWORD), createdAt: now, updatedAt: now }
  ]
  saveUsers(users)
  return users
}
let users = seedUsers()
const sessions = new Map()
const loginAttempts = new Map()

function pruneSessions() {
  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 7
  for (const [token, createdAt] of sessions) if (createdAt < cutoff) sessions.delete(token)
}

function clientAddress(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim()
}

function loginAllowed(req) {
  const key = clientAddress(req)
  const now = Date.now()
  const entry = loginAttempts.get(key) || { count: 0, resetAt: now + 10 * 60 * 1000 }
  if (entry.resetAt <= now) { entry.count = 0; entry.resetAt = now + 10 * 60 * 1000 }
  entry.count += 1
  loginAttempts.set(key, entry)
  return entry.count <= 20
}

function clearLoginAttempts(req) { loginAttempts.delete(clientAddress(req)) }

function revokeUserSessions(username) {
  for (const [token] of sessions) {
    const [encoded] = token.split('.')
    try {
      const payload = Buffer.from(encoded, 'base64url').toString('utf8')
      if (payload.startsWith(`${username}.`)) sessions.delete(token)
    } catch {}
  }
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS'
  })
  res.end(JSON.stringify(body))
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk; if (data.length > 1024 * 1024) reject(new Error('payload too large')) })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch { reject(new Error('invalid json')) } })
    req.on('error', reject)
  })
}
function safeUser(user) { return { username: user.username, role: user.role, createdAt: user.createdAt, updatedAt: user.updatedAt } }
function issueToken(username) {
  const payload = `${username}.${Date.now() + 1000 * 60 * 60 * 24 * 7}`
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex')
  return `${Buffer.from(payload).toString('base64url')}.${signature}`
}
function authenticate(req) {
  pruneSessions()
  const token = (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''
  if (!sessions.has(token)) return null
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) return null
  let payload
  try { payload = Buffer.from(encoded, 'base64url').toString('utf8') } catch { return null }
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex')
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
  const [username, expires] = payload.split('.')
  if (!username || Number(expires) < Date.now()) return null
  const user = users.find(item => item.username === username)
  return user ? { username: user.username, role: user.role } : null
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {})
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, service: 'qaletx-link-server', time: new Date().toISOString() })
    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!loginAllowed(req)) return send(res, 429, { error: '登录尝试次数过多，请 10 分钟后再试' })
      const { username, password } = await readBody(req)
      const user = users.find(item => item.username === String(username || '').trim())
      if (!user || !password || !verifyPassword(password, user)) return send(res, 401, { error: '用户名或密码不正确' })
      clearLoginAttempts(req)
      const token = issueToken(user.username)
      sessions.set(token, Date.now())
      return send(res, 200, { token, user: safeUser(user) })
    }
    const actor = authenticate(req)
    if (req.method === 'GET' && url.pathname === '/api/me') {
      if (!actor) return send(res, 401, { error: '登录已过期' })
      return send(res, 200, { user: actor })
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const token = (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''
      sessions.delete(token)
      return send(res, 200, { ok: true })
    }
    if (!actor) return send(res, 401, { error: '需要登录' })
    if (req.method === 'GET' && url.pathname === '/api/users') {
      if (actor.role !== 'root') return send(res, 403, { error: '没有权限' })
      return send(res, 200, { users: users.map(safeUser) })
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      if (actor.role !== 'root') return send(res, 403, { error: '没有权限' })
      return send(res, 200, { userCount: users.length, activeSessions: sessions.size, uptime: process.uptime() })
    }
    if (req.method === 'POST' && url.pathname === '/api/users') {
      if (actor.role !== 'root') return send(res, 403, { error: '没有权限' })
      const { username, password } = await readBody(req)
      const cleanName = String(username || '').trim().toLowerCase()
      if (!/^[a-z][a-z0-9_-]{2,31}$/.test(cleanName) || cleanName === 'root') return send(res, 400, { error: '账号需为 3-32 位字母、数字、下划线或短横线' })
      if (users.some(item => item.username === cleanName)) return send(res, 409, { error: '账号已存在' })
      if (typeof password !== 'string' || password.length < 8 || password.length > 256) return send(res, 400, { error: '密码长度需为 8-256 位' })
      const now = new Date().toISOString()
      const record = { username: cleanName, role: 'user', ...hashPassword(password), createdAt: now, updatedAt: now }
      users.push(record); saveUsers(users)
      return send(res, 201, { user: safeUser(record) })
    }
    const passwordMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/)
    if (req.method === 'PATCH' && passwordMatch) {
      if (actor.role !== 'root') return send(res, 403, { error: '没有权限' })
      const target = decodeURIComponent(passwordMatch[1]); const { password } = await readBody(req)
      if (typeof password !== 'string' || password.length < 8) return send(res, 400, { error: '密码至少需要 8 位' })
      const index = users.findIndex(item => item.username === target)
      if (index < 0) return send(res, 404, { error: '用户不存在' })
      users[index] = { ...users[index], ...hashPassword(password), updatedAt: new Date().toISOString() }; saveUsers(users)
      revokeUserSessions(target)
      return send(res, 200, { ok: true, user: safeUser(users[index]) })
    }
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/)
    if (req.method === 'DELETE' && userMatch) {
      if (actor.role !== 'root') return send(res, 403, { error: '没有权限' })
      const target = decodeURIComponent(userMatch[1])
      if (target === 'root') return send(res, 400, { error: 'root 账号不能删除' })
      const index = users.findIndex(item => item.username === target)
      if (index < 0) return send(res, 404, { error: '用户不存在' })
      users.splice(index, 1); saveUsers(users); revokeUserSessions(target); return send(res, 200, { ok: true })
    }
    return send(res, 404, { error: '接口不存在' })
  } catch (error) {
    console.error(error); return send(res, 500, { error: '服务器内部错误' })
  }
})

server.listen(PORT, HOST, () => console.log(`qaletx link server listening on http://${HOST}:${PORT}`))

