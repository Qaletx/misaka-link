'use strict'

// Standalone: upload server.js + .env and run node server.js (no npm install).
// Optional managed Hysteria2 authentication and accounting also use Node built-ins.
const http = require('http')
const https = require('https')
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
const LOGIN_LOG_DIR = path.join(__dirname, 'logs')
function logSetting(name, fallback, max) {
  const value = process.env[name] || String(fallback)
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(name + ' 必须是 1-' + max + ' 的整数')
  return Number(value)
}
const LOGIN_LOG_DAYS = logSetting('MISAKA_LOGIN_LOG_RETENTION_DAYS', 30, 365)
const LOGIN_LOG_BYTES = logSetting('MISAKA_LOGIN_LOG_MAX_MB', 5, 50) * 1024 * 1024
const LOGIN_LOG_FILES = logSetting('MISAKA_LOGIN_LOG_FILES_PER_DAY', 3, 10)
let lastLoginLogPrune = '', lastLoginLogWarning = 0

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
  constructor(status, message, code) { super(message); this.status = status; this.code = code }
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
    if (!user.uid) user.uid = crypto.randomUUID()
    if (user.quotaBytes === undefined) user.quotaBytes = null
    if (typeof user.uid !== 'string' || !/^[a-f0-9-]{36}$/.test(user.uid) || (user.quotaBytes !== null && (!Number.isSafeInteger(user.quotaBytes) || user.quotaBytes < 0))) throw new Error('用户额度记录无效，请从备份恢复')
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
    if (!value || ![2,3].includes(value.schemaVersion) || !Array.isArray(value.nodes) || !Array.isArray(value.annotations)) throw new Error('data/state.json 格式无效，请从备份恢复')
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
    if (value.schemaVersion === 2) {
      fs.copyFileSync(STATE_FILE, path.join(DATA_DIR, 'state-v2-backup-' + Date.now() + '.json'))
      value.schemaVersion = 3; value.traffic = emptyTraffic(); saveState(value)
    }
    if (!value.traffic || !['epochs','identities','cursors','periods','baselines'].every(key => value.traffic[key] && typeof value.traffic[key] === 'object' && !Array.isArray(value.traffic[key]))) throw new Error('流量数据库格式无效，请从备份恢复')
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
  validateUsers(seededUsers)
  const value = { schemaVersion: 3, users: seededUsers, nodes: PRIVATE_NODE_URI ? [newNode(PRIVATE_NODE_URI, null, { name: '默认专属线路' }, 'misaka')] : [], annotations: [], traffic: emptyTraffic() }
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
    if (session.expiresAt <= now || !isActive(users.find(user => user.username === session.username), now)) revokeSession(token,session)
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

