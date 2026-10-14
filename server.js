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
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const PRIVATE_NODE_URI = process.env.MISAKA_PRIVATE_NODE_URI || ''
const ROLES = new Set(['admin', 'user', 'shared'])
const NODE_SCHEMES = new Set(['hysteria2', 'tuic', 'trojan', 'vless', 'vmess', 'ss', 'socks5', 'http', 'https'])
const MAX_PERSONAL_NODES = 200
const MAX_BODY_BYTES = 64 * 1024
const SESSION_MS = 7 * 24 * 60 * 60 * 1000
const RATE_WINDOW_MS = 10 * 60 * 1000
const MAX_RATE_ENTRIES = 10000
const MAX_SESSIONS = 10000
const MAX_USER_SESSIONS = 10
const MAX_SHARED_SESSIONS = 200

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

function nodeUri(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\s\u0000-\u001f]/.test(value.trim())) throw new HttpError(400, '节点链接格式无效或过长')
  const uri = value.trim().replace(/^hy2:\/\//i, 'hysteria2://')
  const match = uri.match(/^([a-z0-9]+):\/\/([^#]+)(?:#.*)?$/i)
  if (!match || !NODE_SCHEMES.has(match[1].toLowerCase())) throw new HttpError(400, '不支持此节点协议')
  return { uri, protocol: match[1].toLowerCase(), key: uri.replace(/#.*$/, '').replace(/^[a-z0-9]+:/i, match[1].toLowerCase() + ':') }
}
function nodeText(value, field, maximum, fallback = '') {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, field + '格式无效或过长')
  return value.trim()
}
function nodeLabel(uri) {
  try { return decodeURIComponent(uri.split('#').slice(1).join('#')).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100) || '未命名线路' } catch { return '未命名线路' }
}
function newNode(uri, owner, metadata = {}, id = crypto.randomUUID()) {
  const parsed = nodeUri(uri)
  return { id, owner, private: owner === null, uri: parsed.uri, protocol: parsed.protocol,
    name: nodeText(metadata.name, '线路名称', 100, nodeLabel(parsed.uri)) || '未命名线路',
    note: nodeText(metadata.note, '线路备注', 500), revision: 1, updatedAt: new Date().toISOString() }
}
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
function saveState(value) {
  const temporary = path.join(DATA_DIR, '.state-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.tmp')
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, STATE_FILE)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}
function validateUsers(value, legacy = false) {
  if (!Array.isArray(value)) throw new Error('用户数据库格式无效，请从备份恢复，勿删除用户数据')
  const names = new Set()
  for (const user of value) {
    if (legacy && user?.username === 'root' && user.role === 'root') user.role = 'admin'
    if (!user || typeof user.username !== 'string' || !/^[a-z][a-z0-9_-]{2,31}$/.test(user.username)
      || names.has(user.username) || !ROLES.has(user.role)
      || typeof user.hash !== 'string' || !/^[a-f0-9]{128}$/.test(user.hash)
      || typeof user.salt !== 'string' || !/^[a-f0-9]{32}$/.test(user.salt)
      || (user.disabled !== undefined && typeof user.disabled !== 'boolean')) throw new Error('用户数据库记录无效，请从备份恢复')
    names.add(user.username)
    user.disabled = user.disabled === true
    user.expiresAt = user.expiresAt == null ? null : parseExpiry(user.expiresAt)
    if (legacy) { user.privateNodeAccess = true; user.privateNodeIds = ['misaka'] }
    if (typeof user.privateNodeAccess !== 'boolean' || !Array.isArray(user.privateNodeIds)
      || user.privateNodeIds.some(id => typeof id !== 'string' || id.length > 128)) throw new Error('用户节点权限记录无效，请从备份恢复')
    if (user.username === 'root' && (user.role !== 'admin' || user.disabled || user.expiresAt)) throw new Error('root 账号不可降权、禁用或设置有效期')
  }
  if (!names.has('root')) throw new Error('用户数据库缺少 root 账号，请从备份恢复')
  return value
}
function seedState() {
  if (fs.existsSync(STATE_FILE)) {
    const value = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (!value || value.schemaVersion !== 2 || !Array.isArray(value.nodes) || !Array.isArray(value.annotations)) throw new Error('data/state.json 格式无效，请从备份恢复')
    validateUsers(value.users)
    const ids = new Set()
    for (const node of value.nodes) {
      if (!node || typeof node.id !== 'string' || ids.has(node.id) || typeof node.private !== 'boolean'
        || (node.private ? node.owner !== null : !value.users.some(user => user.username === node.owner))
        || !Number.isSafeInteger(node.revision) || node.revision < 1) throw new Error('数据库线路记录无效，请从备份恢复')
      nodeUri(node.uri); nodeText(node.name, '线路名称', 100); nodeText(node.note, '线路备注', 500)
      ids.add(node.id)
    }
    for (const item of value.annotations) {
      if (!item || typeof item.username !== 'string' || !value.users.some(user => user.username === item.username)
        || !value.nodes.some(node => node.id === item.nodeId && node.private)) throw new Error('数据库备注记录无效，请从备份恢复')
      nodeText(item.name, '线路名称', 100); nodeText(item.note, '线路备注', 500)
    }
    return value
  }
  let seededUsers
  if (fs.existsSync(USERS_FILE)) seededUsers = validateUsers(JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')), true)
  else {
    if (!passwordValid(USER_PASSWORD) || !passwordValid(ROOT_PASSWORD)
      || USER_PASSWORD.includes('请替换') || ROOT_PASSWORD.includes('请替换')) throw new Error('首次启动请在 .env 设置 MISAKA_USER_PASSWORD 和 MISAKA_ROOT_PASSWORD（8-256 位）')
    const now = new Date().toISOString()
    seededUsers = [
      { username: 'root', role: 'admin', ...hashPassword(ROOT_PASSWORD), privateNodeAccess: true, privateNodeIds: ['misaka'], disabled: false, expiresAt: null, createdAt: now, updatedAt: now },
      { username: 'user', role: 'user', ...hashPassword(USER_PASSWORD), privateNodeAccess: false, privateNodeIds: [], disabled: false, expiresAt: null, createdAt: now, updatedAt: now }
    ]
  }
  const value = { schemaVersion: 2, users: seededUsers, nodes: PRIVATE_NODE_URI ? [newNode(PRIVATE_NODE_URI, null, { name: '默认专属线路' }, 'misaka')] : [], annotations: [] }
  saveState(value)
  return value
}
let state = seedState()
let users = state.users
function persistState(next) { saveState(next); state = next; users = state.users }
function persistUsers(next) { persistState({ ...state, users: next }) }
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
  return { username: user.username, role: user.role, isRoot: user.username === 'root', privateNodeAccess: user.privateNodeAccess, privateNodeIds: [...user.privateNodeIds], disabled: user.disabled === true, expiresAt: user.expiresAt || null, createdAt: user.createdAt, updatedAt: user.updatedAt, permissions: { manageUsers: user.role === 'admin', managePrivateNodes: user.username === 'root', changePassword: user.role !== 'shared', syncNodes: user.role !== 'shared' } }
}
function issueToken(username) {
  pruneSessions()
  const owned = [...sessions].filter(([, session]) => session.username === username)
  const limit = users.find(user => user.username === username)?.role === 'shared' ? MAX_SHARED_SESSIONS : MAX_USER_SESSIONS
  while (owned.length >= limit) sessions.delete(owned.shift()[0])
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
function requireRoot(actor) { if (actor.username !== 'root') throw new HttpError(403, '仅 root 可以执行此操作') }
function requireAdmin(actor) { if (actor.role !== 'admin') throw new HttpError(403, '没有管理权限') }
function requirePersonal(actor) { if (actor.role === 'shared') throw new HttpError(403, '共用账号不支持个人线路云同步') }
function manageable(actor, target) {
  requireAdmin(actor)
  if (actor.username !== 'root' && target.role === 'admin') throw new HttpError(403, '管理员不能修改其他管理员或 root')
}
// Request bodies arrive asynchronously. Re-check the session before any mutation.
function requireCurrentActor(req) {
  const actor = authenticate(req)
  if (!actor) throw new HttpError(401, '登录已过期或账号不可用，请重新登录')
  return actor
}

function onlyFields(body, allowed, required = false) {
  const keys = Object.keys(body)
  if ((required && !keys.length) || keys.some(key => !allowed.includes(key))) throw new HttpError(400, '请求包含不支持的字段或缺少修改内容')
}
function userChanges(body, actor, record) {
  const updated = { ...record }
  if ('role' in body) {
    if (!ROLES.has(body.role)) throw new HttpError(400, '角色必须是 admin、user 或 shared')
    if (actor.username !== 'root' && body.role === 'admin') throw new HttpError(403, '仅 root 可以创建或设置管理员')
    updated.role = body.role
  }
  if ('disabled' in body) {
    if (typeof body.disabled !== 'boolean') throw new HttpError(400, 'disabled 必须为 true 或 false')
    updated.disabled = body.disabled
  }
  if ('expiresAt' in body) updated.expiresAt = parseExpiry(body.expiresAt)
  if ('privateNodeAccess' in body || 'privateNodeIds' in body) {
    requireRoot(actor)
    if ('privateNodeAccess' in body) {
      if (typeof body.privateNodeAccess !== 'boolean') throw new HttpError(400, 'privateNodeAccess 必须为 true 或 false')
      updated.privateNodeAccess = body.privateNodeAccess
    }
    if ('privateNodeIds' in body) {
      if (!Array.isArray(body.privateNodeIds) || body.privateNodeIds.length > 200 || body.privateNodeIds.some(id => typeof id !== 'string'
        || !state.nodes.some(node => node.id === id && node.private))) throw new HttpError(400, 'privateNodeIds 必须仅包含存在的私有线路 ID')
      updated.privateNodeIds = [...new Set(body.privateNodeIds)]
    }
  }
  if (updated.username === 'root' && (updated.role !== 'admin' || updated.disabled || updated.expiresAt !== null || !updated.privateNodeAccess)) throw new HttpError(400, 'root 账号不可降权、停用、设置到期或关闭私有线路权限')
  updated.updatedAt = new Date().toISOString()
  return updated
}
function allowedNode(actor, node) {
  return node.private ? actor.username === 'root' || (actor.privateNodeAccess && actor.privateNodeIds.includes(node.id)) : actor.role !== 'shared' && node.owner === actor.username
}
function findNode(actor, id) {
  const node = state.nodes.find(item => item.id === id)
  if (!node) throw new HttpError(404, '线路不存在')
  if (!allowedNode(actor, node)) throw new HttpError(403, '未获授权使用此线路')
  return node
}
function safeNode(actor, node) {
  const annotation = state.annotations.find(item => item.username === actor.username && item.nodeId === node.id)
  return { id: node.id, name: annotation?.name || node.name, note: annotation && annotation.note !== undefined ? annotation.note : node.note,
    protocol: node.protocol, private: node.private, ...(!node.private ? { uri: node.uri } : {}), updatedAt: annotation?.updatedAt || node.updatedAt, revision: node.revision }
}
function checkRevision(body, node) {
  if (!Number.isSafeInteger(body.revision) || body.revision < 1) throw new HttpError(400, '修改线路必须提供 revision')
  if (body.revision !== node.revision) throw new HttpError(409, '线路已在其他设备更新，请刷新后再保存')
}
function updateNode(node, body) {
  onlyFields(body, ['name', 'note', 'revision'])
  if (!('name' in body) && !('note' in body)) throw new HttpError(400, '请提供线路名称或备注')
  checkRevision(body, node)
  return { ...node, name: nodeText(body.name, '线路名称', 100, node.name) || '未命名线路', note: nodeText(body.note, '线路备注', 500, node.note), revision: node.revision + 1, updatedAt: new Date().toISOString() }
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
      if (actor.role === 'shared') throw new HttpError(403, '共用账号不能自行修改密码，请联系管理员')
      requireAttempt(req, 'password')
      const body = await readBody(req)
      const currentActor = requireCurrentActor(req)
      if (currentActor.role === 'shared') throw new HttpError(403, '共用账号不能自行修改密码，请联系管理员')
      onlyFields(body, ['currentPassword', 'password'])
      requirePassword(body.currentPassword); requirePassword(body.password)
      if (!verifyPassword(body.currentPassword, currentActor)) throw new HttpError(400, '当前密码不正确')
      const updated = { ...currentActor, ...hashPassword(body.password), updatedAt: new Date().toISOString() }
      persistUsers(users.map(user => user.username === currentActor.username ? updated : user))
      revokeUserSessions(currentActor.username)
      return send(res, 200, { ok: true, user: safeUser(updated), reLoginRequired: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/users') {
      requireAdmin(actor)
      return send(res, 200, { users: users.filter(user => actor.username === 'root' || user.role !== 'admin').map(safeUser) })
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      requireAdmin(actor)
      pruneSessions()
      const visible = users.filter(user => actor.username === 'root' || user.role !== 'admin')
      return send(res, 200, { userCount: visible.length, activeSessions: [...sessions.values()].filter(session => visible.some(user => user.username === session.username)).length, uptime: process.uptime() })
    }
    if (req.method === 'POST' && url.pathname === '/api/users') {
      requireAdmin(actor)
      const body = await readBody(req)
      const currentActor = requireCurrentActor(req)
      requireAdmin(currentActor)
      onlyFields(body, ['username', 'password', 'role', 'disabled', 'expiresAt', 'privateNodeAccess', 'privateNodeIds'])
      if (typeof body.username !== 'string') throw new HttpError(400, '账号必须是字符串')
      const cleanName = body.username.trim().toLowerCase()
      if (!/^[a-z][a-z0-9_-]{2,31}$/.test(cleanName) || cleanName === 'root') throw new HttpError(400, '账号需以字母开头，为 3-32 位字母、数字、下划线或短横线')
      if (users.some(item => item.username === cleanName)) throw new HttpError(409, '账号已存在')
      requirePassword(body.password)
      const now = new Date().toISOString()
      const record = userChanges(body, currentActor, { username: cleanName, role: 'user', ...hashPassword(body.password), privateNodeAccess: false, privateNodeIds: [], disabled: false, expiresAt: null, createdAt: now, updatedAt: now })
      persistUsers([...users, record])
      return send(res, 201, { user: safeUser(record) })
    }
    const passwordMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/)
    if (req.method === 'PATCH' && passwordMatch) {
      requireAdmin(actor)
      const target = decodeName(passwordMatch[1])
      const body = await readBody(req)
      const currentActor = requireCurrentActor(req)
      requireAdmin(currentActor)
      onlyFields(body, ['password'])
      requirePassword(body.password)
      const record = users.find(item => item.username === target)
      if (!record) throw new HttpError(404, '用户不存在')
      manageable(currentActor, record)
      const updated = { ...record, ...hashPassword(body.password), updatedAt: new Date().toISOString() }
      persistUsers(users.map(user => user.username === target ? updated : user))
      revokeUserSessions(target)
      return send(res, 200, { ok: true, user: safeUser(updated) })
    }
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/)
    if (req.method === 'PATCH' && userMatch) {
      requireAdmin(actor)
      const target = decodeName(userMatch[1])
      const body = await readBody(req)
      const currentActor = requireCurrentActor(req)
      requireAdmin(currentActor)
      onlyFields(body, ['role', 'disabled', 'expiresAt', 'privateNodeAccess', 'privateNodeIds'], true)
      const record = users.find(item => item.username === target)
      if (!record) throw new HttpError(404, '用户不存在')
      manageable(currentActor, record)
      const updated = userChanges(body, currentActor, record)
      persistUsers(users.map(user => user.username === target ? updated : user))
      if (updated.role !== record.role || updated.disabled !== record.disabled || updated.expiresAt !== record.expiresAt) revokeUserSessions(target)
      return send(res, 200, { ok: true, user: safeUser(updated) })
    }
    if (req.method === 'DELETE' && userMatch) {
      requireAdmin(actor)
      const target = decodeName(userMatch[1])
      if (target === 'root') throw new HttpError(400, 'root 账号不能删除')
      const record = users.find(user => user.username === target)
      if (!record) throw new HttpError(404, '用户不存在')
      manageable(actor, record)
      persistState({ ...state, users: users.filter(user => user.username !== target), nodes: state.nodes.filter(node => node.owner !== target), annotations: state.annotations.filter(item => item.username !== target) })
      revokeUserSessions(target)
      return send(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/nodes') {
      return send(res, 200, { nodes: state.nodes.filter(node => allowedNode(actor, node)).map(node => safeNode(actor, node)) })
    }
    const configMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/config$/)
    if (req.method === 'GET' && configMatch) {
      const node = findNode(actor, decodeName(configMatch[1]))
      const metadata = safeNode(actor, node)
      delete metadata.uri
      return send(res, 200, { uri: node.uri, node: metadata })
    }
    if (req.method === 'POST' && url.pathname === '/api/nodes') {
      requirePersonal(actor)
      const body = await readBody(req)
      const currentActor = requireCurrentActor(req)
      requirePersonal(currentActor)
      onlyFields(body, ['uri', 'name', 'note'])
      const created = newNode(body.uri, currentActor.username, body)
      const existing = state.nodes.find(node => !node.private && node.owner === currentActor.username && nodeUri(node.uri).key === nodeUri(created.uri).key)
      if (existing) return send(res, 200, { node: safeNode(currentActor, existing), existing: true })
      if (state.nodes.filter(node => node.owner === currentActor.username).length >= MAX_PERSONAL_NODES) throw new HttpError(400, '每个账号最多同步 200 条个人线路')
      persistState({ ...state, nodes: [...state.nodes, created] })
      return send(res, 201, { node: safeNode(currentActor, created) })
    }
    const nodeMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)$/)
    if (req.method === 'PATCH' && nodeMatch) {
      requirePersonal(actor)
      const body = await readBody(req)
      const currentActor = requireCurrentActor(req)
      requirePersonal(currentActor)
      const node = findNode(currentActor, decodeName(nodeMatch[1]))
      if (node.private) throw new HttpError(403, '私有线路请使用备注接口；root 可通过专属接口管理')
      const updated = updateNode(node, body)
      persistState({ ...state, nodes: state.nodes.map(item => item.id === node.id ? updated : item) })
      return send(res, 200, { node: safeNode(currentActor, updated) })
    }
    if (req.method === 'DELETE' && nodeMatch) {
      requirePersonal(actor)
      const node = findNode(actor, decodeName(nodeMatch[1]))
      if (node.private) throw new HttpError(403, '只有 root 可以通过专属接口删除私有线路')
      persistState({ ...state, nodes: state.nodes.filter(item => item.id !== node.id) })
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/private-nodes') {
      requireRoot(actor)
      const body = await readBody(req)
      const currentActor = requireCurrentActor(req)
      requireRoot(currentActor)
      onlyFields(body, ['sourceNodeId', 'uri', 'name', 'note'])
      if (('sourceNodeId' in body) === ('uri' in body)) throw new HttpError(400, '请提供 sourceNodeId 或 uri，不能同时提供')
      let source
      if ('sourceNodeId' in body) {
        source = state.nodes.find(node => node.id === body.sourceNodeId && !node.private && node.owner === currentActor.username)
        if (!source) throw new HttpError(404, '只能将 root 自己的个人线路转为私有线路')
      }
      const created = source ? { ...source, owner: null, private: true,
        name: nodeText(body.name, '线路名称', 100, source.name) || '未命名线路', note: nodeText(body.note, '线路备注', 500, source.note), revision: source.revision + 1, updatedAt: new Date().toISOString() } : newNode(body.uri, null, body)
      const existing = state.nodes.find(node => node.private && nodeUri(node.uri).key === nodeUri(created.uri).key)
      if (existing) throw new HttpError(409, '该私有线路已存在')
      if (state.nodes.filter(node => node.private).length >= MAX_PERSONAL_NODES) throw new HttpError(400, '最多配置 200 条私有线路')
      persistState({ ...state, nodes: [...state.nodes.filter(node => node.id !== source?.id), created] })
      return send(res, 201, { node: safeNode(currentActor, created) })
    }
    const privateMatch = url.pathname.match(/^\/api\/private-nodes\/([^/]+)$/)
    if (req.method === 'PATCH' && privateMatch) {
      requireRoot(actor)
      const body = await readBody(req)
      const currentActor = requireCurrentActor(req)
      requireRoot(currentActor)
      const node = state.nodes.find(item => item.id === decodeName(privateMatch[1]) && item.private)
      if (!node) throw new HttpError(404, '私有线路不存在')
      const updated = updateNode(node, body)
      persistState({ ...state, nodes: state.nodes.map(item => item.id === node.id ? updated : item) })
      return send(res, 200, { node: safeNode(currentActor, updated) })
    }
    if (req.method === 'DELETE' && privateMatch) {
      requireRoot(actor)
      const id = decodeName(privateMatch[1])
      if (!state.nodes.some(node => node.id === id && node.private)) throw new HttpError(404, '私有线路不存在')
      persistState({ ...state, nodes: state.nodes.filter(node => node.id !== id), annotations: state.annotations.filter(item => item.nodeId !== id),
        users: users.map(user => ({ ...user, privateNodeIds: user.privateNodeIds.filter(nodeId => nodeId !== id) })) })
      return send(res, 200, { ok: true })
    }
    const annotationMatch = url.pathname.match(/^\/api\/node-annotations\/([^/]+)$/)
    if (req.method === 'PATCH' && annotationMatch) {
      requirePersonal(actor)
      const body = await readBody(req)
      const currentActor = requireCurrentActor(req)
      requirePersonal(currentActor)
      onlyFields(body, ['name', 'note'], true)
      const node = findNode(currentActor, decodeName(annotationMatch[1]))
      if (!node.private) throw new HttpError(400, '个人线路请直接编辑线路名称和备注')
      const previous = state.annotations.find(item => item.username === currentActor.username && item.nodeId === node.id)
      const annotation = { username: currentActor.username, nodeId: node.id,
        name: nodeText(body.name, '线路名称', 100, previous?.name || ''), note: nodeText(body.note, '线路备注', 500, previous?.note ?? node.note), updatedAt: new Date().toISOString() }
      persistState({ ...state, annotations: [...state.annotations.filter(item => item.username !== currentActor.username || item.nodeId !== node.id), annotation] })
      return send(res, 200, { node: safeNode(currentActor, node) })
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
