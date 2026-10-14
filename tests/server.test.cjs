'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

const SOURCE = path.resolve(__dirname, '..', 'server.js')
const ROOT_PASSWORD = 'test-root-password-!_1'
const USER_PASSWORD = 'test-user-password-!_2'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort() {
  const listener = net.createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qaletx-server-test-'))
  fs.copyFileSync(SOURCE, path.join(directory, 'server.js'))
  const port = await freePort()
  let child
  let output = ''
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) if (key.startsWith('MISAKA_')) delete environment[key]
  const envText = [
    '\uFEFF# Isolated test credentials. No project .env or data is read.',
    'MISAKA_HOST=127.0.0.1',
    'MISAKA_PORT=' + port,
    'MISAKA_TOKEN_SECRET="' + crypto.randomBytes(32).toString('hex') + '"',
    "MISAKA_ROOT_PASSWORD='" + ROOT_PASSWORD + "'",
    'MISAKA_USER_PASSWORD=' + USER_PASSWORD,
    'MISAKA_TRUSTED_PROXIES=' + (options.trustedProxies || ''),
    ''
  ].join('\r\n')
  fs.writeFileSync(path.join(directory, '.env'), envText)
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit')
      child.kill()
      await stopped
    }
  }
  async function start() {
    output = ''
    child = spawn(process.execPath, [path.join(directory, 'server.js')], {
      cwd: os.tmpdir(), env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (output.includes('server listening')) return
      if (child.exitCode !== null) throw new Error('Server failed to start: ' + output)
      await delay(25)
    }
    throw new Error('Server startup timed out: ' + output)
  }
  t.after(async () => {
    await stop()
    const resolved = path.resolve(directory)
    const temporaryRoot = path.resolve(os.tmpdir()) + path.sep
    assert.ok(resolved.startsWith(temporaryRoot) && path.basename(resolved).startsWith('qaletx-server-test-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  async function request(method, endpoint, body, token, extra = {}) {
    const response = await fetch('http://127.0.0.1:' + port + endpoint, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000)
    })
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() }
  }
  async function login(username = 'root', password = ROOT_PASSWORD) {
    const response = await request('POST', '/api/login', { username, password })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body.token
  }
  await start()
  return { directory, port, request, login, start, stop, logs: () => output }
}

test('two-file deployment, complete safeUser, permissions, root protection and CORS', async t => {
  const app = await fixture(t)
  assert.deepEqual(fs.readdirSync(app.directory).sort(), ['.env', 'data', 'server.js'])
  const health = await app.request('GET', '/api/health')
  assert.equal(health.status, 200)
  assert.equal(health.body.ok, true)
  assert.equal(health.headers.get('cache-control'), 'no-store')
  const preflight = await app.request('OPTIONS', '/api/login', undefined, undefined, { Origin: 'null' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'null')
  assert.equal((await app.request('GET', '/api/health', undefined, undefined, { Origin: 'https://untrusted.example' })).status, 403)
  const root = await app.login()
  const user = await app.login('user', USER_PASSWORD)
  const me = await app.request('GET', '/api/me', undefined, user)
  assert.deepEqual(Object.keys(me.body.user).sort(), ['createdAt', 'disabled', 'expiresAt', 'role', 'updatedAt', 'username'])
  assert.equal(me.body.user.disabled, false)
  assert.equal(me.body.user.expiresAt, null)
  for (const [method, endpoint, body] of [
    ['GET', '/api/users'], ['GET', '/api/stats'],
    ['POST', '/api/users', { username: 'newuser', password: 'test-new-password' }],
    ['PATCH', '/api/users/root/password', { password: 'test-new-password' }],
    ['PATCH', '/api/users/root', { disabled: true }],
    ['DELETE', '/api/users/root']
  ]) assert.equal((await app.request(method, endpoint, body, user)).status, 403)
  assert.equal((await app.request('DELETE', '/api/users/root', undefined, root)).status, 400)
  assert.equal((await app.request('PATCH', '/api/users/root', { disabled: true }, root)).status, 400)
  assert.equal((await app.request('PATCH', '/api/users/root', { expiresAt: '2099-01-01T00:00:00Z' }, root)).status, 400)
  const created = await app.request('POST', '/api/users', { username: 'Alice', password: 'test-new-password', role: 'root' }, root)
  assert.equal(created.status, 201)
  assert.equal(created.body.user.username, 'alice')
  assert.equal(created.body.user.role, 'user')
  assert.equal((await app.request('POST', '/api/users', { username: 'alice', password: 'test-new-password' }, root)).status, 409)
  assert.equal((await app.request('PATCH', '/api/users/alice', { role: 'root' }, root)).status, 400)
  assert.equal((await app.request('PATCH', '/api/users/%E0%A4%A/password', { password: 'test-new-password' }, root)).status, 400)
})

test('malformed/type-invalid and oversized bodies return 400/413 without crashing', async t => {
  const app = await fixture(t)
  for (const body of ['{', '[]', 'null', '42', { username: {}, password: USER_PASSWORD }, { username: 'user', password: [] }]) {
    assert.equal((await app.request('POST', '/api/login', body)).status, 400)
  }
  const root = await app.login()
  assert.equal((await app.request('POST', '/api/users', { username: 123, password: 'test-new-password' }, root)).status, 400)
  assert.equal((await app.request('PATCH', '/api/users/user/password', { password: 'x'.repeat(257) }, root)).status, 400)
  assert.equal((await app.request('PATCH', '/api/users/user', { disabled: 'false' }, root)).status, 400)
  assert.equal((await app.request('PATCH', '/api/users/user', { expiresAt: 123 }, root)).status, 400)
  assert.equal((await app.request('PATCH', '/api/users/user', { expiresAt: 'invalid' }, root)).status, 400)
  assert.equal((await app.request('PATCH', '/api/users/user', { expiresAt: '2026-10-14' }, root)).status, 400)
  assert.equal((await app.request('PATCH', '/api/users/user', { expiresAt: '2026-02-31T00:00:00Z' }, root)).status, 400)
  assert.equal((await app.request('PATCH', '/api/users/user', { expiresAt: '2026-01-01T24:00:00Z' }, root)).status, 400)
  assert.equal((await app.request('POST', '/api/users', { username: 'large', password: '中'.repeat(30000) }, root)).status, 413)
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, method: 'POST', path: '/api/users', headers: {
      Authorization: 'Bearer ' + root, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked'
    } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
    req.on('error', reject)
    req.write('{"padding":"')
    for (let index = 0; index < 20; index += 1) req.write('x'.repeat(4096))
    req.end('"}')
  })
  assert.equal(chunked, 413)
  assert.equal((await app.request('GET', '/api/health')).status, 200)
})

