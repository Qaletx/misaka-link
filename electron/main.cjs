const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn, spawnSync, execFileSync } = require('child_process')

// The private node is injected at build time into the ignored private-node.cjs
// file. The renderer receives only the opaque `privateId`, so the share URL is
// not part of the UI state, clipboard path, or localStorage.
let PRIVATE_NODE_URIS = {}
try { PRIVATE_NODE_URIS = require('./private-node.cjs') } catch {}

let mainWindow
let coreProcess = null
let tray = null
let isQuitting = false
let proxyState = null

function stopCore() {
  if (coreProcess) { coreProcess.kill(); coreProcess = null }
  restoreSystemProxy()
}

function run(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', windowsHide: true }).trim() } catch { return '' }
}

function setWindowsProxy(enabled) {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  if (!proxyState) {
    proxyState = { platform: 'win32', enable: run('reg.exe', ['query', key, '/v', 'ProxyEnable']), server: run('reg.exe', ['query', key, '/v', 'ProxyServer']) }
  }
  run('reg.exe', ['add', key, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', enabled ? '1' : '0', '/f'])
  if (enabled) run('reg.exe', ['add', key, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', '127.0.0.1:10808', '/f'])
}

function macService() {
  return run('networksetup', ['-listallnetworkservices']).split(/\r?\n/).find((line) => line && !line.startsWith('An asterisk') && !line.includes('Bluetooth')) || ''
}

function setMacProxy(enabled) {
  const service = macService()
  if (!service) return
  if (!proxyState) proxyState = { platform: 'darwin', service, web: run('networksetup', ['-getwebproxy', service]), secure: run('networksetup', ['-getsecurewebproxy', service]) }
  for (const protocol of ['web', 'secureweb']) {
    if (enabled) run('networksetup', [`-set${protocol}proxy`, service, '127.0.0.1', '10808'])
    else run('networksetup', [`-set${protocol}proxystate`, service, 'off'])
  }
}

function setSystemProxy(enabled) {
  if (process.platform === 'win32') setWindowsProxy(enabled)
  if (process.platform === 'darwin') setMacProxy(enabled)
}

function restoreSystemProxy() {
  if (!proxyState) return
  if (proxyState.platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const enableMatch = proxyState.enable.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i)
    const serverMatch = proxyState.server.match(/ProxyServer\s+REG_SZ\s+(.+)/i)
    run('reg.exe', ['add', key, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', enableMatch ? String(parseInt(enableMatch[1], 16)) : '0', '/f'])
    if (serverMatch) run('reg.exe', ['add', key, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', serverMatch[1].trim(), '/f'])
  }
  if (proxyState.platform === 'darwin') {
    const { service, web, secure } = proxyState
    for (const [protocol, output] of [['web', web], ['secureweb', secure]]) {
      const enabled = /Enabled:\s+Yes/i.test(output)
      const server = output.match(/Server:\s+(.+)/i)?.[1]?.trim()
      const port = output.match(/Port:\s+(\d+)/i)?.[1]
      if (enabled && server && port) run('networksetup', [`-set${protocol}proxy`, service, server, port])
      else run('networksetup', [`-set${protocol}proxystate`, service, 'off'])
    }
  }
  proxyState = null
}

function createTray() {
  const iconName = process.platform === 'win32' ? 'qaletx-link.ico' : 'qaletx-link.png'
  const candidates = [path.join(process.resourcesPath, 'assets', iconName), path.join(__dirname, '..', 'assets', iconName)]
  const iconPath = candidates.find((candidate) => fs.existsSync(candidate))
  if (!iconPath) return
  tray = new Tray(nativeImage.createFromPath(iconPath))
  tray.setToolTip('qaletx link')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 qaletx link', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; stopCore(); app.quit() } }
  ]))
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1020,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#071114',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); mainWindow.hide() }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

function locateCore() {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const archName = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const names = process.platform === 'darwin'
    ? [`sing-box-${archName}`, `hysteria-${archName}`, 'sing-box', 'hysteria']
    : ['sing-box', 'clash-meta', 'hysteria'].map((name) => name + suffix)
  const roots = [path.join(process.resourcesPath, 'core'), path.join(__dirname, '..', 'core'), path.join(app.getPath('userData'), 'core')]
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name)
      if (fs.existsSync(candidate)) return { path: candidate, name: name.replace(suffix, '') }
    }
  }
  return null
}

function parseShareUri(raw) {
  const uri = raw.replace(/^hy2:\/\//i, 'hysteria2://')
  if (/^vmess:\/\//i.test(uri)) {
    const payload = uri.slice(8).replace(/-/g, '+').replace(/_/g, '/')
    return { scheme: 'vmess', data: JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) }
  }
  const parsed = new URL(uri)
  return { scheme: parsed.protocol.slice(0, -1).toLowerCase(), parsed }
}

function queryBoolean(parsed, name) {
  const value = parsed.searchParams.get(name)
  return value === '1' || value === 'true' || value === 'yes'
}

function queryNumber(parsed, ...names) {
  for (const name of names) {
    const value = Number(parsed.searchParams.get(name))
    if (Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

function addTransport(outbound, parsed) {
  const type = parsed.searchParams.get('type') || parsed.searchParams.get('net') || 'tcp'
  if (type === 'ws') {
    outbound.transport = {
      type: 'ws',
      path: parsed.searchParams.get('path') || '/',
      headers: parsed.searchParams.get('host') ? { Host: parsed.searchParams.get('host') } : undefined
    }
  }
  if (type === 'grpc') outbound.transport = { type: 'grpc', service_name: parsed.searchParams.get('serviceName') || parsed.searchParams.get('serviceName'.toLowerCase()) || '' }
  if (type === 'http') outbound.transport = { type: 'http', path: parsed.searchParams.get('path') || '/', host: parsed.searchParams.get('host') ? [parsed.searchParams.get('host')] : undefined }
  return outbound
}

function singBoxConfig(uri) {
  const item = parseShareUri(uri)
  let outbound
  if (item.scheme === 'hysteria2') {
    const p = item.parsed
    outbound = { type: 'hysteria2', tag: 'proxy', server: p.hostname, server_port: Number(p.port || 443), password: decodeURIComponent(p.username || ''), tls: { enabled: true, server_name: p.searchParams.get('sni') || p.hostname, insecure: queryBoolean(p, 'insecure') } }
    const obfs = p.searchParams.get('obfs')
    if (obfs) outbound.obfs = { type: obfs, password: p.searchParams.get('obfs-password') || p.searchParams.get('obfsPassword') || '' }
    const up = queryNumber(p, 'upmbps', 'up')
    const down = queryNumber(p, 'downmbps', 'down')
    if (up) outbound.up_mbps = up
    if (down) outbound.down_mbps = down
    if (p.searchParams.get('pinSHA256')) outbound.tls.certificate_public_key_sha256 = [p.searchParams.get('pinSHA256')]
  } else if (item.scheme === 'trojan') {
    const p = item.parsed
    outbound = { type: 'trojan', tag: 'proxy', server: p.hostname, server_port: Number(p.port || 443), password: decodeURIComponent(p.username || ''), tls: { enabled: true, server_name: p.searchParams.get('sni') || p.hostname, insecure: queryBoolean(p, 'insecure') } }
    addTransport(outbound, p)
  } else if (item.scheme === 'tuic') {
    const p = item.parsed
    outbound = { type: 'tuic', tag: 'proxy', server: p.hostname, server_port: Number(p.port || 443), uuid: decodeURIComponent(p.username || ''), password: decodeURIComponent(p.password || ''), tls: { enabled: true, server_name: p.searchParams.get('sni') || p.hostname, insecure: queryBoolean(p, 'insecure') } }
  } else if (item.scheme === 'vless') {
    const p = item.parsed; const type = p.searchParams.get('type') || 'tcp'
    const security = p.searchParams.get('security') || 'none'
    outbound = { type: 'vless', tag: 'proxy', server: p.hostname, server_port: Number(p.port || 443), uuid: decodeURIComponent(p.username || ''), tls: { enabled: security !== 'none', server_name: p.searchParams.get('sni') || p.hostname, insecure: queryBoolean(p, 'insecure') } }
    if (p.searchParams.get('flow')) outbound.flow = p.searchParams.get('flow')
    if (security === 'reality') {
      outbound.tls.reality = { enabled: true, public_key: p.searchParams.get('pbk') || p.searchParams.get('publicKey') || '', short_id: p.searchParams.get('sid') || p.searchParams.get('shortId') || '' }
      if (p.searchParams.get('fp')) outbound.tls.utls = { enabled: true, fingerprint: p.searchParams.get('fp') }
    }
    addTransport(outbound, p)
  } else if (item.scheme === 'ss') {
    const p = item.parsed
    let method = decodeURIComponent(p.username || '')
    let password = decodeURIComponent(p.password || '')
    let server = p.hostname
    let port = Number(p.port || 443)
    if (!method && !password) {
      const payload = p.hostname || p.pathname.replace(/^\//, '')
      const decoded = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      const match = decoded.match(/^([^:]+):([^@]+)@(.+):([0-9]+)$/)
      if (!match) throw new Error('Shadowsocks 链接格式无效')
      method = match[1]; password = match[2]; server = match[3]; port = Number(match[4])
    }
    outbound = { type: 'shadowsocks', tag: 'proxy', server, server_port: port, method, password }
  } else if (item.scheme === 'socks5' || item.scheme === 'http') {
    const p = item.parsed; outbound = { type: item.scheme, tag: 'proxy', server: p.hostname, server_port: Number(p.port || 1080) }
    if (p.username) outbound.username = decodeURIComponent(p.username)
    if (p.password) outbound.password = decodeURIComponent(p.password)
  } else if (item.scheme === 'vmess') {
    const d = item.data; outbound = { type: 'vmess', tag: 'proxy', server: d.add, server_port: Number(d.port || 443), uuid: d.id, security: d.scy || 'auto', tls: { enabled: d.tls === 'tls', server_name: d.sni || d.host || d.add } }
    if (d.net === 'ws') outbound.transport = { type: 'ws', path: d.path || '/', headers: d.host ? { Host: d.host } : undefined }
    if (d.net === 'grpc') outbound.transport = { type: 'grpc', service_name: d.path || '' }
  } else throw new Error('不支持的节点协议')
  return JSON.stringify({
    log: { level: 'warn' },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 10808 }],
    outbounds: [outbound, { type: 'direct', tag: 'direct' }],
    route: { auto_detect_interface: true, final: 'proxy' }
  }, null, 2)
}

function hysteriaConfig(uri) {
  const parsed = new URL(uri)
  const server = `${parsed.hostname}:${parsed.port || '443'}`
  const auth = decodeURIComponent(parsed.username || '')
  const sni = parsed.searchParams.get('sni') || parsed.hostname
  const insecure = parsed.searchParams.get('insecure') === '1' || parsed.searchParams.get('insecure') === 'true'
  return [
    `server: ${server}`,
    `auth: ${JSON.stringify(auth)}`,
    'tls:',
    `  sni: ${sni}`,
    `  insecure: ${insecure}`,
    'socks5:',
    '  listen: 127.0.0.1:10808',
    ''
  ].join('\n')
}

ipcMain.handle('app:get-info', () => { const core = locateCore(); return { platform: process.platform, version: app.getVersion(), core: Boolean(core), coreName: core?.name || '' } })
ipcMain.handle('shell:open-external', (_event, url) => shell.openExternal(url))
ipcMain.handle('core:connect', async (_event, payload) => {
  if (coreProcess) return { ok: true, mode: 'running' }
  const core = locateCore()
  if (!core) return { ok: false, mode: 'missing', message: '未检测到代理核心，当前安装包无法建立真实连接。请安装包含核心的完整客户端。' }
  const binary = core.path
  const uri = payload?.privateId ? PRIVATE_NODE_URIS[payload.privateId] : payload?.uri
  if (!uri) return { ok: false, mode: 'invalid', message: '节点配置为空或已失效' }

  const isSingBox = core.name.startsWith('sing-box')
  let configText
  try { configText = isSingBox ? singBoxConfig(uri) : hysteriaConfig(uri) } catch (error) { return { ok: false, mode: 'unsupported', message: error.message || '节点协议暂不支持' } }
  const configPath = path.join(app.getPath('userData'), `misaka-link-config.${isSingBox ? 'json' : 'yaml'}`)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, configText, 'utf8')
  if (isSingBox) {
    const check = spawnSync(binary, ['check', '-c', configPath], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    if (check.error || check.status !== 0) {
      try { fs.unlinkSync(configPath) } catch {}
      const diagnostic = String(check.stderr || check.stdout || check.error?.message || '').trim()
      return { ok: false, mode: 'invalid', message: diagnostic ? `节点配置校验失败：${diagnostic.slice(0, 180)}` : '节点配置校验失败，请检查分享链接' }
    }
  }
  const command = core.name.startsWith('hysteria') ? ['client', '-c', configPath] : core.name === 'clash-meta' ? ['-f', configPath] : ['run', '-c', configPath]
  coreProcess = spawn(binary, command, { windowsHide: true })
  coreProcess.once('error', (error) => {
    coreProcess = null
    restoreSystemProxy()
    mainWindow?.webContents.send('core:exit', { error: error.message })
  })
  coreProcess.on('exit', () => { coreProcess = null; restoreSystemProxy(); mainWindow?.webContents.send('core:exit') })
  setSystemProxy(true)
  return { ok: true, mode: 'core', core: core.name, message: '代理核心已启动，系统代理已开启。' }
})
ipcMain.handle('core:disconnect', async () => {
  stopCore()
  return { ok: true }
})

app.whenReady().then(() => {
  createWindow()
  createTray()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('before-quit', () => { isQuitting = true; stopCore() })
app.on('window-all-closed', () => {})

