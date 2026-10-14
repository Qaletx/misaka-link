const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const HOST = process.env.MISAKA_HOST || '0.0.0.0'
const PORT = Number(process.env.MISAKA_PORT || 8787)
const TOKEN_SECRET = process.env.MISAKA_TOKEN_SECRET || 'change-this-secret-before-production'
const DATA_DIR = path.join(__dirname, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const DEFAULT_USER_PASSWORD = process.env.MISAKA_USER_PASSWORD
const DEFAULT_ROOT_PASSWORD = process.env.MISAKA_ROOT_PASSWORD
const sessions = new Map()

fs.mkdirSync(DATA_DIR, { recursive: true })

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') }
}
function verifyPassword(password, user) {
  const derived = crypto.scryptSync(password, user.salt, 64).toString('hex')
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(user.hash, 'hex'))
}
function seedUsers() {
  if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
  if (!DEFAULT_USER_PASSWORD || !DEFAULT_ROOT_PASSWORD) throw new Error('Set MISAKA_USER_PASSWORD and MISAKA_ROOT_PASSWORD before first start')
  const now = new Date().toISOString()
  const root = hashPassword(DEFAULT_ROOT_PASSWORD)
  const user = hashPassword(DEFAULT_USER_PASSWORD)
  const records = [
    { username: 'root', role: 'root', ...root, createdAt: now, updatedAt: now },
    { username: 'user', role: 'user', ...user, createdAt: now, updatedAt: now }
  ]
  saveUsers(records)
  return records
}
function saveUsers(users) { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8') }
let users = seedUsers()

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' })
  res.end(JSON.stringify(body))
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk; if (data.length > 1024 * 1024) reject(new Error('payload too large')) })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch { reject(new Error('invalid json')) } })
    req.on('error', reject)
  })
}
function issueToken(username) {
  const payload = `${username}.${Date.now() + 1000 * 60 * 60 * 24 * 7}`
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex')
  return `${Buffer.from(payload).toString('base64url')}.${signature}`
}
function authenticate(req) {
  const value = req.headers.authorization || ''
  const token = value.startsWith('Bearer ') ? value.slice(7) : ''
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) return null
  const payload = Buffer.from(encoded, 'base64url').toString('utf8')
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex')
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
  const [username, expires] = payload.split('.')
  if (!username || Number(expires) < Date.now()) return null
  const user = users.find((item) => item.username === username)
  return user ? { username: user.username, role: user.role } : null
}
function safeUser(user) { return { username: user.username, role: user.role, createdAt: user.createdAt, updatedAt: user.updatedAt } }

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {})
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, service: 'misaka-link-server', time: new Date().toISOString() })
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const { username, password } = await readBody(req)
      const user = users.find((item) => item.username === String(username || '').trim())
      if (!user || !password || !verifyPassword(password, user)) return send(res, 401, { error: '用户名或密码不正确' })
      const token = issueToken(user.username)
      sessions.set(token, Date.now())
      return send(res, 200, { token, user: safeUser(user) })
    }
    const actor = authenticate(req)
    if (req.method === 'GET' && url.pathname === '/api/me') {
      if (!actor) return send(res, 401, { error: '登录已过期' })
      return send(res, 200, { user: actor })
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
      if (users.some((item) => item.username === cleanName)) return send(res, 409, { error: '账号已存在' })
      if (typeof password !== 'string' || password.length < 8) return send(res, 400, { error: '密码至少需要 8 位' })
      const now = new Date().toISOString()
      const record = { username: cleanName, role: 'user', ...hashPassword(password), createdAt: now, updatedAt: now }
      users.push(record)
      saveUsers(users)
      return send(res, 201, { user: safeUser(record) })
    }
    const passwordMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/)
    if (req.method === 'PATCH' && passwordMatch) {
      if (actor.role !== 'root') return send(res, 403, { error: '没有权限' })
      const target = decodeURIComponent(passwordMatch[1])
      const { password } = await readBody(req)
      if (target !== 'user') return send(res, 400, { error: '当前仅允许修改 user 账号' })
      if (typeof password !== 'string' || password.length < 8) return send(res, 400, { error: '密码至少需要 8 位' })
      const index = users.findIndex((item) => item.username === target)
      if (index < 0) return send(res, 404, { error: '用户不存在' })
      const next = hashPassword(password)
      users[index] = { ...users[index], ...next, updatedAt: new Date().toISOString() }
      saveUsers(users)
      return send(res, 200, { ok: true, user: safeUser(users[index]) })
    }
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/)
    if (req.method === 'DELETE' && userMatch) {
      if (actor.role !== 'root') return send(res, 403, { error: '没有权限' })
      const target = decodeURIComponent(userMatch[1])
      if (target === 'root') return send(res, 400, { error: 'root 账号不能删除' })
      const index = users.findIndex((item) => item.username === target)
      if (index < 0) return send(res, 404, { error: '用户不存在' })
      users.splice(index, 1)
      saveUsers(users)
      return send(res, 200, { ok: true })
    }
    return send(res, 404, { error: '接口不存在' })
  } catch (error) {
    console.error(error)
    return send(res, 500, { error: '服务器内部错误' })
  }
})
server.listen(PORT, HOST, () => console.log(`Misaka Link server listening on http://${HOST}:${PORT}`))
