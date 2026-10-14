'use strict'

const { _electron: electron } = require('playwright-core')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const net = require('node:net'), crypto = require('node:crypto')
const http = require('node:http')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')
const { SystemProxy } = require('../electron/system-proxy.cjs')
const root = path.resolve(__dirname, '..')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const ROOT_PASSWORD = 'Smoke-root-only-2026!'
const USER_PASSWORD = 'Smoke-user-only-2026!'

async function freePort() {
  const listener = net.createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}
async function portOccupied(port) {
  const listener = net.createServer()
  return new Promise((resolve, reject) => {
    listener.once('error', error => error.code === 'EADDRINUSE' ? resolve(true) : reject(error))
    listener.listen({ host: '127.0.0.1', port, exclusive: true }, () => listener.close(() => resolve(false)))
  })
}
function removeTestDirectory(directory, prefix) {
  const resolved = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir()) + path.sep
  const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value
  assert.ok(comparable(resolved).startsWith(comparable(temporaryRoot)), 'Cleanup must remain under the system temporary directory')
  assert.ok(path.basename(resolved).startsWith(prefix), 'Cleanup must target this test fixture only')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
async function serverFixture(privateUri) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qaletx-server-smoke05-'))
  const port = await freePort(), apiUrl = `http://127.0.0.1:${port}`, environment = { ...process.env }
  for (const key of Object.keys(environment)) if (key.startsWith('MISAKA_')) delete environment[key]
  delete environment.ELECTRON_RUN_AS_NODE
  fs.copyFileSync(path.join(root, 'server.js'), path.join(directory, 'server.js'))
  fs.writeFileSync(path.join(directory, '.env'), [
    'MISAKA_HOST=127.0.0.1', `MISAKA_PORT=${port}`,
    `MISAKA_TOKEN_SECRET=${crypto.randomBytes(32).toString('hex')}`,
    `MISAKA_ROOT_PASSWORD=${ROOT_PASSWORD}`, `MISAKA_USER_PASSWORD=${USER_PASSWORD}`,
    'MISAKA_CORS_ORIGIN=null', `MISAKA_PRIVATE_NODE_URI=${JSON.stringify(privateUri)}`, '',
  ].join('\n'), { mode: 0o600 })
  const child = spawn(process.execPath, [path.join(directory, 'server.js')], { cwd: directory, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let started = false, failed = false
  // Never print backend logs or environment: the isolated database has a real private URI.
  child.stdout.on('data', chunk => { if (chunk.toString().includes('server listening')) started = true })
  child.stderr.on('data', () => {})
  child.once('error', () => { failed = true })
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) await new Promise(resolve => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; resolve() }, 3000)
      child.once('exit', () => { clearTimeout(timer); resolve() }); child.kill()
    })
    removeTestDirectory(directory, 'qaletx-server-smoke05-')
  }
  try {
    for (let attempt = 0; attempt < 200 && !started; attempt++) {
      assert.ok(!failed && child.exitCode === null, 'Isolated account server failed to start'); await pause(25)
    }
    assert.ok(started, 'Isolated account server startup timed out')
  } catch (error) { await close(); throw error }
  async function request(method, endpoint, body, token) {
    const response = await fetch(apiUrl + endpoint, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    })
    return { status: response.status, data: await response.json() }
  }
  return { apiUrl, request, close }
}

