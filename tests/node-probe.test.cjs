'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { NodeProbe } = require('../electron/node-probe.cjs')
const { CoreManager, freePort } = require('../electron/core-manager.cjs')

const binary = process.env.QALETX_TEST_CORE || path.join(__dirname, '..', 'core', process.platform === 'win32' ? 'sing-box.exe' : process.platform === 'darwin' ? `sing-box-${process.arch === 'arm64' ? 'arm64' : 'amd64'}` : 'sing-box')
const hasCore = fs.existsSync(binary)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (check()) return
    await pause(20)
  }
  assert.fail('Timed out waiting for a local probe')
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function network({ reject = false, hold = false } = {}) {
  const sockets = new Set()
  const pending = []
  let requests = 0, connects = 0
  const track = (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    return socket
  }
  const target = http.createServer((_request, response) => {
    requests++
    if (hold) pending.push(response)
    else response.writeHead(204).end()
  })
  target.on('connection', track)
  const targetPort = await listen(target)
  const upstream = http.createServer((_request, response) => response.writeHead(405).end())
  upstream.on('connection', track)
  upstream.on('connect', (request, client, head) => {
    connects++
    // No test fixture is allowed to forward outside its own local target.
    if (reject || request.url !== `127.0.0.1:${targetPort}`) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const socket = track(net.connect({ host: '127.0.0.1', port: targetPort }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) socket.write(head)
      socket.pipe(client)
      client.pipe(socket)
    }))
    socket.once('error', () => client.destroy())
    client.once('close', () => socket.destroy())
  })
  const upstreamPort = await listen(upstream)
  return {
    uri: `http://fixture-user:fixture-password@127.0.0.1:${upstreamPort}`,
    url: `http://127.0.0.1:${targetPort}/probe`,
    get requests() { return requests },
    get connects() { return connects },
    release() { for (const response of pending.splice(0)) response.writeHead(204).end() },
    async close() {
      for (const socket of sockets) socket.destroy()
      await Promise.all([target, upstream].map((server) => new Promise((resolve) => server.close(resolve))))
    },
  }
}

