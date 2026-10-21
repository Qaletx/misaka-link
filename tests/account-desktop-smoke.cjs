'use strict'
// Isolated account fixture. Never uses a real account or changes the OS proxy.
const { _electron } = require('playwright-core')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http')
const root = path.resolve(__dirname, '..')

async function run() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qaletx-account-desktop-'))
  const account = { username: 'fixture', role: 'user', permissions: { syncNodes: true, changePassword: true } }
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end() }
    if (req.url === '/api/pending') return
    let data = { ok: true }
    if (req.url === '/api/login') data = { token: 'isolated-fixture-token', user: account }
    if (req.url === '/api/me') data = { user: account }
    if (req.url === '/api/me/usage') data = { usage: { quotaBytes: null, usedBytes: 0, metered: false } }
    if (req.url === '/api/nodes') data = { nodes: [
      { id: 'private-fixture', name: '私有测试线路', protocol: 'hysteria2', private: true },
      { id: 'public-fixture', name: '普通测试线路', protocol: 'socks5', uri: 'socks5://fixture:secret@192.0.2.20:1080', private: false },
    ] }
    res.writeHead(200, headers); res.end(JSON.stringify(data))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${server.address().port}`
  const env = { ...process.env, QALETX_TEST_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE
  const packed = process.env.QALETX_PACKAGED_EXE
  let app
  try {
    app = await _electron.launch({ executablePath: packed || require('electron'), args: packed ? [`--user-data-dir=${profile}`] : [root], env, timeout: 30000 })
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile))
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.getByRole('button', { name: '登录并开始' }).waitFor()
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    // Only this throwaway Chromium session uses a dead proxy. No operating
    // system setting is changed, and the existing user app is untouched.
    const browserProxy = await app.evaluate(async ({ session }, apiUrl) => {
      await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:1', proxyBypassRules: '<-loopback>' })
      return session.defaultSession.resolveProxy(apiUrl)
    }, apiUrl)
    assert.match(browserProxy, /127\.0\.0\.1:1/)
    const browserFailed = await page.evaluate(async apiUrl => { try { await fetch(apiUrl + '/api/health'); return false } catch { return true } }, apiUrl)
    assert.equal(browserFailed, true)
    const response = await page.evaluate(baseUrl => window.misaka.accountRequest({ baseUrl, path: '/api/login', method: 'POST', body: { username: 'fixture', password: 'fixture-only-password' } }), apiUrl)
    assert.equal(response.status, 200)
    const blocked = await page.evaluate(baseUrl => window.misaka.accountRequest({ baseUrl, path: '/api/nodes/private-fixture/config' }), apiUrl)
    assert.equal(blocked.code, 'CONFIG'); assert.ok(!requests.includes('/api/nodes/private-fixture/config'))
    await page.evaluate(({apiUrl,response})=>localStorage.setItem('misakaAccount',JSON.stringify({...response.data.user,apiUrl,token:response.data.token})),{apiUrl,response})
    await page.reload()
    await page.locator('.connect-button').waitFor()
    await page.getByRole('button', { name: /我的线路/ }).click()
    const dialog = page.getByRole('dialog', { name: '我的线路' })
    await dialog.locator('.node-card').filter({ hasText: '普通测试线路' }).locator('.node-address').getByText('192.0.2.20:1080', { exact: true }).waitFor()
    assert.equal(await dialog.locator('.node-card').filter({ hasText: '私有测试线路' }).locator('.node-address').count(), 0)
    assert.ok(!(await page.locator('body').innerText()).includes('secret'))
    const info = await page.evaluate(() => window.misaka.getInfo())
    const report = { version: info.version, platform: process.platform, packaged: Boolean(packed), browserWithDeadProxyFailed: browserFailed, nativeLogin: 'passed', nativeDashboard: 'passed', personalAddress: 'passed', privateAddressHidden: true, privateConfigBridgeBlocked: true }
    const output = path.join(root, 'test-artifacts'); fs.mkdirSync(output, { recursive: true })
    await page.screenshot({ path: path.join(output, 'v062-native-addresses.png') })
    assert.deepEqual(errors, [])
    const pending = page.evaluate(baseUrl => window.misaka.accountRequest({ baseUrl, path: '/api/pending' }), apiUrl).catch(() => {})
    for (let n = 0; n < 100 && !requests.includes('/api/pending'); n++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(requests.includes('/api/pending'))
    const started = Date.now()
    await app.close(); app = null; await pending
    assert.ok(Date.now() - started < 5000, 'Exit must cancel pending account calls')
    report.exitCancelsAccountCalls = true
    fs.writeFileSync(path.join(output, `v062-native-${process.platform}.json`), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally {
    if (app) await app.close().catch(() => {})
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    const resolved = path.resolve(profile)
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('qaletx-account-desktop-'))
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
