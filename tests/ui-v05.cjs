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
    const context = await browser.newContext({ viewport: { width: 960, height: 612 } })
    const db = { nodes: [{ ...privateNode }, ...(account.role === 'shared' ? [] : [{ ...personalNode }])], users: [user('root', 'admin', true), user('customer', 'user'), user('shared-team', 'shared')], requests: [], conflict: false, failImport: false, failList: false }
    await context.addInitScript(({ account }) => {
      window.__ipc = []
      window.__policy = {autoRecover:true,automatic:false}
      window.__status = { phase: 'idle', connected: false, port: 10808 }
      window.__emitStatus = value => { window.__status = { ...window.__status, ...value }; window.__statusListener?.(window.__status) }
      if (!localStorage.getItem('misakaAccount')) localStorage.setItem('misakaAccount', JSON.stringify({ ...account, token: `fixture-${account.username}`, apiUrl: 'http://fixture.invalid' }))
      window.misaka = {
        setSession: async value => { window.__ipc.push({ op: 'setSession', value }); return { ok: true, user: account } },
        clearSession: async () => { window.__ipc.push({ op: 'clearSession' }); return { ok: true } },
        getInfo: async () => ({ version: '0.6.0', core: true, coreName: 'sing-box', platform: 'win32' }),
        getPreferences: async () => window.__policy,
        setPreferences: async patch => {window.__policy={...window.__policy,...patch};return window.__policy},
        setSelection: async value => {window.__policy.selection=value;return {ok:true}},
        setCatalog: async () => ({ok:true}),
        diagnose: async () => ({result:{ok:true,latencyMs:42},report:'qaletx link 0.6.0 脱敏报告\n连通性 42 ms'}),
        diagnosticReport: async () => 'qaletx link 0.6.0 脱敏报告',
        getStatus: async () => window.__status,
        onStatus: callback => { window.__statusListener = callback; return () => { window.__statusListener = null } }, getLogs: async () => [],
        setProxyPort: async value => { window.__ipc.push({ op: 'setProxyPort', value }); window.__emitStatus({ port: value }); return { ok: true, port: value } },
        connect: async value => { window.__ipc.push({ op: 'connect', value }); if (window.__holdConnect) await new Promise(resolve => { window.__releaseConnect = resolve }); if (window.__simulateConnection) window.__emitStatus({ phase: 'connected', connected: true, nodeId: value.nodeId || value.id }); return { ok: true } },
        disconnect: async () => { window.__ipc.push({ op: 'disconnect' }); window.__holdConnect = false; window.__releaseConnect?.(); if (window.__simulateConnection) window.__emitStatus({ phase: 'idle', connected: false }); return { ok: true } },
        testNode: async value => { window.__ipc.push({ op: 'testNode', value }); await new Promise(resolve => setTimeout(resolve, 20)); return { ok: true, latencyMs: 42, checkedAt: Date.now() } },
        validateNodes: async value => ({ nodes: value.split('\n').filter(line => /^socks5:\/\//.test(line)).map(uri => ({ uri, name: decodeURIComponent(uri.split('#')[1] || 'Imported'), protocol: 'SOCKS5' })), errors: [] })
      }
    }, { account })
    await context.route('**/api/**', async route => {
      const req = route.request(), endpoint = new URL(req.url()).pathname, method = req.method()
      const body = req.postDataJSON()
      db.requests.push({ endpoint, method, body })
      let status = 200, data = { ok: true }
      const usage=username=>({username,period:'2026-10',usedBytes:2500000000,quotaBytes:username==='root'?null:100000000000,metered:true,live:true,uploadBytes:500000000,downloadBytes:2000000000,sampledAt:Date.now(),...db.quotas?.[username]})
      const deviceValues=[{id:'fixture-current',name:'我的电脑',platform:'win32',version:'0.6.0',lastSeenAt:Date.now(),current:true,proxyOnline:true},{id:'fixture-other',name:'备用电脑',platform:'darwin',version:'0.6.0',lastSeenAt:Date.now(),current:false,proxyOnline:false}].filter(s=>!db.removed?.includes(s.id))
      if (endpoint === '/api/me') data = { user: account }
      else if(endpoint==='/api/me/usage')data={usage:usage(account.username)}
      else if(endpoint==='/api/me/sessions'||/^\/api\/users\/[^/]+\/sessions$/.test(endpoint))data={sessions:account.role==='shared'?deviceValues.filter(s=>s.current):deviceValues}
      else if(/^\/api\/sessions\//.test(endpoint)&&method==='DELETE'){db.removed=[...(db.removed||[]),endpoint.split('/').pop()];data={ok:true}}
      else if(/^\/api\/users\/[^/]+\/usage$/.test(endpoint))data={usage:usage(endpoint.split('/')[3])}
      else if(/^\/api\/users\/[^/]+\/quota$/.test(endpoint)){const username=endpoint.split('/')[3];db.quotas={...db.quotas,[username]:{quotaBytes:body.quotaBytes}};data={usage:usage(username)}}
      else if(/^\/api\/users\/[^/]+\/quota\/reset$/.test(endpoint)){const username=endpoint.split('/')[3];db.quotas={...db.quotas,[username]:{...db.quotas?.[username],usedBytes:0}};data={usage:usage(username)}}
      else if(endpoint==='/api/managed-services')data={services:[{id:'primary',ready:true,sampledAt:Date.now()}]}
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
      else if (endpoint === '/api/stats') data = { userCount: db.users.length, activeSessions: 2,usage:db.users.map(u=>usage(u.username)),services:[{id:'primary',sampledAt:Date.now(),error:''}] }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'Access-Control-Allow-Origin': '*' } })
    })
    const page = await context.newPage(); page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(address)
    await page.getByRole('button', { name: '一键连接', exact: true }).waitFor()
    await page.locator('.nodes-preview').getByText('专属主线路', { exact: true }).waitFor()
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
    await page.screenshot({animations: 'disabled', path: path.join(output, 'v05-dashboard.png') })
    await page.getByRole('button',{name:'管理概览',exact:true}).click()
    await page.getByRole('dialog').getByText('把连接与用量，看清楚。',{exact:true}).waitFor()
    await page.screenshot({animations: 'disabled',path:path.join(output,'v06-overview.png')})
    await page.getByRole('dialog').getByRole('button',{name:'管理用户与额度'}).click()
    await page.locator('.user-row').filter({hasText:'customer'}).getByRole('button',{name:'流量与设备'}).click()
    await page.getByRole('dialog').getByText('备用电脑',{exact:true}).waitFor()
    await page.getByRole('switch',{name:/不限流量/}).uncheck()
    await page.getByLabel('每月额度（GB）').fill('300')
    await page.getByRole('button',{name:'保存额度',exact:true}).click()
    await page.waitForFunction(()=>document.querySelector('[role="dialog"] .usage-strip')?.textContent.includes('300.00 GB'))
    assert.equal(db.quotas.customer.quotaBytes,300000000000)
    await page.locator('.device-row').filter({hasText:'备用电脑'}).getByRole('button',{name:'退出会话'}).click()
    await page.getByRole('button',{name:'确认退出',exact:true}).click()
    await page.waitForFunction(()=>!document.querySelector('[role="dialog"] .device-list')?.textContent.includes('备用电脑'))
    await page.screenshot({animations: 'disabled',path:path.join(output,'v06-quota-devices.png')})
    await page.getByRole('button',{name:'关闭对话框',exact:true}).click()
    await page.getByRole('button',{name:'关闭对话框',exact:true}).click()
    await page.getByRole('button',{name:'偏好设置',exact:true}).first().click()
    await page.getByRole('switch',{name:/自动选线与故障切线/}).check()
    assert.equal(await page.evaluate(()=>window.__policy.automatic),true)
    await page.screenshot({animations: 'disabled',path:path.join(output,'v06-preferences.png')})
    await page.getByRole('dialog').getByRole('button',{name:'连接诊断',exact:true}).click()
    await page.getByRole('button',{name:'一键诊断',exact:true}).click()
    await page.getByRole('dialog').getByText('线路连通 · 42 ms',{exact:true}).waitFor()
    await page.screenshot({animations: 'disabled',path:path.join(output,'v06-diagnostics.png')})
    await page.getByRole('button',{name:'关闭对话框',exact:true}).click()
    await page.setViewportSize({width:860,height:552})
    assert.ok(await page.evaluate(()=>document.querySelector('.connect-button').getBoundingClientRect().bottom<innerHeight))
    await page.screenshot({animations: 'disabled',path:path.join(output,'v06-small-dashboard.png')})
    await page.setViewportSize({width:960,height:612})
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
    await page.screenshot({animations: 'disabled', path: path.join(output, 'v05-nodes.png') })
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

    const switching = await fixture(user('switcher', 'user'))
    const switchPage = switching.page
    await switchPage.getByRole('button', { name: '切换线路', exact: true }).click()
    const switchDialog = switchPage.getByRole('dialog')
    await switchDialog.locator('.node-card').filter({ hasText: '我的备用线路' }).locator('.node-select').click()
    assert.equal(await switchPage.locator('.nodes-preview .node-main strong').innerText(), '专属主线路', 'selection stays pending until confirmation')
    await switchDialog.getByRole('button', { name: '关闭对话框' }).click()
    assert.equal(await switchPage.locator('.nodes-preview .node-main strong').innerText(), '专属主线路', 'closing discards draft selection')
    await switchPage.getByRole('button', { name: '切换线路', exact: true }).click()
    await switchDialog.locator('.node-card').filter({ hasText: '我的备用线路' }).locator('.node-select').click()
    await switchDialog.getByRole('button', { name: '确认选择' }).click()
    assert.equal(await switchPage.locator('.nodes-preview .node-main strong').innerText(), '我的备用线路')
    assert.equal((await switchPage.evaluate(() => window.__ipc)).filter(item => item.op === 'connect').length, 0, 'disconnected selection does not connect before the user clicks')
    await switchPage.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '偏好设置' }).click()
    await switchPage.getByLabel('监听端口').fill('12080')
    await switchPage.getByRole('button', { name: '保存端口' }).click()
    await switchPage.getByText('127.0.0.1:12080').waitFor()
    assert.ok((await switchPage.evaluate(() => window.__ipc)).some(item => item.op === 'setProxyPort' && item.value === 12080))
    await switchPage.getByRole('button', { name: '恢复默认' }).click()
    await switchPage.getByRole('button', { name: '保存端口' }).click()
    await switchPage.getByText('127.0.0.1:10808').waitFor()
    await switchPage.getByRole('button', { name: '关闭对话框' }).click()
    await switchPage.evaluate(() => { window.__simulateConnection = true; window.__emitStatus({ phase: 'connected', connected: true, nodeId: 'personal-one' }) })
    await switchPage.getByRole('button', { name: '切换线路', exact: true }).click()
    await switchDialog.locator('.node-card').filter({ hasText: '专属主线路' }).locator('.node-select').click()
    await switchDialog.getByRole('button', { name: '确认切换并连接' }).click()
    await switchPage.getByText('已切换并连接 专属主线路').waitFor()
    assert.ok((await switchPage.evaluate(() => window.__ipc)).some(item => item.op === 'connect' && item.value.nodeId === 'private-one'))
    await switching.context.close()

    const common = await fixture(user('shared-one', 'shared'))
    await common.page.locator('.sidebar-account').click()
    assert.equal(await common.page.getByRole('button', { name: '修改密码', exact: true }).count(), 0)
    await common.page.getByText('这是一个共用账号', { exact: true }).waitFor()
    await common.page.getByRole('button', { name: '知道了' }).click()
    await common.page.getByRole('button', { name: /我的线路/ }).click()
    await common.page.getByRole('button', { name: '导入线路', exact: true }).click()
    await common.page.getByLabel('分享链接').fill('socks5://127.0.0.1:16661#LocalOnly')
    await common.page.getByRole('button', { name: '验证并导入' }).click()
    await common.page.locator('.modal-node-list').getByText('LocalOnly', { exact: true }).waitFor()
    assert.equal(common.db.requests.filter(item => item.endpoint === '/api/nodes' && item.method === 'POST').length, 0)
    const keys = await common.page.evaluate(() => Object.keys(localStorage))
    assert.ok(keys.some(key => key.includes('shared-one') && key.endsWith(':nodes')))
    await common.page.reload(); await common.page.getByRole('button', { name: /我的线路/ }).click()
    await common.page.locator('.modal-node-list').getByText('LocalOnly', { exact: true }).waitFor()
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
    await ordinary.page.locator('.modal-node-list').getByText('CloudOnly', { exact: true }).waitFor()
    await ordinary.page.reload(); await ordinary.page.getByRole('button', { name: /我的线路/ }).click()
    await ordinary.page.locator('.modal-node-list').getByText('CloudOnly', { exact: true }).waitFor()
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
    console.log(JSON.stringify({ rendererV05: 'passed', roles: ['root', 'admin', 'user', 'shared'], checks: ['compact-layout', 'session-initialization', 'private-no-export', 'measured-latency', 'cloud-rename-note', 'revision-conflict-preserves-input', 'private-conversion', 'private-assignment', 'shared-creation', 'private-master-switch', 'shared-no-password', 'shared-local-only', 'cloud-failure-preserves-input', 'cloud-reload-sync', 'admin-cannot-create-admin', 'private-uri-single-and-valid', 'stale-grant-filter', 'legacy-no-auto-upload', 'empty-authorized-list', 'route-choice-confirmation', 'connected-route-switch', 'custom-proxy-port'], systemProxyModified: false }))
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