function instance(extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qaletx-probe-test-'))
  const guardians = []
  const probe = new NodeProbe({ binary, directory, onSpawn: async (pid) => {
    assert.ok(Number.isInteger(pid) && pid > 0)
    const guardian = { killed: false, kill() { this.killed = true } }
    guardians.push(guardian)
    return guardian
  }, ...extra })
  return {
    probe, directory, guardians,
    async cleanup() {
      await probe.close()
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

test('probe validates its configuration and reports missing binaries without leaking link details', async () => {
  assert.throws(() => new NodeProbe({ binary, directory: os.tmpdir(), probeUrls: [] }), /测速地址无效/)
  assert.throws(() => new NodeProbe({ binary, directory: os.tmpdir(), probeUrls: ['file:///a'] }), /测速地址无效/)
  const context = instance({ binary: path.join(os.tmpdir(), 'missing-qaletx-core') })
  try {
    const response = await context.probe.test('http://hidden-password@private.example:99')
    assert.equal(response.ok, false)
    assert.equal(response.latencyMs, null)
    assert.match(response.message, /缺少代理核心/)
    assert.ok(Number.isFinite(Date.parse(response.checkedAt)))
    assert.doesNotMatch(JSON.stringify(response), /private\.example|hidden-password/)
    assert.deepEqual(fs.readdirSync(context.directory), [])
  } finally { await context.cleanup() }
})

test('real standalone probe measures a complete request through the selected local upstream', { skip: !hasCore }, async () => {
  const fixture = await network()
  const context = instance({ probeUrls: [fixture.url] })
  try {
    const response = await context.probe.test(fixture.uri)
    assert.equal(response.ok, true, response.message)
    assert.ok(Number.isInteger(response.latencyMs) && response.latencyMs >= 0)
    assert.ok(fixture.connects > 0)
    assert.equal(fixture.requests, 1)
    assert.equal(context.probe.jobs.size, 0)
    assert.equal(context.guardians.length, 1)
    assert.ok(context.guardians[0].killed)
    assert.deepEqual(fs.readdirSync(context.directory), [], 'credential files and per-probe directory must be removed')
    assert.doesNotMatch(JSON.stringify(response), /fixture-user|fixture-password|127\.0\.0\.1/)
  } finally { await context.cleanup(); await fixture.close() }
})

test('real standalone probe reports an unreachable selected upstream and cleans up', { skip: !hasCore }, async () => {
  const fixture = await network({ reject: true })
  const context = instance({ probeUrls: [fixture.url] })
  try {
    const response = await context.probe.test(fixture.uri)
    assert.equal(response.ok, false)
    assert.equal(response.latencyMs, null)
    assert.match(response.message, /无法连通/)
    assert.ok(fixture.connects > 0)
    assert.equal(fixture.requests, 0)
    assert.deepEqual(fs.readdirSync(context.directory), [])
  } finally { await context.cleanup(); await fixture.close() }
})

test('invalid private link details never appear in the response and never remain on disk', { skip: !hasCore }, async () => {
  const context = instance()
  try {
    const response = await context.probe.test('madeup://fixture-password@hidden.example:1234')
    assert.equal(response.ok, false)
    assert.match(response.message, /配置无效/)
    assert.doesNotMatch(JSON.stringify(response), /fixture-password|hidden\.example/)
    assert.equal(context.probe.jobs.size, 0)
    assert.deepEqual(fs.readdirSync(context.directory), [])
  } finally { await context.cleanup() }
})

test('at most two probes run concurrently; close aborts both and waits for owned children to exit', { skip: !hasCore }, async () => {
  const fixture = await network({ hold: true })
  const context = instance({ probeUrls: [fixture.url] })
  try {
    const first = context.probe.test(fixture.uri)
    const second = context.probe.test(fixture.uri)
    const third = await context.probe.test(fixture.uri)
    assert.equal(third.ok, false)
    assert.match(third.message, /其他线路/)
    await until(() => fixture.requests === 2)
    const children = [...context.probe.jobs].map((job) => job.child)
    assert.equal(children.length, 2)
    for (const directory of fs.readdirSync(context.directory)) {
      assert.deepEqual(fs.readdirSync(path.join(context.directory, directory)), [], 'credentials removed as soon as core is ready')
    }
    const start = Date.now()
    await context.probe.close()
    assert.ok(Date.now() - start < 2500, 'cancellation must not wait for the network timeout')
    for (const response of await Promise.all([first, second])) {
      assert.equal(response.ok, false)
      assert.match(response.message, /取消/)
    }
    for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.equal(context.guardians.length, 2)
    assert.ok(context.guardians.every((guardian) => guardian.killed))
    assert.equal(context.probe.jobs.size, 0)
    assert.deepEqual(fs.readdirSync(context.directory), [])
    assert.match((await context.probe.test(fixture.uri)).message, /取消/)
  } finally { await context.cleanup(); await fixture.close() }
})

test('close during startup prevents success and removes any partially written configuration', { skip: !hasCore }, async () => {
  const context = instance()
  try {
    const response = context.probe.test('http://fixture:secret@127.0.0.1:1')
    await context.probe.close()
    assert.match((await response).message, /取消/)
    assert.equal(context.probe.jobs.size, 0)
    assert.deepEqual(fs.readdirSync(context.directory), [])
  } finally { await context.cleanup() }
})

test('guardian creation failure stops the already spawned probe and removes credentials', { skip: !hasCore }, async () => {
  let child
  const context = instance({ onSpawn: async () => {
    child = [...context.probe.jobs][0].child
    throw new Error('guardian failed with sensitive internal details')
  } })
  try {
    const response = await context.probe.test('http://fixture-user:fixture-password@127.0.0.1:1')
    assert.equal(response.ok, false)
    assert.doesNotMatch(response.message, /sensitive|fixture-password/)
    assert.ok(child)
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.equal(context.probe.jobs.size, 0)
    assert.deepEqual(fs.readdirSync(context.directory), [])
  } finally { await context.cleanup() }
})

test('a late guardian returned after cancellation is stopped without delaying probe cleanup', { skip: !hasCore }, async () => {
  let release, entered = false
  const guardian = { killed: false, kill() { this.killed = true } }
  const context = instance({ onSpawn: () => {
    entered = true
    return new Promise((resolve) => { release = () => resolve(guardian) })
  } })
  try {
    const pending = context.probe.test('http://fixture:secret@127.0.0.1:1')
    await until(() => entered)
    await context.probe.close()
    assert.match((await pending).message, /取消/)
    assert.deepEqual(fs.readdirSync(context.directory), [])
    release()
    await until(() => guardian.killed)
  } finally { if (release) release(); await context.cleanup() }
})

test('an upstream that accepts connections but never answers has a bounded timeout and leaves no process or config', { skip: !hasCore }, async () => {
  const fixture = await network({ hold: true })
  const context = instance({ probeUrls: [fixture.url] })
  try {
    const start = Date.now()
    const responsePromise = context.probe.test(fixture.uri)
    await until(() => fixture.requests === 1)
    const child = [...context.probe.jobs][0].child
    const response = await responsePromise
    assert.equal(response.ok, false)
    assert.equal(response.latencyMs, null)
    assert.ok(Date.now() - start < 20000, 'a stalled node must never hold the probe indefinitely')
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.equal(context.probe.jobs.size, 0)
    assert.deepEqual(fs.readdirSync(context.directory), [])
  } finally { await context.cleanup(); await fixture.close() }
})

test('standalone node testing leaves an existing connected core and system proxy untouched', { skip: !hasCore }, async () => {
  const fixture = await network()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qaletx-probe-active-'))
  const context = instance({ probeUrls: [fixture.url] })
  const proxy = { enableCalls: [], restores: 0, async enable(port) { this.enableCalls.push(port) }, async restore() { this.restores++ } }
  const manager = new CoreManager({ binary, directory, proxy, proxyPort: await freePort(), probeUrls: [fixture.url] })
  try {
    assert.equal((await manager.connect({ uri: fixture.uri, id: 'already-connected' })).ok, true)
    const child = manager.child
    const before = { pid: child.pid, port: manager.status().port, restores: proxy.restores, enabled: [...proxy.enableCalls] }
    assert.equal((await context.probe.test(fixture.uri)).ok, true)
    assert.equal(manager.child, child)
    assert.equal(child.pid, before.pid)
    assert.equal(child.exitCode, null)
    assert.equal(manager.status().connected, true)
    assert.equal(manager.status().nodeId, 'already-connected')
    assert.equal(manager.status().port, before.port)
    assert.equal(proxy.restores, before.restores)
    assert.deepEqual(proxy.enableCalls, before.enabled)
    assert.equal(fixture.requests, 2)
  } finally {
    await manager.disconnect()
    await context.cleanup()
    await fixture.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
