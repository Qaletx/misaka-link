'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { AccountTransport, rendererAccountRequest } = require('../electron/account-transport.cjs')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture(t, handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }

test('native account calls bypass browser CORS/preflight and proxy environment, preserving the login body', async t => {
  const previous = process.env.HTTP_PROXY
  process.env.HTTP_PROXY = 'http://127.0.0.1:1'
  t.after(() => { if (previous === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previous })
  const requests = []
  const { baseUrl } = await fixture(t, (req, res) => {
    requests.push({ method: req.method, origin: req.headers.origin, auth: req.headers.authorization })
    let body = ''; req.on('data', data => { body += data }); req.on('end', () => json(res, { received: JSON.parse(body) }))
  })
  const client = new AccountTransport()
  const body = { username: 'fixture-user', password: 'fixture-only-password' }
  const response = await rendererAccountRequest(client, { baseUrl, path: '/api/login', method: 'POST', body })
  assert.deepEqual(response.data.received, body)
  assert.deepEqual(requests, [{ method: 'POST', origin: undefined, auth: undefined }])
})

test('GET temporarily failing with 503 retries once and recovers', async t => {
  let requests = 0
  const { baseUrl } = await fixture(t, (req, res) => json(res, { ok: true }, ++requests === 1 ? 503 : 200))
  const client = new AccountTransport({ retryDelay: 1 })
  assert.equal((await client.request({ baseUrl, path: '/api/me', token: 'fixture' })).ok, true)
  assert.equal(requests, 2)
})

test('invalid password and a sent login with a lost response are never automatically replayed', async t => {
  let requests = 0, drop = false
  const { baseUrl } = await fixture(t, (req, res) => { requests++; if (drop) req.socket.destroy(); else json(res, { error: '账号或密码错误' }, 401) })
  const client = new AccountTransport({ retryDelay: 1 })
  const input = { baseUrl, path: '/api/login', method: 'POST', body: { username: 'fixture', password: 'fixture' } }
  assert.equal((await client.request(input)).status, 401); assert.equal(requests, 1)
  drop = true
  await assert.rejects(client.request(input), error => error.code === 'NETWORK')
  assert.equal(requests, 2)
})

test('a temporary DNS failure is retried once', async t => {
  const { baseUrl } = await fixture(t, (req, res) => json(res, { ok: true }))
  const port = new URL(baseUrl).port
  let lookups = 0
  const client = new AccountTransport({ retryDelay: 1 })
  // A DNS failure may also disappear on the next attempt.
  client.lookup = (_host, _options, callback) => {
    if (++lookups === 1) callback(Object.assign(new Error('temporary DNS'), { code: 'EAI_AGAIN' }))
    else callback(null, [{ address: '127.0.0.1', family: 4 }])
  }
  assert.equal((await client.request({ baseUrl: `http://account.fixture:${port}`, path: '/api/health' })).ok, true)
  assert.equal(lookups, 2)
})

test('an unreachable IPv6 answer still reaches an IPv4-only account server', async t => {
  const { baseUrl } = await fixture(t, (req, res) => json(res, { ok: true }))
  const client = new AccountTransport({ retryDelay: 1, lookup: (_host, _options, callback) => callback(null, [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]) })
  const response = await client.request({ baseUrl: `http://dual-stack.fixture:${new URL(baseUrl).port}`, path: '/api/health' })
  assert.equal(response.ok, true)
})

test('an absolute deadline includes DNS, slow headers and a trickled response body', async t => {
  const dnsClient = new AccountTransport({ timeout: 30, totalTimeout: 70, retryDelay: 1, lookup: () => {} })
  const started = Date.now()
  await assert.rejects(dnsClient.request({ baseUrl: 'http://no-dns.fixture', path: '/api/me' }), error => error.code === 'TIMEOUT')
  assert.ok(Date.now() - started < 500)
  const intervals = []
  t.after(() => intervals.forEach(clearInterval))
  const { baseUrl } = await fixture(t, (req, res) => { res.writeHead(200); res.write('{'); intervals.push(setInterval(() => res.write(' '), 5)) })
  const client = new AccountTransport({ timeout: 30, totalTimeout: 70, retryDelay: 1 })
  await assert.rejects(client.request({ baseUrl, path: '/api/me' }), error => error.code === 'TIMEOUT')
  assert.equal(client.operations.size, 0)
})

test('close cancels a hung native request and its retry without keeping application exit pending', async t => {
  let requests = 0
  const { baseUrl } = await fixture(t, () => { requests++ })
  const client = new AccountTransport({ timeout: 10000 })
  const pending = assert.rejects(client.request({ baseUrl, path: '/api/me' }), error => error.code === 'CANCELLED')
  while (!requests) await pause(2)
  client.close(); await pending
  assert.equal(client.operations.size, 0); assert.equal(requests, 1)
  await assert.rejects(client.request({ baseUrl, path: '/api/me' }), error => error.code === 'CANCELLED')
})

test('HTML proxy errors, HTTP rejection and redirects have distinct outcomes and never forward credentials', async t => {
  let received = 0
  const { baseUrl } = await fixture(t, (req, res) => {
    received++
    if (req.url === '/api/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>wrong upstream</h1>') }
    else if (req.url === '/api/redirect') { res.writeHead(302, { Location: 'http://example.invalid/leak' }); res.end('redirect') }
    else json(res, { error: 'not allowed', code: 'ACCESS_DENIED' }, 403)
  })
  const client = new AccountTransport({ retryDelay: 1 })
  assert.equal((await rendererAccountRequest(client, { baseUrl, path: '/api/html' })).code, 'RESPONSE')
  const redirected = await client.request({ baseUrl, path: '/api/redirect', token: 'fixture' })
  assert.equal(redirected.status, 302); assert.match(redirected.data.error, /重定向/)
  assert.equal((await client.request({ baseUrl, path: '/api/me' })).status, 403)
  assert.equal(received, 3)
})

test('renderer bridge rejects private configs, origin escape and oversized credentials before sending', async () => {
  let sent = 0
  const transport = { request: async () => { sent++; return { ok: true } } }
  assert.equal((await rendererAccountRequest(transport, { baseUrl: 'http://fixture', path: '/api/nodes/private/config' })).code, 'CONFIG')
  assert.equal(sent, 0)
  const client = new AccountTransport()
  for (const path of ['//other/api/me', '/api/../api/me', '/api/nodes/x%2fconfig']) await assert.rejects(client.request({ baseUrl: 'http://fixture', path }), error => error.code === 'CONFIG')
  await assert.rejects(client.request({ baseUrl: 'http://user:secret@fixture', path: '/api/me' }), error => error.code === 'CONFIG')
  await assert.rejects(client.request({ baseUrl: 'http://fixture', path: '/api/me', token: 'x\r\nHeader: y' }), error => error.code === 'CONFIG')
})
