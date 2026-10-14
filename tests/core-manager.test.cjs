'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { CoreManager, controller } = require('../electron/core-manager.cjs')

const corePath = process.env.QALETX_TEST_CORE || path.join(__dirname, '..', 'core', process.platform === 'win32' ? 'sing-box.exe' : process.platform === 'darwin' ? `sing-box-${process.arch === 'arm64' ? 'arm64' : 'amd64'}` : 'sing-box')
const hasCore = fs.existsSync(corePath)
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function until(check, timeout = 7000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await pause(25)
  }
  assert.fail('Timed out waiting for local core state')
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function localNetwork({ rejectConnect = false, holdProbe = false } = {}) {
  const sockets = new Set()
  const state = { probes: 0, connects: 0, payloads: 0, connectTargets: [] }
  const gate = deferred()
  const track = (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    return socket
  }
  const target = http.createServer(async (request, response) => {
    if (request.url === '/probe') {
      state.probes++
      if (holdProbe) await gate.promise
      if (!response.destroyed) response.writeHead(204).end()
    } else {
      state.payloads++
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '65536' })
      response.end(Buffer.alloc(65536, 65))
    }
  })
  target.on('connection', track)
  const targetPort = await listen(target)
  const upstream = http.createServer((_request, response) => response.writeHead(405).end())
  upstream.on('connection', track)
  upstream.on('connect', (request, client, head) => {
    state.connects++
    state.connectTargets.push(request.url)
    // The fixture is incapable of connecting to a public host or another port.
    if (rejectConnect || request.url !== `127.0.0.1:${targetPort}`) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const socket = track(net.connect({ host: '127.0.0.1', port: targetPort }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) socket.write(head)
      client.pipe(socket)
      socket.pipe(client)
    }))
    socket.once('error', () => client.destroy())
    client.once('close', () => socket.destroy())
  })
  const upstreamPort = await listen(upstream)
  return {
    state, releaseProbe: gate.resolve,
    uri: `http://127.0.0.1:${upstreamPort}`,
    probeUrl: `http://127.0.0.1:${targetPort}/probe`,
    payloadUrl: `http://127.0.0.1:${targetPort}/payload`,
    close: async () => {
      gate.resolve()
      for (const socket of sockets) socket.destroy()
      await Promise.all([target, upstream].map((server) => new Promise((resolve) => server.close(resolve))))
    },
  }
}

function instance(extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qaletx-core-manager-'))
  const proxy = {
    enabled: false, enabledPorts: [], restoreCalls: 0, failRestore: false,
    async enable(port) { this.enabled = true; this.enabledPorts.push(port) },
    async restore() {
      this.restoreCalls++
      if (this.failRestore) throw new Error('injected restore failure')
      this.enabled = false
    },
  }
  const spawns = []
  const guardians = []
  const manager = new CoreManager({
    binary: corePath,
    directory,
    proxy,
    onSpawn: async (pid) => {
      spawns.push(pid)
      const guardian = { killed: false, kill() { this.killed = true } }
      guardians.push(guardian)
      return guardian
    },
    ...extra,
  })
  return {
    manager, proxy, spawns, guardians, directory,
    cleanup: async () => {
      proxy.failRestore = false
      await manager.disconnect()
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

function requestThrough(port, url) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: url, headers: { Host: new URL(url).host }, agent: false, timeout: 4000 }, (response) => {
      let size = 0
      response.on('data', (chunk) => { size += chunk.length })
      response.once('end', () => resolve({ status: response.statusCode, size }))
      response.once('error', reject)
    })
    request.once('timeout', () => request.destroy(new Error('local request timeout')))
    request.once('error', reject)
  })
}

test('a queued connect is cancelled before any child or proxy is started', async () => {
  const context = instance()
  try {
    const connecting = context.manager.connect({ uri: 'http://127.0.0.1:1' })
    const disconnecting = context.manager.disconnect()
    const result = await connecting
    assert.equal(result.ok, false)
    assert.match(result.message, /取消/)
    assert.equal((await disconnecting).ok, true)
    assert.deepEqual(context.spawns, [])
    assert.deepEqual(context.proxy.enabledPorts, [])
    assert.equal(context.manager.status().phase, 'idle')
  } finally { await context.cleanup() }
})