test('password changes, logout and deletion revoke sessions immediately', async t => {
  const app = await fixture(t)
  const root = await app.login()
  const user1 = await app.login('user', USER_PASSWORD)
  const user2 = await app.login('user', USER_PASSWORD)
  assert.notEqual(user1, user2)
  assert.equal((await app.request('POST', '/api/me/password', { currentPassword: 'wrong-password', password: 'changed-password-1' }, user1)).status, 400)
  const changed = await app.request('POST', '/api/me/password', { currentPassword: USER_PASSWORD, password: 'changed-password-1' }, user1)
  assert.equal(changed.status, 200)
  assert.equal(changed.body.reLoginRequired, true)
  for (const token of [user1, user2]) assert.equal((await app.request('GET', '/api/me', undefined, token)).status, 401)
  assert.equal((await app.request('POST', '/api/login', { username: 'user', password: USER_PASSWORD })).status, 401)
  const user3 = await app.login('user', 'changed-password-1')
  assert.equal((await app.request('PATCH', '/api/users/user/password', { password: 'changed-password-2' }, root)).status, 200)
  assert.equal((await app.request('GET', '/api/me', undefined, user3)).status, 401)
  const user4 = await app.login('user', 'changed-password-2')
  assert.equal((await app.request('POST', '/api/logout', {}, user4)).status, 200)
  assert.equal((await app.request('GET', '/api/me', undefined, user4)).status, 401)
  const user5 = await app.login('user', 'changed-password-2')
  assert.equal((await app.request('DELETE', '/api/users/user', undefined, root)).status, 200)
  assert.equal((await app.request('GET', '/api/me', undefined, user5)).status, 401)
  const root2 = await app.login()
  assert.equal((await app.request('PATCH', '/api/users/root/password', { password: 'changed-root-password' }, root)).status, 200)
  for (const token of [root, root2]) assert.equal((await app.request('GET', '/api/users', undefined, token)).status, 401)
  await app.login('root', 'changed-root-password')
})

test('disable, re-enable and expiry enforce access and persist safely', async t => {
  const app = await fixture(t)
  const root = await app.login()
  const token = await app.login('user', USER_PASSWORD)
  const disabled = await app.request('PATCH', '/api/users/user', { disabled: true }, root)
  assert.equal(disabled.status, 200)
  assert.equal(disabled.body.user.disabled, true)
  assert.equal((await app.request('GET', '/api/me', undefined, token)).status, 401)
  assert.equal((await app.request('POST', '/api/login', { username: 'user', password: USER_PASSWORD })).status, 403)
  assert.equal((await app.request('PATCH', '/api/users/user', { disabled: false, expiresAt: '2000-01-01T00:00:00Z' }, root)).status, 200)
  assert.equal((await app.request('POST', '/api/login', { username: 'user', password: USER_PASSWORD })).status, 403)
  const expiry = new Date(Date.now() + 1500).toISOString()
  assert.equal((await app.request('PATCH', '/api/users/user', { expiresAt: expiry }, root)).status, 200)
  const expiringToken = await app.login('user', USER_PASSWORD)
  const me = await app.request('GET', '/api/me', undefined, expiringToken)
  assert.equal(me.status, 200)
  assert.equal(me.body.user.expiresAt, expiry)
  await delay(1550)
  assert.equal((await app.request('GET', '/api/me', undefined, expiringToken)).status, 401)
  assert.equal((await app.request('GET', '/api/stats', undefined, root)).body.activeSessions, 1)
  assert.equal((await app.request('PATCH', '/api/users/user', { expiresAt: null }, root)).status, 200)
  await app.login('user', USER_PASSWORD)
  const userFile = fs.readFileSync(path.join(app.directory, 'data', 'users.json'), 'utf8')
  assert.ok(!userFile.includes(USER_PASSWORD))
  assert.ok(!userFile.includes(ROOT_PASSWORD))
  assert.equal(JSON.parse(userFile).find(user => user.username === 'user').expiresAt, null)
  assert.deepEqual(fs.readdirSync(path.join(app.directory, 'data')), ['users.json'])
})