// Deliberately whitelist metadata: never serialize request bodies, passwords,
// Authorization headers, tokens, session IDs, salts or password hashes.
const LOGIN_REASONS = {
  SUCCESS: '账号和密码验证成功',
  BAD_PASSWORD: '密码不匹配',
  ACCOUNT_NOT_FOUND: '账号不存在',
  ACCOUNT_DISABLED: '账号已停用',
  ACCOUNT_EXPIRED: '账号已过期',
  RATE_LIMITED: '来源 IP 登录尝试过多，已限流',
  INVALID_INPUT: '账号或密码格式无效',
  INVALID_DEVICE: '客户端设备信息格式无效',
  INVALID_JSON: '请求体不是有效的 JSON 对象',
  BODY_TOO_LARGE: '请求体超过 64 KiB',
  BODY_READ_ERROR: '读取登录请求失败',
  REQUEST_ABORTED: '客户端在发送请求时中断连接',
  CLIENT_DISCONNECTED: '客户端在收到完整响应前断开连接',
  CORS_BLOCKED: '浏览器 Origin 不在服务端允许列表中',
  PREFLIGHT_OK: '浏览器预检通过，尚未校验账号密码',
  METHOD_NOT_ALLOWED: '客户端使用了不支持的登录请求方法',
  SESSION_LIMIT: '服务器登录会话数量已达上限',
  INTERNAL_ERROR: '服务器内部错误，请结合 PM2 错误日志排查',
  REQUEST_REJECTED: '服务器拒绝了登录请求',
}
function beijingTime(now) { return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') + '+08:00' }
function auditText(value, max = 200, secret = '') {
  if (typeof value !== 'string') return ''
  let result = value
  if (secret.length >= 4) result = result.split(secret).join('[已隐藏]')
  return result.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]').slice(0, max)
}
function writeLoginAudit(record) {
  const line = JSON.stringify(record) + '\n'
  // PM2 and the panel already capture stdout, so the same request ID is
  // searchable there even if disk permissions prevent the JSONL copy.
  console.log('LOGIN_AUDIT ' + line.trimEnd())
  try {
    const day = record.beijingTime.slice(0, 10)
    fs.mkdirSync(LOGIN_LOG_DIR, { recursive: true, mode: 0o700 })
    if (lastLoginLogPrune !== day) {
      const oldest = beijingTime(Date.now() - (LOGIN_LOG_DAYS - 1) * 86400000).slice(0, 10)
      for (const name of fs.readdirSync(LOGIN_LOG_DIR)) {
        const match = name.match(/^login-(\d{4}-\d{2}-\d{2})(?:\.[1-9]\d*)?\.jsonl$/)
        if (match && match[1] < oldest) fs.unlinkSync(path.join(LOGIN_LOG_DIR, name))
      }
      lastLoginLogPrune = day
    }
    const file = path.join(LOGIN_LOG_DIR, `login-${day}.jsonl`)
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > LOGIN_LOG_BYTES) {
      if (LOGIN_LOG_FILES === 1) fs.unlinkSync(file)
      else {
        const oldest = path.join(LOGIN_LOG_DIR, `login-${day}.${LOGIN_LOG_FILES - 1}.jsonl`)
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest)
        for (let part = LOGIN_LOG_FILES - 2; part >= 1; part--) {
          const source = path.join(LOGIN_LOG_DIR, `login-${day}.${part}.jsonl`)
          if (fs.existsSync(source)) fs.renameSync(source, path.join(LOGIN_LOG_DIR, `login-${day}.${part + 1}.jsonl`))
        }
        fs.renameSync(file, path.join(LOGIN_LOG_DIR, `login-${day}.1.jsonl`))
      }
    }
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    if (Date.now() - lastLoginLogWarning > 60000) {
      lastLoginLogWarning = Date.now()
      console.error('LOGIN_AUDIT_WRITE_FAILED', /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'LOG_IO_ERROR')
    }
  }
}
function startLoginAudit(req, res) {
  let route
  try { route = new URL(req.url, 'http://localhost').pathname } catch { return null }
  if (route !== '/api/login') return null
  const started = Date.now(), id = crypto.randomUUID()
  const peer = normalizeAddress(req.socket.remoteAddress || 'unknown'), clientIp = clientAddress(req)
  const audit = { id, started, code: !['POST','OPTIONS'].includes(req.method) ? 'METHOD_NOT_ALLOWED' : '', authentication: 'not_checked', username: '', device: {}, deviceReported: false, hints: [] }
  res.setHeader('X-Qaletx-Request-Id', id)
  const record = delivered => {
    if (audit.recorded) return
    audit.recorded = true
    const now = Date.now(), status = res.headersSent ? res.statusCode : null
    let code = audit.code || (req.method !== 'POST' && req.method !== 'OPTIONS' ? 'METHOD_NOT_ALLOWED' : 'REQUEST_REJECTED')
    if (!delivered) code = req.aborted ? 'REQUEST_ABORTED' : 'CLIENT_DISCONNECTED'
    const device = audit.device
    writeLoginAudit({ schemaVersion: 1, event: req.method === 'OPTIONS' ? 'login_preflight' : 'login_attempt',
      requestId: id, time: new Date(now).toISOString(), beijingTime: beijingTime(now), startedAt: new Date(started).toISOString(), durationMs: now - started,
      method: auditText(req.method, 16), path: '/api/login', username: audit.username, deviceReported: audit.deviceReported,
      deviceId: device.id || null, deviceName: device.name || '未提供设备名称', platform: device.platform || 'unknown', clientVersion: device.version || '未提供客户端版本',
      clientIp, peerIp: peer, trustedProxy: TRUSTED_PROXIES.has(peer),
      userAgent: auditText(req.headers['user-agent'], 200, audit.secret), origin: auditText(req.headers.origin, 200, audit.secret),
      result: delivered && status >= 200 && status < 300 ? 'success' : 'failure', authentication: audit.authentication,
      httpStatus: status, responseFinished: delivered, reasonCode: code, reason: LOGIN_REASONS[code] || LOGIN_REASONS.REQUEST_REJECTED, inputHints: audit.hints })
    delete audit.secret
  }
  res.once('finish', () => record(true))
  res.once('close', () => record(false))
  return audit
}
function captureLoginAudit(audit, body) {
  if (!audit) return
  const secret = typeof body.password === 'string' ? body.password : ''
  audit.secret = secret
  audit.username = auditText(typeof body.username === 'string' ? body.username.trim() : '', 64, secret).toLowerCase()
  if (typeof body.username === 'string' && body.username !== body.username.trim()) audit.hints.push('USERNAME_OUTER_WHITESPACE')
  if (secret && secret !== secret.trim()) audit.hints.push('PASSWORD_OUTER_WHITESPACE')
  if (/[^\x20-\x7e]/.test(secret)) audit.hints.push('PASSWORD_NON_ASCII')
  const device = body.device
  audit.deviceReported = Boolean(device && typeof device === 'object' && !Array.isArray(device))
  if (audit.deviceReported) audit.device = {
    id: typeof device.id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(device.id) ? auditText(device.id, 80, secret) : '',
    name: auditText(device.name, 80, secret), platform: auditText(device.platform, 32, secret), version: auditText(device.version, 32, secret),
  }
}
function loginAuditError(audit, error) {
  if (!audit || audit.code) return
  audit.code = !(error instanceof HttpError) ? 'INTERNAL_ERROR' : LOGIN_REASONS[error.code] ? error.code : error.status === 429 ? 'RATE_LIMITED'
    : error.status === 413 ? 'BODY_TOO_LARGE' : error.status === 400 ? 'INVALID_JSON' : 'REQUEST_REJECTED'
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
  for (const [token, session] of sessions) if (session.username === username) revokeSession(token, session)
}
function safeUser(user) {
  return { username: user.username, role: user.role, isRoot: user.username === 'root', privateNodeAccess: user.privateNodeAccess, privateNodeIds: [...user.privateNodeIds], disabled: user.disabled === true, expiresAt: user.expiresAt || null, quotaBytes: user.quotaBytes, createdAt: user.createdAt, updatedAt: user.updatedAt, permissions: { manageUsers: user.role === 'admin', managePrivateNodes: user.username === 'root', changePassword: user.role !== 'shared', syncNodes: user.role !== 'shared' } }
}
function issueToken(username, device = {}) {
  pruneSessions()
  const owned = [...sessions].filter(([, session]) => session.username === username)
  const limit = users.find(user => user.username === username)?.role === 'shared' ? MAX_SHARED_SESSIONS : MAX_USER_SESSIONS
  while (owned.length >= limit) {const [key, value] = owned.shift(); revokeSession(key, value)}
  if (sessions.size >= MAX_SESSIONS) throw new HttpError(503, '登录会话已达上限，请稍后再试')
  const token = crypto.createHmac('sha256', TOKEN_SECRET).update(crypto.randomBytes(32)).digest('base64url')
  const now = Date.now()
  sessions.set(token, { id: crypto.randomUUID(), username, expiresAt: now + SESSION_MS, createdAt: now, lastSeenAt: now,
    deviceId: typeof device.id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(device.id) ? device.id : null,
    name: nodeText(device.name, '设备名称', 80, '未命名设备') || '未命名设备', platform: nodeText(device.platform, '系统名称', 32, 'unknown'), version: nodeText(device.version, '客户端版本', 32, '旧版客户端') })
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
  if (session.expiresAt <= Date.now() || !isActive(user)) { revokeSession(token,session); return null }
  session.lastSeenAt = Date.now()
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
    return Promise.reject(new HttpError(413, '请求内容过大，最大 64 KiB', 'BODY_TOO_LARGE'))
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
      if (size > MAX_BODY_BYTES) return fail(new HttpError(413, '请求内容过大，最大 64 KiB', 'BODY_TOO_LARGE'))
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (finished) return
      let body
      try { body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} }
      catch { return fail(new HttpError(400, '请求必须是有效的 JSON', 'INVALID_JSON')) }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(new HttpError(400, '请求必须是 JSON 对象', 'INVALID_JSON'))
      finished = true
      chunks = []
      resolve(body)
    })
    req.on('error', () => fail(new HttpError(400, '请求读取失败', 'BODY_READ_ERROR')))
    req.on('aborted', () => fail(new HttpError(400, '请求已中断', 'REQUEST_ABORTED')))
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
    protocol: node.protocol, private: node.private, managedServiceId: node.managedServiceId || null, metered: Boolean(node.managedServiceId), ...(!node.private ? { uri: node.uri } : {}), updatedAt: annotation?.updatedAt || node.updatedAt, revision: node.revision }
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