test('restoration failure blocks a new connection before validating or spawning', async () => {
  const context = instance()
  context.proxy.failRestore = true
  try {
    const result = await context.manager.connect({ uri: 'http://127.0.0.1:1' })
    assert.equal(result.ok, false)
    assert.match(result.message, /恢复失败/)
    assert.deepEqual(context.spawns, [])
    assert.deepEqual(context.proxy.enabledPorts, [])
    assert.equal(context.manager.status().systemProxy, true)
    assert.equal(context.manager.status().phase, 'error')
  } finally { await context.cleanup() }
})

test('missing core never enables the proxy', async () => {
  const context = instance({ binary: path.join(os.tmpdir(), 'qaletx-does-not-exist.exe') })
  try {
    const result = await context.manager.connect({ uri: 'http://127.0.0.1:1' })
    assert.equal(result.ok, false)
    assert.match(result.message, /缺少代理核心/)
    assert.deepEqual(context.proxy.enabledPorts, [])
    assert.deepEqual(fs.readdirSync(context.directory), [])
  } finally { await context.cleanup() }
})

test('invalid protocol fails cleanly before spawning and leaves no config', { skip: !hasCore }, async () => {
  const context = instance()
  try {
    const result = await context.manager.connect({ uri: 'unsupported://127.0.0.1:1' })
    assert.equal(result.ok, false)
    assert.match(result.message, /不支持的节点协议/)
    assert.deepEqual(context.spawns, [])
    assert.deepEqual(context.proxy.enabledPorts, [])
    assert.deepEqual(fs.readdirSync(context.directory), [])
  } finally { await context.cleanup() }
})

test('real core proves local upstream reachability before enabling proxy and reports real traffic', { skip: !hasCore }, async () => {
  const network = await localNetwork()
  const context = instance({ probeUrls: [network.probeUrl] })
  const states = []
  context.manager.on('status', (state) => states.push(state))
  const enable = context.proxy.enable.bind(context.proxy)
  context.proxy.enable = async (port) => {
    assert.ok(network.state.probes > 0, 'must reach the target before enabling proxy')
    await enable(port)
  }
  try {
    const result = await context.manager.connect({ uri: network.uri, id: 'local-fixture', name: 'Local fixture' })
    assert.equal(result.ok, true, `${result.message}; local fixture ${JSON.stringify(network.state)}`)
    assert.equal(context.manager.status().connected, true)
    assert.ok(context.manager.status().startedAt)
    assert.equal(context.proxy.enabled, true)
    assert.equal(context.spawns.length, 1)
    assert.deepEqual(fs.readdirSync(context.directory), [], 'config containing credentials must be removed after startup')
    const response = await requestThrough(context.proxy.enabledPorts[0], network.payloadUrl)
    assert.deepEqual(response, { status: 200, size: 65536 })
    await until(() => context.manager.status().down >= 65536)
    assert.ok(context.manager.status().up > 0)
    assert.equal(network.state.payloads, 1)
    assert.ok(states.some((state) => state.phase === 'connecting' && !state.connected))
    const child = context.manager.child
    assert.equal((await context.manager.disconnect()).ok, true)
    assert.equal(context.proxy.enabled, false)
    assert.equal(context.manager.status().connected, false)
    assert.equal(context.manager.timer, null)
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.ok(context.guardians[0].killed)
  } finally { await context.cleanup(); await network.close() }
})

test('real core rejects unreachable upstream without reporting connected or changing system proxy', { skip: !hasCore }, async () => {
  const network = await localNetwork({ rejectConnect: true })
  const context = instance({ probeUrls: [network.probeUrl] })
  const states = []
  context.manager.on('status', (state) => states.push(state))
  try {
    const result = await context.manager.connect({ uri: network.uri })
    assert.equal(result.ok, false)
    assert.match(result.message, /连通性检测失败/)
    assert.ok(network.state.connects > 0)
    assert.equal(network.state.probes, 0)
    assert.ok(!states.some((state) => state.connected))
    assert.deepEqual(context.proxy.enabledPorts, [])
    assert.equal(context.manager.child, null)
    assert.deepEqual(fs.readdirSync(context.directory), [])
  } finally { await context.cleanup(); await network.close() }
})

test('disconnect during an in-flight probe cancels connection without enabling proxy', { skip: !hasCore }, async () => {
  const network = await localNetwork({ holdProbe: true })
  const context = instance({ probeUrls: [network.probeUrl] })
  try {
    const connecting = context.manager.connect({ uri: network.uri })
    await until(() => network.state.probes === 1)
    const disconnecting = context.manager.disconnect()
    network.releaseProbe()
    const result = await connecting
    assert.equal(result.ok, false)
    assert.match(result.message, /取消/)
    assert.equal((await disconnecting).ok, true)
    assert.deepEqual(context.proxy.enabledPorts, [])
    assert.equal(context.manager.child, null)
    assert.equal(context.manager.status().phase, 'idle')
    assert.deepEqual(fs.readdirSync(context.directory), [])
  } finally { await context.cleanup(); await network.close() }
})