test('restart keeps accounts and passwords but invalidates in-memory sessions', async t => {
  const app = await fixture(t)
  const root = await app.login()
  await app.request('PATCH', '/api/users/user/password', { password: 'persisted-password-1' }, root)
  const user = await app.login('user', 'persisted-password-1')
  await app.stop()
  // Bootstrap passwords are optional once the data file exists.
  const envFile = path.join(app.directory, '.env')
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replace(/^MISAKA_(?:ROOT|USER)_PASSWORD=.*\r?\n/gm, ''))
  await app.start()
  assert.equal((await app.request('GET', '/api/me', undefined, root)).status, 401)
  assert.equal((await app.request('GET', '/api/me', undefined, user)).status, 401)
  await app.login('user', 'persisted-password-1')
  await app.login()
})

test('untrusted X-Forwarded-For cannot bypass login rate limit', async t => {
  const app = await fixture(t)
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await app.request('POST', '/api/login', { username: 'missing', password: 'wrong-password' }, undefined,
      { 'X-Forwarded-For': '203.0.113.' + (index + 1) })).status, 401)
  }
  const limited = await app.request('POST', '/api/login', { username: 'root', password: ROOT_PASSWORD }, undefined, { 'X-Forwarded-For': '192.0.2.100' })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '600')
  assert.equal((await app.request('GET', '/api/health')).status, 200)
})

test('trusted reverse proxy walks forwarding chain from the rightmost untrusted address', async t => {
  const app = await fixture(t, { trustedProxies: '127.0.0.1' })
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await app.request('POST', '/api/login', { username: 'missing', password: 'wrong-password' }, undefined,
      { 'X-Forwarded-For': '203.0.113.' + (index + 1) + ', 192.0.2.50' })).status, 401)
  }
  assert.equal((await app.request('POST', '/api/login', { username: 'root', password: ROOT_PASSWORD }, undefined,
    { 'X-Forwarded-For': '203.0.113.99, 192.0.2.50' })).status, 429)
  assert.equal((await app.request('POST', '/api/login', { username: 'root', password: ROOT_PASSWORD }, undefined,
    { 'X-Forwarded-For': '192.0.2.51' })).status, 200)
})

test('only 10 recent sessions per account stay valid', async t => {
  const app = await fixture(t)
  const tokens = []
  for (let index = 0; index < 11; index += 1) tokens.push(await app.login())
  assert.equal((await app.request('GET', '/api/me', undefined, tokens[0])).status, 401)
  assert.equal((await app.request('GET', '/api/me', undefined, tokens[10])).status, 200)
  assert.equal((await app.request('GET', '/api/stats', undefined, tokens[10])).body.activeSessions, 10)
})

test('failed atomic save leaves in-memory accounts unchanged', async t => {
  const app = await fixture(t)
  const root = await app.login()
  const userFile = path.join(app.directory, 'data', 'users.json')
  const backup = path.join(app.directory, 'data', 'users.backup.json')
  fs.renameSync(userFile, backup)
  fs.mkdirSync(userFile)
  try {
    assert.equal((await app.request('POST', '/api/users', { username: 'rollback', password: 'test-new-password' }, root)).status, 500)
    const response = await app.request('GET', '/api/users', undefined, root)
    assert.equal(response.status, 200)
    assert.ok(!response.body.users.some(user => user.username === 'rollback'))
    assert.ok(!fs.readdirSync(path.join(app.directory, 'data')).some(name => name.endsWith('.tmp')))
  } finally {
    fs.rmdirSync(userFile)
    fs.renameSync(backup, userFile)
  }
  assert.equal((await app.request('POST', '/api/users', { username: 'afterrollback', password: 'test-new-password' }, root)).status, 201)
})

test('revoked administrator cannot finish an already pending user mutation', async t => {
  const app = await fixture(t)
  const root = await app.login()
  let pending
  const body = JSON.stringify({ username: 'pendinguser', password: 'test-new-password' })
  const completion = new Promise((resolve, reject) => {
    pending = http.request({ host: '127.0.0.1', port: app.port, method: 'POST', path: '/api/users', headers: {
      Authorization: 'Bearer ' + root, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
    } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
    pending.on('error', reject)
    pending.write(body.slice(0, 1))
  })
  await delay(50)
  assert.equal((await app.request('POST', '/api/logout', {}, root)).status, 200)
  pending.end(body.slice(1))
  assert.equal(await completion, 401)
  const replacement = await app.login()
  assert.ok(!(await app.request('GET', '/api/users', undefined, replacement)).body.users.some(user => user.username === 'pendinguser'))
})