async function run() {
  const privateUri = require('../electron/private-node.cjs').misaka
  assert.ok(typeof privateUri === 'string' && privateUri.length > 0, 'A local ignored private-node fixture is required for the real latency check')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qaletx-electron05-'))
  const output = path.join(root, 'test-artifacts'); fs.mkdirSync(output, { recursive: true })
  const env = { ...process.env, QALETX_TEST_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE
  const proxy = new SystemProxy(path.join(profile, 'proxy-recovery.json'))
  // Read-only OS inspection: never call enable/restore or successfully connect.
  const before = await proxy.snapshot(), initialPortOccupied = await portOccupied(10808)
  let app, backend, report
  try {
    backend = await serverFixture(privateUri)
    const login = await backend.request('POST', '/api/login', { username: 'root', password: ROOT_PASSWORD })
    assert.equal(login.status, 200, 'Isolated root login failed'); assert.ok(login.data.token && login.data.user.isRoot)
    const remoteNodes = await backend.request('GET', '/api/nodes', undefined, login.data.token)
    assert.equal(remoteNodes.status, 200); assert.equal(remoteNodes.data.nodes.length, 1)
    assert.equal(remoteNodes.data.nodes[0].id, 'misaka')
    assert.equal(Object.hasOwn(remoteNodes.data.nodes[0], 'uri'), false, 'Private metadata must not export its URI')
    const packed = process.env.QALETX_PACKAGED_EXE
    app = await electron.launch({ executablePath: packed || require('electron'), args: packed ? [`--user-data-dir=${profile}`] : [root], env, timeout: 30000 })
    const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
    assert.equal(path.resolve(actualProfile), path.resolve(profile), 'Smoke checks must never write the real user profile')
    const page = await app.firstWindow(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: '登录并开始' }).waitFor()
    const info = await page.evaluate(() => window.misaka.getInfo())
    assert.equal(info.core, true); assert.equal(info.tray, true)
    assert.equal(info.port, 10808); assert.equal(info.privateNodeSource, 'server')
    const status = await page.evaluate(() => window.misaka.getStatus())
    assert.equal(status.phase, 'idle'); assert.equal(status.port, 10808)
    assert.equal((await page.evaluate(() => window.misaka.setProxyPort(70000))).ok, false)
    assert.equal((await page.evaluate(() => window.misaka.setProxyPort(12080))).ok, true)
    assert.equal((await page.evaluate(() => window.misaka.getStatus())).port, 12080)
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'preferences.json'),'utf8')).proxyPort,12080)
    assert.equal((await page.evaluate(() => window.misaka.setProxyPort(10808))).ok, true)
    const fields = await page.locator('input').count(); assert.equal(fields, 2)
    assert.equal((await page.locator('body').innerText()).includes(backend.apiUrl), false)
    await page.screenshot({ path: path.join(output, 'v05-login.png') })
    // Both renderer and Electron main use the real isolated API, not route mocks.
    await page.evaluate(account => localStorage.setItem('misakaAccount', JSON.stringify(account)), { ...login.data.user, token: login.data.token, apiUrl: backend.apiUrl })
    await page.reload(); await page.locator('.connect-button').waitFor()
    await page.locator('.nodes-preview .node-row').waitFor()
    assert.equal(await page.locator('.nodes-preview .node-row').count(), 1)
    const size = await page.evaluate(() => ({ viewport: innerHeight, document: document.documentElement.scrollHeight, button: document.querySelector('.connect-button').getBoundingClientRect().bottom }))
    assert.ok(size.button < size.viewport); assert.ok(size.document <= size.viewport + 1)
    await page.screenshot({ path: path.join(output, 'v05-dashboard.png') })
    await page.getByRole('button', { name: /我的线路/ }).click()
    const lines = page.getByRole('dialog', { name: '我的线路' }); await lines.waitFor()
    assert.equal(await lines.locator('.node-row').count(), 1)
    assert.equal(await lines.getByRole('button', { name: '复制链接' }).count(), 0)
    assert.equal(await lines.getByRole('button', { name: '分配用户' }).count(), 1)
    assert.equal(await page.evaluate(uri => document.documentElement.outerHTML.includes(uri), privateUri), false, 'Private credentials must not appear in the DOM')
    assert.equal(await page.evaluate(uri => Object.values(localStorage).some(value => value.includes(uri)), privateUri), false, 'Private credentials must not appear in renderer storage')
    const probe = await page.evaluate(() => window.misaka.testNode({ nodeId: 'misaka' }))
    assert.equal(probe.ok, true, probe.message)
    assert.ok(Number.isFinite(probe.latencyMs) && probe.latencyMs >= 0)
    assert.ok(Number.isFinite(Date.parse(probe.checkedAt)))
    assert.ok(JSON.stringify(await proxy.snapshot()) === JSON.stringify(before), 'Latency testing must leave system proxy settings unchanged')
    assert.equal((await page.evaluate(() => window.misaka.getStatus())).connected, false)
    const testButton = lines.getByRole('button', { name: /测试 .* 连通性/ })
    await testButton.click()
    await page.waitForFunction(() => Boolean(document.querySelector('[role="dialog"] .probe-button.reachable')), undefined, { timeout: 25000 })
    assert.match(await testButton.innerText(), /\d+\s*ms/)
    await page.screenshot({ path: path.join(output, 'v05-lines.png') })
    await lines.getByRole('button', { name: '关闭对话框' }).click()
    let occupiedPortRejected = false
    // Attempt a connection only while the user's existing 10808 service owns it.
    if (initialPortOccupied && await portOccupied(10808)) {
      const connection = await page.evaluate(() => window.misaka.connect({ nodeId: 'misaka', mode: 'global' }))
      assert.equal(connection.ok, false, 'An occupied port must not be taken over')
      assert.match(connection.message, /10808/); assert.match(connection.message, /被占用|无法使用/)
      assert.equal(await portOccupied(10808), true, 'The original service must still own 10808')
      assert.equal((await page.evaluate(() => window.misaka.getStatus())).connected, false)
      occupiedPortRejected = true
    }
    assert.ok(JSON.stringify(await proxy.snapshot()) === JSON.stringify(before), 'The test must not change the user system proxy')
    const validation = await page.evaluate(() => window.misaka.validateNodes('socks5://127.0.0.1:1080#Local\nsocks5://127.0.0.1:1080#Local\nbad://x'))
    assert.equal(validation.nodes.length, 1); assert.equal(validation.errors.length, 1)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
    assert.deepEqual(errors, [])
    // The tray's Exit action calls app.quit(). Verify that an in-flight
    // account request cannot keep that cleanup path open indefinitely.
    let pendingRequest = false
    const slowApi = http.createServer(() => { pendingRequest = true })
    await new Promise(resolve => slowApi.listen(0, '127.0.0.1', resolve))
    const slowUrl = `http://127.0.0.1:${slowApi.address().port}`
    try {
      const pending = page.evaluate(apiUrl => window.misaka.setSession({ apiUrl, token: 'isolated-quit-test' }), slowUrl).catch(() => {})
      for (let attempt = 0; attempt < 100 && !pendingRequest; attempt++) await pause(20)
      assert.equal(pendingRequest, true, 'Exit fixture did not begin account authorization')
      const mainPid = await app.evaluate(() => process.pid)
      const started = Date.now()
      await app.evaluate(({ app }) => app.quit()).catch(() => {})
      let exited = false
      for (let attempt = 0; attempt < 20; attempt++) {
        try { process.kill(mainPid, 0) }
        catch (error) { if (error.code === 'ESRCH') { exited = true; break } }
        await pause(100)
      }
      assert.ok(exited, 'Tray-equivalent Exit must finish while account authorization is pending')
      assert.ok(Date.now() - started < 3000, 'Exit must not wait for the account request timeout')
      await pending
      app = null
    } finally {
      slowApi.closeAllConnections()
      await new Promise(resolve => slowApi.close(resolve))
    }
    assert.ok(JSON.stringify(await proxy.snapshot()) === JSON.stringify(before), 'Exiting the test app must not change the original proxy')
    assert.equal(fs.existsSync(path.join(profile, 'proxy-recovery.json')), false)
    report = { electronSmoke: 'passed', version: info.version, packaged: Boolean(packed), tray: info.tray, loginInputs: fields, layout: size, backend: 'isolated real server', privateMetadataHidden: true, realLatencyMs: probe.latencyMs, occupiedPortRejected, systemProxy: 'unchanged' }
  } finally {
    if (app) await app.close().catch(() => {})
    if (backend) await backend.close()
    assert.ok(JSON.stringify(await proxy.snapshot()) === JSON.stringify(before), 'Smoke cleanup must leave original proxy settings unchanged')
    try { removeTestDirectory(profile, 'qaletx-electron05-') }
    catch { console.error('Isolated Electron test profile retained because browser files remain locked.') }
  }
  console.log(JSON.stringify(report))
}
run().catch(error => { console.error(JSON.stringify({ electronSmoke: 'failed', message: error.message })); process.exitCode = 1 })