function emptyTraffic() { return { epochs: {}, accessEpochs: {}, identities: {}, cursors: {}, periods: {}, baselines: {}, gaps: [] } }
const managedServices = new Map()
const pendingKicks = new Map()
let collecting = false
let managedConfiguration
try { managedConfiguration = JSON.parse(process.env.MISAKA_HY2_SERVICES || '[]') } catch { throw new Error('MISAKA_HY2_SERVICES 必须为 JSON 数组') }
if (!Array.isArray(managedConfiguration) || managedConfiguration.length > 20) throw new Error('最多接管 20 个 Hysteria2 服务')
for (const item of managedConfiguration) {
  let url
  try { url = new URL(item.statsUrl) } catch { throw new Error('Hysteria2 统计地址无效') }
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(item.id) || managedServices.has(item.id) || !['http:','https:'].includes(url.protocol)
    || !['127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || typeof item.secret !== 'string' || item.secret.length < 16 || /[\r\n]/.test(item.secret)) throw new Error('Hysteria2 接管配置无效：统计接口须绑定回环地址，并设置至少 16 位密钥')
  managedServices.set(item.id, { id: item.id, url: url.origin, secret: item.secret, lastSampleAt: null, error: '', online: {} })
}
const AUTH_PORT = Number(process.env.MISAKA_HY2_AUTH_PORT || 8788)
const POLL_MS = Number(process.env.MISAKA_HY2_POLL_MS || 5000)
if (!Number.isInteger(AUTH_PORT) || AUTH_PORT < 1 || AUTH_PORT > 65535 || (managedServices.size && AUTH_PORT === PORT)) throw new Error('Hysteria2 内部鉴权端口无效或与账号端口重复')
if (!Number.isInteger(POLL_MS) || POLL_MS < 250 || POLL_MS > 10000) throw new Error('流量采样间隔必须为 250–10000 毫秒')
function quotaPeriod(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(now)
  return parts.find(x => x.type === 'year').value + '-' + parts.find(x => x.type === 'month').value
}
function serviceEpoch(id) { return Object.prototype.hasOwnProperty.call(state.traffic.epochs,id) ? state.traffic.epochs[id] : null }
function knownIdentity(id) { return Object.prototype.hasOwnProperty.call(state.traffic.identities,id) ? state.traffic.identities[id] : null }
function userUsage(user) {
  const period = quotaPeriod(), key = period + ':' + user.uid
  const total = state.traffic.periods[key] || { up: 0, down: 0 }
  const baseline = state.traffic.baselines[key] || 0
  const usedBytes = Math.max(0, total.up + total.down - baseline)
  const relevant = [...new Set(state.nodes.filter(node => node.private && node.managedServiceId && allowedNode(user,node)).map(node => node.managedServiceId))].map(id=>managedServices.get(id)).filter(Boolean)
  return { period, timezone: 'Asia/Shanghai', uploadBytes: total.up, downloadBytes: total.down, usedBytes,
    quotaBytes: user.username === 'root' ? null : user.quotaBytes, exceeded: user.username !== 'root' && user.quotaBytes !== null && usedBytes >= user.quotaBytes,
    warning: user.quotaBytes > 0 ? usedBytes / user.quotaBytes >= .95 ? 'critical' : usedBytes / user.quotaBytes >= .8 ? 'near' : null : null,
    metered: relevant.length > 0, live: relevant.length > 0 && relevant.every(s=>s.lastSampleAt && Date.now()-s.lastSampleAt<30000),
    sampledAt: relevant.length ? Math.min(...relevant.map(s=>s.lastSampleAt || 0)) || null : null }
}
function requestManaged(service, route, body) {
  return new Promise((resolve,reject) => {
    const content = body === undefined ? undefined : JSON.stringify(body)
    const target = new URL(route, service.url)
    const req = (target.protocol === 'https:' ? https : http).request(target, { method: content ? 'POST' : 'GET', timeout: 1800,
      headers: { Authorization: service.secret, ...(content ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(content)} : {}) } }, res => {
      let data = ''
      res.on('data', chunk => {data+=chunk;if(Buffer.byteLength(data)>4*1024*1024)req.destroy(new Error('响应过大'))})
      res.on('error',reject)
      res.on('end',()=>{if(res.statusCode!==200)return reject(new Error('统计接口请求失败'));try{resolve(data?JSON.parse(data):{})}catch{reject(new Error('统计接口数据无效'))}})
    })
    req.on('timeout',()=>req.destroy(new Error('统计接口超时')));req.on('error',reject);req.end(content)
  })
}
function enqueueKick(serviceId,id) {const ids=pendingKicks.get(serviceId)||new Set();ids.add(id);pendingKicks.set(serviceId,ids)}
function revokeSession(token,session) {
  sessions.delete(token)
  for(const [id,identity] of Object.entries(state.traffic.identities))if(identity.sid===session.id)enqueueKick(identity.serviceId,id)
  flushKicks().catch(()=>{})
}
let flushing=false
async function flushKicks() {
  if(flushing)return;flushing=true
  try { await Promise.all([...pendingKicks].map(async([serviceId,ids])=>{
    const service=managedServices.get(serviceId);if(!service||!ids.size)return
    const batch=[...ids]
    try{await requestManaged(service,'/kick',batch);for(const id of batch)ids.delete(id)}catch{service.error='连接撤销尚未完成，正在重试'}
  })) } finally {flushing=false}
}
function credential(session,node) {
  const encoded=Buffer.from(node.id).toString('base64url')
  const prefix=`ql1.${session.id}.${encoded}`
  return prefix+'.'+crypto.createHmac('sha256',TOKEN_SECRET).update('hy2:'+prefix).digest('base64url')
}
function managedUri(req,user,node) {
  if(!node.managedServiceId)return node.uri
  const service=managedServices.get(node.managedServiceId),usage=userUsage(user)
  if(!service||!serviceEpoch(service.id))throw new HttpError(503,'这条线路尚未完成服务端接管，请联系管理员','METER_UNREADY')
  if(usage.exceeded)throw new HttpError(403,'本月私有线路流量额度已用完，请联系管理员','QUOTA_EXCEEDED')
  if(user.quotaBytes!==null && (!service.lastSampleAt||Date.now()-service.lastSampleAt>=30000))throw new HttpError(503,'线路计量服务暂时不可用，请稍后重试','METER_OFFLINE')
  const session=sessions.get(bearer(req)),url=new URL(node.uri)
  url.username=credential(session,node);url.password='';url.searchParams.delete('auth');return url.href
}
function identityAllowed(identity) {
  const session=[...sessions.values()].find(s=>s.id===identity.sid),user=users.find(u=>u.uid===identity.uid),node=state.nodes.find(n=>n.id===identity.nodeId)
  return session&&session.expiresAt>Date.now()&&isActive(user)&&node&&node.managedServiceId===identity.serviceId&&allowedNode(user,node)&&!userUsage(user).exceeded
    &&identity.period===quotaPeriod()&&identity.accessEpoch===(state.traffic.accessEpochs?.[user.uid]||'initial')
    &&identity.bindingEpoch===(node.bindingEpoch||'initial')
}
async function collectTraffic() {
  if(collecting)return;collecting=true
  try{await Promise.all([...managedServices.values()].map(async service=>{
    try{
      const [counters,online]=await Promise.all([requestManaged(service,'/traffic'),requestManaged(service,'/online')])
      if(!counters||typeof counters!=='object'||Array.isArray(counters)||!online||typeof online!=='object'||Array.isArray(online))throw new Error('数据无效')
      for(const value of Object.values(counters))if(!value||!Number.isSafeInteger(value.tx)||value.tx<0||!Number.isSafeInteger(value.rx)||value.rx<0)throw new Error('计数器无效')
      for(const value of Object.values(online))if(!Number.isSafeInteger(value)||value<0)throw new Error('在线数据无效')
      const next=JSON.parse(JSON.stringify(state)),traffic=next.traffic,period=quotaPeriod()
      const enforceUnknown=Boolean(serviceEpoch(service.id))&&state.nodes.some(node=>node.private&&node.managedServiceId===service.id)
      for(const [id,value] of Object.entries(counters)){
        const identity=knownIdentity(id);if(!identity||identity.serviceId!==service.id){if(enforceUnknown&&online[id])enqueueKick(service.id,id);continue}
        const previous=traffic.cursors[id]||{tx:0,rx:0}
        const reset=value.tx<previous.tx||value.rx<previous.rx
        const up=reset?value.tx:value.tx-previous.tx,down=reset?value.rx:value.rx-previous.rx
        if(reset)traffic.gaps=[...(traffic.gaps||[]),{serviceId:service.id,time:Date.now(),reason:'计数器重置，已记录采样缺口'}].slice(-50)
        const key=period+':'+identity.uid,total=traffic.periods[key]||{up:0,down:0}
        total.up+=up;total.down+=down
        if(!Number.isSafeInteger(total.up)||!Number.isSafeInteger(total.down))throw new Error('累计值越界')
        traffic.periods[key]=total;traffic.cursors[id]={tx:value.tx,rx:value.rx}
      }
      persistState(next);service.online=online;service.lastSampleAt=Date.now();service.error=''
      for(const [id,count] of Object.entries(online))if(count&&(knownIdentity(id)?!identityAllowed(knownIdentity(id)):enforceUnknown))enqueueKick(service.id,id)
    }catch{service.error='统计接口暂时不可用，请检查节点服务';service.online={}}
  }));await flushKicks()}finally{collecting=false}
}
function safeSession(value,current) {
  const identities=Object.entries(state.traffic.identities).filter(([,i])=>i.sid===value.id)
  const online=identities.some(([id,i])=>{const service=managedServices.get(i.serviceId);return service?.lastSampleAt&&Date.now()-service.lastSampleAt<30000&&service.online[id]>0})
  return {id:value.id,deviceId:value.deviceId,name:value.name,platform:value.platform,version:value.version,createdAt:new Date(value.createdAt).toISOString(),lastSeenAt:new Date(value.lastSeenAt).toISOString(),expiresAt:new Date(value.expiresAt).toISOString(),current:value.id===current?.id,proxyOnline:online}
}
async function managementRoute(req,res,url,actor) {
  if(req.method==='GET'&&url.pathname==='/api/me/usage'){send(res,200,{usage:userUsage(actor)});return true}
  if(req.method==='GET'&&url.pathname==='/api/me/sessions'){
    const current=sessions.get(bearer(req));send(res,200,{sessions:[...sessions.values()].filter(s=>s.username===actor.username&&(actor.role!=='shared'||s.id===current.id)).map(s=>safeSession(s,current))});return true
  }
  const deviceMatch=url.pathname.match(/^\/api\/users\/([^/]+)\/sessions$/)
  if(req.method==='GET'&&deviceMatch){
    const target=users.find(u=>u.username===decodeName(deviceMatch[1]));if(!target)throw new HttpError(404,'用户不存在');manageable(actor,target)
    send(res,200,{sessions:[...sessions.values()].filter(s=>s.username===target.username).map(s=>safeSession(s,sessions.get(bearer(req))))});return true
  }
  const sessionMatch=url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
  if(req.method==='DELETE'&&sessionMatch){
    const found=[...sessions].find(([,s])=>s.id===sessionMatch[1]);if(!found)throw new HttpError(404,'会话已退出')
    const target=users.find(u=>u.username===found[1].username),current=sessions.get(bearer(req))
    if(actor.username!==target?.username)manageable(actor,target)
    else if(actor.role==='shared'&&found[1].id!==current.id)throw new HttpError(403,'共用账号不能退出其他使用者')
    revokeSession(...found);send(res,200,{ok:true,current:found[1].id===current.id});return true
  }
  const usageMatch=url.pathname.match(/^\/api\/users\/([^/]+)\/(usage|quota|quota\/reset)$/)
  if(usageMatch){
    const target=users.find(u=>u.username===decodeName(usageMatch[1]));if(!target)throw new HttpError(404,'用户不存在');manageable(actor,target)
    if(req.method==='GET'&&usageMatch[2]==='usage'){send(res,200,{usage:userUsage(target)});return true}
    if(target.username==='root')throw new HttpError(400,'root 账号保持不限额')
    if(req.method==='PATCH'&&usageMatch[2]==='quota'){
      const body=await readBody(req),currentActor=requireCurrentActor(req);onlyFields(body,['quotaBytes'],true)
      if(body.quotaBytes!==null&&(!Number.isSafeInteger(body.quotaBytes)||body.quotaBytes<0))throw new HttpError(400,'quotaBytes 必须为非负整数字节数，或 null 表示不限额')
      const latest=users.find(u=>u.uid===target.uid);if(!latest)throw new HttpError(404,'用户不存在')
      manageable(currentActor,latest)
      const wasExceeded=userUsage(latest).exceeded
      const updated={...latest,quotaBytes:body.quotaBytes,updatedAt:new Date().toISOString()}
      const nextTraffic=wasExceeded&&!userUsage(updated).exceeded?{...state.traffic,accessEpochs:{...state.traffic.accessEpochs,[latest.uid]:crypto.randomBytes(8).toString('hex')}}:state.traffic
      persistState({...state,users:users.map(u=>u.uid===latest.uid?updated:u),traffic:nextTraffic})
      await collectTraffic();send(res,200,{ok:true,usage:userUsage(users.find(u=>u.uid===target.uid))});return true
    }
    if(req.method==='POST'&&usageMatch[2]==='quota/reset'){
      const body=await readBody(req),latest=users.find(u=>u.uid===target.uid);if(!latest)throw new HttpError(404,'用户不存在');manageable(requireCurrentActor(req),latest);onlyFields(body,[])
      const key=quotaPeriod()+':'+target.uid,total=state.traffic.periods[key]||{up:0,down:0}
      persistState({...state,traffic:{...state.traffic,baselines:{...state.traffic.baselines,[key]:total.up+total.down},accessEpochs:{...state.traffic.accessEpochs,[target.uid]:crypto.randomBytes(8).toString('hex')}}})
      send(res,200,{ok:true,usage:userUsage(latest)});return true
    }
  }
  if(req.method==='GET'&&url.pathname==='/api/managed-services'){
    requireRoot(actor);send(res,200,{services:[...managedServices.values()].map(s=>({id:s.id,ready:Boolean(serviceEpoch(s.id)),sampledAt:s.lastSampleAt,error:s.error})),gaps:state.traffic.gaps||[]});return true
  }
  return false
}
const server = http.createServer(async (req, res) => {
  const loginAudit = startLoginAudit(req, res)
  try {
    const origin = req.headers.origin
    if (origin && !CORS_ORIGINS.includes('*') && !CORS_ORIGINS.includes(origin)) {
      if (loginAudit) loginAudit.code = 'CORS_BLOCKED'
      throw new HttpError(403, '不允许此页面来源')
    }
    res.setHeader('Vary', 'Origin')
    if (origin) res.setHeader('Access-Control-Allow-Origin', CORS_ORIGINS.includes('*') ? '*' : origin)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') { if (loginAudit) loginAudit.code = 'PREFLIGHT_OK'; return send(res, 204) }
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { throw new HttpError(400, '请求路径无效') }
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, service: 'qaletx-link-server', time: new Date().toISOString(), loginAudit: true })
    if (req.method === 'POST' && url.pathname === '/api/login') {
      requireAttempt(req)
      const body = await readBody(req)
      captureLoginAudit(loginAudit, body)
      const { username, password, device } = body
      if(device!==undefined&&(!device||typeof device!=='object'||Array.isArray(device))){loginAudit.code='INVALID_DEVICE';throw new HttpError(400,'设备信息格式无效')}
      if (typeof username !== 'string' || username.length > 64 || !passwordValid(password)) { loginAudit.code='INVALID_INPUT'; throw new HttpError(400, '账号或密码格式不正确') }
      const user = users.find(item => item.username === username.trim().toLowerCase())
      const correct = verifyPassword(password, user || dummyPassword)
      if (!user || !correct) { loginAudit.authentication='failure';loginAudit.code=user?'BAD_PASSWORD':'ACCOUNT_NOT_FOUND';throw new HttpError(401, '用户名或密码不正确') }
      if (!isActive(user)) { loginAudit.authentication='failure';loginAudit.code=user.disabled?'ACCOUNT_DISABLED':'ACCOUNT_EXPIRED';throw new HttpError(403, user.disabled ? '账号已停用，请联系管理员' : '账号已到期，请联系管理员') }
      let token
      try { token = issueToken(user.username,device) }
      catch(error){loginAudit.code=error.status===503?'SESSION_LIMIT':error.status===400?'INVALID_DEVICE':'INTERNAL_ERROR';throw error}
      loginAudit.authentication='success';loginAudit.code='SUCCESS'
      return send(res, 200, { token, user: safeUser(user) })
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const token=bearer(req),session=sessions.get(token);if(session)revokeSession(token,session)
      return send(res, 200, { ok: true })
    }
    const actor = requireCurrentActor(req)
    if(await managementRoute(req,res,url,actor))return
    if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, { user: safeUser(actor), capabilities:{usage:true,sessions:true,managedHysteria:managedServices.size>0} })
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
      return send(res, 200, { userCount: visible.length, activeSessions: [...sessions.values()].filter(session => visible.some(user => user.username === session.username)).length, uptime: process.uptime(),
        usage:visible.map(user=>({username:user.username,...userUsage(user)})),trafficTotalBytes:Object.entries(state.traffic.periods).filter(([key])=>key.startsWith(quotaPeriod()+':')&&(actor.username==='root'||visible.some(u=>key===quotaPeriod()+':'+u.uid))).reduce((sum,[,value])=>sum+value.up+value.down,0),services:[...managedServices.values()].map(s=>({id:s.id,sampledAt:s.lastSampleAt,error:s.error})),pendingRevocations:[...pendingKicks.values()].reduce((sum,ids)=>sum+ids.size,0),gaps:state.traffic.gaps||[] })
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
      const record = userChanges(body, currentActor, { uid:crypto.randomUUID(),quotaBytes:null,username: cleanName, role: 'user', ...hashPassword(body.password), privateNodeAccess: false, privateNodeIds: [], disabled: false, expiresAt: null, createdAt: now, updatedAt: now })
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
      const changedGrant=record.privateNodeAccess!==updated.privateNodeAccess||[...record.privateNodeIds].sort().join(',')!==[...updated.privateNodeIds].sort().join(',')
      const traffic=changedGrant?{...state.traffic,accessEpochs:{...state.traffic.accessEpochs,[record.uid]:crypto.randomBytes(8).toString('hex')}}:state.traffic
      persistState({...state,traffic,users:users.map(user => user.username === target ? updated : user)})
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
      return send(res, 200, { uri: managedUri(req,actor,node), node: metadata })
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
      onlyFields(body,['name','note','revision','managedServiceId']);checkRevision(body,node)
      let updated = 'name' in body||'note' in body ? updateNode(node,Object.fromEntries(Object.entries(body).filter(([key])=>key!=='managedServiceId'))) : {...node,revision:node.revision+1,updatedAt:new Date().toISOString()}
      if('managedServiceId' in body){
        if(body.managedServiceId!==null&&(!managedServices.has(body.managedServiceId)||node.protocol!=='hysteria2'))throw new HttpError(400,'只能将 Hysteria2 私有线路绑定到已配置的接管服务')
        updated.managedServiceId=body.managedServiceId
        if(updated.managedServiceId!==node.managedServiceId)updated.bindingEpoch=crypto.randomBytes(8).toString('hex')
      }
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
    loginAuditError(loginAudit, error)
    if (error instanceof HttpError) return send(res, error.status, { error: error.message, ...(error.code?{code:error.code}:{}), ...(loginAudit?{requestId:loginAudit.id}:{}) })
    console.error('API error:', error.code || error.name)
    return send(res, 500, { error: '服务器内部错误，请查看服务日志', ...(loginAudit?{requestId:loginAudit.id}:{}) })
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

