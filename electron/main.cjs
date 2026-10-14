const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

let mainWindow
let coreProcess = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#071114',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

function locateCore() {
  const candidates = [
    path.join(process.resourcesPath, 'core', process.platform === 'win32' ? 'hysteria.exe' : 'hysteria'),
    path.join(__dirname, '..', 'core', process.platform === 'win32' ? 'hysteria.exe' : 'hysteria'),
    path.join(app.getPath('userData'), 'core', process.platform === 'win32' ? 'hysteria.exe' : 'hysteria')
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
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

ipcMain.handle('app:get-info', () => ({ platform: process.platform, version: app.getVersion(), core: Boolean(locateCore()) }))
ipcMain.handle('shell:open-external', (_event, url) => shell.openExternal(url))
ipcMain.handle('core:connect', async (_event, payload) => {
  if (coreProcess) return { ok: true, mode: 'running' }
  const binary = locateCore()
  if (!binary) return { ok: true, mode: 'demo', message: '未检测到 Hysteria2 核心，已进入演示连接状态。将核心放入 core 文件夹后即可启用真实连接。' }

  const configPath = path.join(app.getPath('userData'), 'misaka-link-config.json')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, hysteriaConfig(payload.uri), 'utf8')
  coreProcess = spawn(binary, ['client', '-c', configPath], { windowsHide: true })
  coreProcess.on('exit', () => { coreProcess = null; mainWindow?.webContents.send('core:exit') })
  return { ok: true, mode: 'core', message: 'Hysteria2 核心已启动。' }
})
ipcMain.handle('core:disconnect', async () => {
  if (coreProcess) { coreProcess.kill(); coreProcess = null }
  return { ok: true }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