test('disconnect cancels both the active request and all older queued connects', { skip: !hasCore }, async () => {
  const network = await localNetwork({ holdProbe: true })
  const context = instance({ probeUrls: [network.probeUrl] })
  try {
    const first = context.manager.connect({ uri: network.uri, id: 'active' })
    await until(() => network.state.probes === 1)
    const queued = context.manager.connect({ uri: network.uri, id: 'queued' })
    const disconnecting = context.manager.disconnect()
    network.releaseProbe()
    assert.equal((await first).ok, false)
    assert.match((await queued).message, /取消/)
    assert.equal((await disconnecting).ok, true)
    assert.equal(context.spawns.length, 1)
    assert.deepEqual(context.proxy.enabledPorts, [])
    assert.equal(context.manager.status().phase, 'idle')
  } finally { await context.cleanup(); await network.close() }
})

test('consecutive connections and disconnections serialize, close prior children and permit reconnect', { skip: !hasCore }, async () => {
  const network = await localNetwork()
  const context = instance({ probeUrls: [network.probeUrl] })
  try {
    const first = context.manager.connect({ uri: network.uri, id: 'one' })
    const second = context.manager.connect({ uri: network.uri, id: 'two' })
    assert.equal((await first).ok, true)
    const firstChild = context.manager.child
    assert.equal((await second).ok, true)
    assert.equal(context.manager.status().nodeId, 'two')
    assert.ok(firstChild.exitCode !== null || firstChild.signalCode !== null)
    assert.equal(context.spawns.length, 2)
    assert.equal((await context.manager.disconnect()).ok, true)
    assert.equal((await context.manager.connect({ uri: network.uri, id: 'three' })).ok, true)
    assert.equal(context.manager.status().nodeId, 'three')
    assert.equal(context.spawns.length, 3)
    assert.equal(context.proxy.enabledPorts.length, 3)
  } finally { await context.cleanup(); await network.close() }
})

test('unexpected real core exit restores proxy and publishes an error', { skip: !hasCore }, async () => {
  const network = await localNetwork()
  const context = instance({ probeUrls: [network.probeUrl] })
  try {
    assert.equal((await context.manager.connect({ uri: network.uri })).ok, true)
    context.manager.child.kill()
    await until(() => context.manager.status().phase === 'error')
    assert.equal(context.proxy.enabled, false)
    assert.equal(context.manager.status().connected, false)
    assert.equal(context.manager.status().systemProxy, false)
    assert.match(context.manager.status().error, /意外退出/)
    assert.equal(context.manager.child, null)
    assert.equal(context.manager.timer, null)
  } finally { await context.cleanup(); await network.close() }
})

test('failed restore after connection retains guardian and blocks switching nodes', { skip: !hasCore }, async () => {
  const network = await localNetwork()
  const context = instance({ probeUrls: [network.probeUrl] })
  try {
    assert.equal((await context.manager.connect({ uri: network.uri })).ok, true)
    context.proxy.failRestore = true
    const result = await context.manager.connect({ uri: network.uri, id: 'must-not-start' })
    assert.equal(result.ok, false)
    assert.match(result.message, /恢复失败/)
    assert.equal(context.spawns.length, 1)
    assert.equal(context.proxy.enabledPorts.length, 1)
    assert.equal(context.guardians[0].killed, false)
    assert.equal(context.manager.child, null)
    assert.equal(context.manager.status().connected, false)
    assert.equal(context.manager.status().systemProxy, true)
  } finally { await context.cleanup(); await network.close() }
})

test('API authentication is enforced by the real core', { skip: !hasCore }, async () => {
  const network = await localNetwork()
  const context = instance({ probeUrls: [network.probeUrl] })
  try {
    assert.equal((await context.manager.connect({ uri: network.uri })).ok, true)
    await assert.rejects(controller(context.manager.api.port, 'wrong-secret', '/version'), /未成功/)
    const response = await controller(context.manager.api.port, context.manager.api.secret, '/version')
    assert.ok(response.version)
  } finally { await context.cleanup(); await network.close() }
})