if(managedServices.size){
  const authServer=http.createServer(async(req,res)=>{
    let bootRequest=false
    try{
      const match=new URL(req.url,'http://localhost').pathname.match(/^\/(auth|boot)\/([a-z][a-z0-9_-]{0,31})$/)
      if(req.method!=='POST'||!match||!managedServices.has(match[2]))return send(res,200,{ok:false})
      const service=managedServices.get(match[2]),body=await readBody(req)
      if(match[1]==='boot'){
        bootRequest=true
        const epoch=crypto.randomBytes(8).toString('hex')
        persistState({...state,traffic:{...state.traffic,epochs:{...state.traffic.epochs,[service.id]:epoch},gaps:[...(state.traffic.gaps||[]),{serviceId:service.id,time:Date.now(),reason:'节点服务启动，计数器已切换代次'}].slice(-50)}})
        service.lastSampleAt=null;service.online={};return send(res,200,{ok:true})
      }
      if(typeof body.auth!=='string'||body.auth.length>1024)return send(res,200,{ok:false})
      const parts=body.auth.split('.');if(parts.length!==4||parts[0]!=='ql1')return send(res,200,{ok:false})
      const prefix=parts.slice(0,3).join('.'),expected=crypto.createHmac('sha256',TOKEN_SECRET).update('hy2:'+prefix).digest(),supplied=Buffer.from(parts[3],'base64url')
      if(expected.length!==supplied.length||!crypto.timingSafeEqual(expected,supplied))return send(res,200,{ok:false})
      const session=[...sessions.values()].find(s=>s.id===parts[1]),nodeId=Buffer.from(parts[2],'base64url').toString('utf8'),node=state.nodes.find(n=>n.id===nodeId),user=users.find(u=>u.username===session?.username),epoch=serviceEpoch(service.id)
      if(!session||session.expiresAt<=Date.now()||!isActive(user)||!epoch||!node?.private||node.managedServiceId!==service.id||!allowedNode(user,node)||userUsage(user).exceeded)return send(res,200,{ok:false})
      if(user.quotaBytes!==null&&(!service.lastSampleAt||Date.now()-service.lastSampleAt>=30000))return send(res,200,{ok:false})
      const period=quotaPeriod(),accessEpoch=state.traffic.accessEpochs?.[user.uid]||'initial'
      const bindingEpoch=node.bindingEpoch||'initial',id=`q.${epoch}.${period}.${accessEpoch}.${bindingEpoch}.${session.id}.${parts[2]}`
      if(!state.traffic.identities[id])persistState({...state,traffic:{...state.traffic,identities:{...state.traffic.identities,[id]:{sid:session.id,uid:user.uid,username:user.username,nodeId:node.id,serviceId:service.id,period,accessEpoch,bindingEpoch}}}})
      return send(res,200,{ok:true,id})
    }catch{return send(res,bootRequest?503:200,{ok:false})}
  })
  authServer.requestTimeout=5000;authServer.headersTimeout=5000
  authServer.on('error',()=>{console.error('内部鉴权端口无法启动，请检查 MISAKA_HY2_AUTH_PORT');server.close();process.exitCode=1})
  authServer.listen(AUTH_PORT,'127.0.0.1')
  const poll=setInterval(()=>collectTraffic().catch(()=>{}),POLL_MS);poll.unref();collectTraffic().catch(()=>{})
}
