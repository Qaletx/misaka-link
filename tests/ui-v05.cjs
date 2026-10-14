// Isolated renderer checks: fake account API and IPC, no live credentials or proxy changes.
const { chromium } = require('playwright-core')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const root = path.join(__dirname, '..')
const output = path.join(root, 'test-artifacts')
const privateNode = { id: 'private-one', name: '专属主线路', note: '工作日首选', private: true, protocol: 'Hysteria2', revision: 1 }
const personalNode = { id: 'personal-one', name: '我的备用线路', note: '', private: false, protocol: 'SOCKS5', revision: 1, uri: 'socks5://127.0.0.1:19999#Personal' }
function user(username, role, isRoot = false) {
  return { username, role, isRoot, disabled: false, expiresAt: null, privateNodeAccess: true, privateNodeIds: ['private-one'], permissions: { manageUsers: role === 'admin', managePrivateNodes: isRoot, changePassword: role !== 'shared', syncNodes: role !== 'shared' } }
}

async function run() {
  fs.mkdirSync(output, { recursive: true })
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    const file = path.resolve(root, 'dist', pathname === '/' ? 'index.html' : `.${pathname}`)
    if (!file.startsWith(path.resolve(root, 'dist') + path.sep)) { res.writeHead(403); return res.end() }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); return res.end() }
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream')
      res.end(data)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const errors = []
  async function fixture(account) {
    const context = await browser.newContext({ viewport: { width: 1020, height: 700 } })
    const db = { nodes: [{ ...privateNode }, ...(account.role === 'shared' ? [] : [{ ...personalNode }])], users: [user('root', 'admin', true), user('customer', 'user'), user('shared-team', 'shared')], requests: [], conflict: false, failImport: false, failList: false }
    await context.addInitScript(({ account }) => {
      window.__ipc = []
      if (!localStorage.getItem('misakaAccount')) localStorage.setItem('misakaAccount', JSON.stringify({ ...account, token: `fixture-${account.username}`, apiUrl: 'http://fixture.invalid' }))
      window.misaka = {
        setSession: async value => { window.__ipc.push({ op: 'setSession', value }); return { ok: true, user: account } },
        clearSession: async () => { window.__ipc.push({ op: 'clearSession' }); return { ok: true } },
        getInfo: async () => ({ version: '0.5.0', core: true, coreName: 'sing-box', platform: 'win32' }),
        getStatus: async () => ({ phase: 'idle', connected: false, port: 10808 }),
        onStatus: () => () => {}, getLogs: async () => [],
        connect: async value => { window.__ipc.push({ op: 'connect', value }); if (window.__holdConnect) await new Promise(resolve => { window.__releaseConnect = resolve }); return { ok: true } },
        disconnect: async () => { window.__ipc.push({ op: 'disconnect' }); window.__holdConnect = false; window.__releaseConnect?.(); return { ok: true } },
        testNode: async value => { window.__ipc.push({ op: 'testNode', value }); await new Promise(resolve => setTimeout(resolve, 20)); return { ok: true, latencyMs: 42, checkedAt: Date.now() } },
        validateNodes: async value => ({ nodes: value.split('\n').filter(line => /^socks5:\/\//.test(line)).map(uri => ({ uri, name: decodeURIComponent(uri.split('#')[1] || 'Imported'), protocol: 'SOCKS5' })), errors: [] })
      }
    }, { account })
    await context.route('**/api/**', async route => {
      const req = route.request(), endpoint = new URL(req.url()).pathname, method = req.method()
      const body = req.postDataJSON()
      db.requests.push({ endpoint, method, body })
      let status = 200, data = { ok: true }
      if (endpoint === '/api/me') data = { user: account }
      else if (endpoint === '/api/nodes' && method === 'GET') { status = db.failList ? 503 : 200; data = db.failList ? { error: 'fixture unavailable' } : { nodes: db.nodes } }
      else if (endpoint === '/api/nodes' && method === 'POST') {
        if (db.failImport) { status = 503; data = { error: 'fixture save failure' } }
        else { const node = { ...body, id: `personal-${db.nodes.length}`, protocol: 'SOCKS5', private: false, revision: 1 }; db.nodes.push(node); data = { node } }
      } else if (endpoint === '/api/private-nodes' && method === 'POST') {
        const node = { ...db.nodes.find(value => value.id === body.sourceNodeId), ...body, id: body.sourceNodeId || `private-${db.nodes.length}`, private: true, protocol: 'SOCKS5', revision: 2 }
        delete node.uri
        db.nodes = [...db.nodes.filter(value => value.id !== node.id), node]; data = { node }
      } else if (/^\/api\/(nodes|private-nodes|node-annotations)\/[^/]+$/.test(endpoint) && method === 'PATCH') {
        if (db.conflict) { status = 409; data = { error: 'revision conflict' } }
        else { const node = db.nodes.find(value => value.id === endpoint.split('/').pop()); Object.assign(node, body, { revision: node.revision + 1 }); data = { node } }
      } else if (endpoint === '/api/users' && method === 'GET') data = { users: account.isRoot ? db.users : db.users.filter(value => value.role !== 'admin') }
      else if (endpoint === '/api/users' && method === 'POST') { const created = user(body.username, body.role); db.users.push(created); data = { user: created } }
      else if (/^\/api\/users\/[^/]+$/.test(endpoint) && method === 'PATCH') { const target = db.users.find(value => value.username === endpoint.split('/').pop()); Object.assign(target, body); data = { user: target } }
      else if (endpoint === '/api/stats') data = { userCount: db.users.length, activeSessions: 1 }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'Access-Control-Allow-Origin': '*' } })
    })
    const page = await context.newPage(); page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(address)
    await page.getByRole('button', { name: '一键连接', exact: true }).waitFor()
    await page.getByText('专属主线路', { exact: true }).waitFor()
    return { page, context, db }
  }
  try {
    const admin = await fixture(user('root', 'admin', true))
    const { page, db } = admin
    db.users.find(value => value.username === 'customer').privateNodeIds.push('obsolete-private-id')
    assert.equal((await page.locator('body').innerText()).includes('147.189.'), false)
    const layout = await page.evaluate(() => ({ viewport: innerHeight, height: document.documentElement.scrollHeight, connectBottom: document.querySelector('.connect-button').getBoundingClientRect().bottom }))
    assert.ok(layout.connectBottom < layout.viewport)
    assert.ok(layout.height <= layout.viewport + 1)
    assert.equal((await page.evaluate(() => window.__ipc))[0].op, 'setSession')
    await page.screenshot({ path: path.join(output, 'v05-dashboard.png') })
    await page.evaluate(() => { window.__holdConnect = true })
    await page.getByRole('button', { name: '一键连接', exact: true }).click()
    const cancel = page.getByRole('button', { name: '取消连接', exact: true })
    await cancel.waitFor(); assert.equal(await cancel.isEnabled(), true)
    await cancel.click()
    await page.getByRole('button', { name: '一键连接', exact: true }).waitFor()
    assert.ok((await page.evaluate(() => window.__ipc)).some(item => item.op === 'disconnect'))
    assert.equal(await page.getByText('连接已建立', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '我的线路', exact: false }).click()
    const dialog = page.getByRole('dialog')
    const privateRow = dialog.locator('.node-card').filter({ hasText: '专属主线路' })
    assert.equal(await privateRow.getByRole('button', { name: '复制链接', exact: true }).count(), 0)
    await privateRow.getByRole('button', { name: '测试 专属主线路 连通性' }).click()
    await privateRow.getByText('42 ms', { exact: true }).waitFor()
    const testCall = (await page.evaluate(() => window.__ipc)).find(item => item.op === 'testNode')
    assert.equal(testCall.value.nodeId, 'private-one'); assert.equal('uri' in testCall.value, false)
    await page.screenshot({ path: path.join(output, 'v05-nodes.png') })
    await dialog.getByRole('button', { name: '新增私有', exact: true }).click()
    await page.getByLabel('线路分享链接').fill('socks5://127.0.0.1:16663#One\nsocks5://127.0.0.1:16664#Two')
    await page.getByLabel('默认名称').fill('Only one allowed')
    await page.getByRole('button', { name: '创建私有线路', exact: true }).click()
    await page.getByText(/每次只能添加一条私有线路/).waitFor()
    assert.equal(db.requests.filter(item => item.endpoint === '/api/private-nodes').length, 0)
    await page.getByLabel('线路分享链接').fill('unsupported://invalid')
    await page.getByRole('button', { name: '创建私有线路', exact: true }).click()
    await page.getByText(/线路分享链接无效/).waitFor()
    assert.equal(db.requests.filter(item => item.endpoint === '/api/private-nodes').length, 0)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.locator('.node-card').filter({ hasText: '我的备用线路' }).getByRole('button', { name: '名称与备注' }).click()
    await page.getByLabel('线路名称', { exact: true }).fill('工作备用线路')
    await page.getByLabel('备注', { exact: true }).fill('晚间优先')
    await page.getByRole('button', { name: '保存名称与备注' }).click()
    await dialog.getByText('工作备用线路', { exact: true }).waitFor()
    assert.equal(db.requests.find(item => item.method === 'PATCH' && item.endpoint === '/api/nodes/personal-one').body.revision, 1)
    db.conflict = true
    await dialog.locator('.node-card').filter({ hasText: '工作备用线路' }).getByRole('button', { name: '名称与备注' }).click()
    await page.getByLabel('线路名称', { exact: true }).fill('保留未保存的名称')
    await page.getByRole('button', { name: '保存名称与备注' }).click()
    await page.getByText(/这条线路已在其他设备修改/).waitFor()
    assert.equal(await page.getByLabel('线路名称', { exact: true }).inputValue(), '保留未保存的名称')
    await page.getByRole('button', { name: '返回线路', exact: true }).click(); db.conflict = false
    await dialog.locator('.node-card').filter({ hasText: '工作备用线路' }).getByRole('button', { name: '设为私有' }).click()
    await page.getByRole('button', { name: '创建私有线路', exact: true }).click()
    await dialog.getByText('工作备用线路', { exact: true }).waitFor()
    assert.equal(db.requests.find(item => item.endpoint === '/api/private-nodes').body.sourceNodeId, 'personal-one')
    await dialog.locator('.node-card').filter({ hasText: '工作备用线路' }).getByRole('button', { name: '分配用户', exact: true }).click()
    await dialog.locator('.assignment-row').filter({ hasText: 'customer' }).getByRole('checkbox').check()
    await page.getByRole('button', { name: '保存使用权限' }).click()
    await dialog.getByRole('heading', { name: '我的线路' }).waitFor()
    assert.ok(db.users.find(item => item.username === 'customer').privateNodeIds.includes('personal-one'))
    assert.equal(db.users.find(item => item.username === 'customer').privateNodeIds.includes('obsolete-private-id'), false)
    await page.getByRole('button', { name: '关闭对话框' }).click()
    await page.getByRole('button', { name: /用户管理/ }).click()
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await page.getByLabel('账号名称').fill('new-shared'); await page.getByLabel('账号类型').selectOption('shared'); await page.getByLabel('初始密码').fill('fixture-password')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await dialog.locator('.user-row').filter({ hasText: 'new-shared' }).waitFor()
    assert.equal(db.users.find(item => item.username === 'new-shared').role, 'shared')
    await dialog.locator('.user-row').filter({ hasText: 'customer' }).getByRole('button', { name: '编辑' }).click()
    await page.getByRole('switch').uncheck()
    await page.getByRole('button', { name: '保存更改' }).click()
    await dialog.getByRole('heading', { name: '管理你的用户' }).waitFor()
    assert.equal(db.users.find(item => item.username === 'customer').privateNodeAccess, false)
    await admin.context.close()

    const common = await fixture(user('shared-one', 'shared'))
    await common.page.locator('.sidebar-account').click()
    assert.equal(await common.page.getByRole('button', { name: '修改密码', exact: true }).count(), 0)
    await common.page.getByText('这是一个共用账号', { exact: true }).waitFor()
    await common.page.getByRole('button', { name: '知道了' }).click()
    await common.page.getByRole('button', { name: /我的线路/ }).click()
    await common.page.getByRole('button', { name: '导入线路', exact: true }).click()
    await common.page.getByLabel('分享链接').fill('socks5://127.0.0.1:16661#LocalOnly')
    await common.page.getByRole('button', { name: '验证并导入' }).click()
    await common.page.getByRole('dialog').getByText('LocalOnly', { exact: true }).waitFor()
    assert.equal(common.db.requests.filter(item => item.endpoint === '/api/nodes' && item.method === 'POST').length, 0)
    const keys = await common.page.evaluate(() => Object.keys(localStorage))
    assert.ok(keys.some(key => key.includes('shared-one') && key.endsWith(':nodes')))
    await common.page.reload(); await common.page.getByRole('button', { name: /我的线路/ }).click()
    await common.page.getByRole('dialog').getByText('LocalOnly', { exact: true }).waitFor()
    await common.context.close()

    const ordinary = await fixture(user('alice', 'user'))
    await ordinary.page.getByRole('button', { name: /我的线路/ }).click()
    assert.equal(await ordinary.page.getByRole('button', { name: '新增私有', exact: true }).count(), 0)
    assert.equal(await ordinary.page.getByRole('button', { name: '分配用户', exact: true }).count(), 0)
    await ordinary.page.getByRole('button', { name: '导入线路', exact: true }).click()
    ordinary.db.failImport = true
    await ordinary.page.getByLabel('分享链接').fill('socks5://127.0.0.1:16662#CloudOnly')
    await ordinary.page.getByRole('button', { name: '验证并导入' }).click()
    await ordinary.page.getByText(/fixture save failure/).waitFor()
    assert.match(await ordinary.page.getByLabel('分享链接').inputValue(), /CloudOnly/)
    ordinary.db.failImport = false
    await ordinary.page.getByRole('button', { name: '验证并导入' }).click()
    await ordinary.page.getByRole('dialog').getByText('CloudOnly', { exact: true }).waitFor()
    await ordinary.page.reload(); await ordinary.page.getByRole('button', { name: /我的线路/ }).click()
    await ordinary.page.getByRole('dialog').getByText('CloudOnly', { exact: true }).waitFor()
    assert.equal((await ordinary.page.evaluate(() => Object.keys(localStorage))).some(key => key.endsWith(':nodes')), false)
    const uploadsBeforeLegacy = ordinary.db.requests.filter(item => item.endpoint === '/api/nodes' && item.method === 'POST').length
    await ordinary.page.evaluate(() => localStorage.setItem('qaletxNodes', JSON.stringify([{ id: 'legacy', name: 'Legacy', uri: 'socks5://127.0.0.1:16667#Legacy' }])))
    await ordinary.page.reload(); await ordinary.page.getByRole('button', { name: /我的线路/ }).click()
    await ordinary.page.getByText(/发现旧版本本机线路/).waitFor()
    assert.equal(ordinary.db.requests.filter(item => item.endpoint === '/api/nodes' && item.method === 'POST').length, uploadsBeforeLegacy)
    await ordinary.page.locator('.legacy-import summary').click()
    await ordinary.page.getByRole('button', { name: '确认属于我，查看并导入' }).click()
    assert.match(await ordinary.page.getByLabel('分享链接').inputValue(), /Legacy/)
    assert.equal(ordinary.db.requests.filter(item => item.endpoint === '/api/nodes' && item.method === 'POST').length, uploadsBeforeLegacy)
    await ordinary.page.getByRole('button', { name: '返回线路', exact: true }).click()
    ordinary.db.nodes = []
    await ordinary.page.getByRole('dialog').getByRole('button', { name: '刷新', exact: true }).click()
    await ordinary.page.getByRole('dialog').getByText('还没有可用线路', { exact: true }).waitFor()
    await ordinary.page.getByRole('button', { name: '关闭对话框' }).click()
    assert.equal(await ordinary.page.getByRole('button', { name: '一键连接', exact: true }).isDisabled(), true)
    await ordinary.context.close()

    const delegated = await fixture(user('manager', 'admin'))
    await delegated.page.getByRole('button', { name: /用户管理/ }).click()
    await delegated.page.getByRole('button', { name: '创建账号', exact: true }).click()
    assert.equal(await delegated.page.locator('option[value="admin"]').count(), 0)
    await delegated.context.close()
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ rendererV05: 'passed', roles: ['root', 'admin', 'user', 'shared'], checks: ['compact-layout', 'session-initialization', 'private-no-export', 'measured-latency', 'cloud-rename-note', 'revision-conflict-preserves-input', 'private-conversion', 'private-assignment', 'shared-creation', 'private-master-switch', 'shared-no-password', 'shared-local-only', 'cloud-failure-preserves-input', 'cloud-reload-sync', 'admin-cannot-create-admin', 'private-uri-single-and-valid', 'stale-grant-filter', 'legacy-no-auto-upload', 'empty-authorized-list'], systemProxyModified: false }))
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
