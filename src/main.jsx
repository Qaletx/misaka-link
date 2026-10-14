import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const defaultUri = 'hysteria2://82409cf6@147.189.161.140:14647?sni=www.bing.com&insecure=1#Hysteria2-misaka'
const DEFAULT_API_URL = import.meta.env.VITE_API_URL || 'http://147.189.161.140:8787'

const initialNodes = [
  { id: 'misaka', name: 'qaletx · 主节点', region: '美国 / 纽约', latency: 128, status: 'online', uri: defaultUri, emoji: '◎', note: '默认节点' },
  { id: 'backup', name: '备用节点', region: '未导入', latency: null, status: 'idle', uri: '', emoji: '＋', note: '等待导入' }
]

function Icon({ name, size = 18 }) {
  const paths = {
    bolt: <path d="m13 2-9 11h7l-1 9 9-12h-7l1-8Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    settings: <><path d="M12 15.3a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6Z" /><path d="m19.4 15 .1.1a2 2 0 0 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4v.2a2 2 0 0 1-4 0v-.2a2 2 0 0 0-3.4-1.4l-.1.1A2 2 0 0 1 3 15.1l.1-.1a2 2 0 0 0-1.4-3.4h-.2a2 2 0 0 1 0-4h.2A2 2 0 0 0 3.1 4.2L3 4.1A2 2 0 0 1 5.8 1.3l.1.1a2 2 0 0 0 3.4-1.4V0a2 2 0 0 1 4 0v.2a2 2 0 0 0 3.4 1.4l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a2 2 0 0 0 1.4 3.4h.2a2 2 0 0 1 0 4h-.2a2 2 0 0 0-1.4 3.2Z" transform="translate(0 2) scale(.83)" /></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    arrow: <><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></>,
    shield: <path d="M12 3 20 6v5c0 5.2-3.4 8.2-8 10-4.6-1.8-8-4.8-8-10V6l8-3Z" />,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.2 2.5 3.2 5.5 3.2 9s-1 6.5-3.2 9c-2.2-2.5-3.2-5.5-3.2-9S9.8 5.5 12 3Z" /></>,
    upload: <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 20h16" /></>
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

function Dashboard({ account, onLogout }) {
  const [nodes, setNodes] = useState(initialNodes)
  const [selected, setSelected] = useState('misaka')
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [notice, setNotice] = useState('')
  const [appInfo, setAppInfo] = useState({ platform: 'unknown', core: false })
  const [session, setSession] = useState({ up: '0 B', down: '0 B', time: '00:00:00' })
  const [showUsers, setShowUsers] = useState(false)
  const [users, setUsers] = useState([])
  const [newUserPassword, setNewUserPassword] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newAccountPassword, setNewAccountPassword] = useState('')
  const [stats, setStats] = useState({ userCount: 0, activeSessions: 0 })
  const [adminBusy, setAdminBusy] = useState(false)

  const activeNode = useMemo(() => nodes.find((node) => node.id === selected) || nodes[0], [nodes, selected])
  const activeDetails = useMemo(() => parseNode(activeNode?.uri), [activeNode])
  const canConnect = activeNode?.uri

  useEffect(() => {
    window.misaka?.getInfo?.().then(setAppInfo)
    const timer = setInterval(() => {
      if (!connected) return
      setSession((prev) => ({ ...prev, time: incrementTime(prev.time), up: '1.2 MB', down: '18.6 MB' }))
    }, 1000)
    return () => clearInterval(timer)
  }, [connected])

  const notify = (message) => { setNotice(message); setTimeout(() => setNotice(''), 3600) }

  async function openUsers() {
    setShowUsers(true)
    setAdminBusy(true)
    try {
      const [response, statsResponse] = await Promise.all([apiFetch('/api/users', { token: account.token }), apiFetch('/api/stats', { token: account.token })])
      if (!response.ok) throw new Error(response.data?.error || '读取用户失败')
      setUsers(response.data.users || [])
      if (statsResponse.ok) setStats(statsResponse.data)
    } catch (error) { notify(error.message) } finally { setAdminBusy(false) }
  }

  async function createUser() {
    if (!newUsername.trim() || newAccountPassword.length < 8) { notify('请填写账号，密码至少 8 位'); return }
    setAdminBusy(true)
    try {
      const response = await apiFetch('/api/users', { method: 'POST', token: account.token, body: { username: newUsername, password: newAccountPassword } })
      if (!response.ok) throw new Error(response.data?.error || '创建失败')
      setNewUsername(''); setNewAccountPassword(''); notify('新用户已创建'); await openUsers()
    } catch (error) { notify(error.message) } finally { setAdminBusy(false) }
  }

  async function deleteUser(username) {
    if (!window.confirm(`确定删除 ${username}？`)) return
    setAdminBusy(true)
    try {
      const response = await apiFetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE', token: account.token })
      if (!response.ok) throw new Error(response.data?.error || '删除失败')
      notify('用户已删除'); await openUsers()
    } catch (error) { notify(error.message) } finally { setAdminBusy(false) }
  }

  async function updateUserPassword() {
    if (newUserPassword.length < 8) { notify('新密码至少需要 8 位'); return }
    setAdminBusy(true)
    try {
      const response = await apiFetch('/api/users/user/password', { method: 'PATCH', token: account.token, body: { password: newUserPassword } })
      if (!response.ok) throw new Error(response.data?.error || '修改失败')
      setNewUserPassword('')
      notify('user 密码已更新')
      await openUsers()
    } catch (error) { notify(error.message) } finally { setAdminBusy(false) }
  }

  async function toggleConnection() {
    if (connecting) return
    if (connected) {
      await window.misaka?.disconnect?.()
      setConnected(false)
      setSession({ up: '0 B', down: '0 B', time: '00:00:00' })
      notify('连接已断开')
      return
    }
    if (!canConnect) { notify('请先导入一个节点'); setShowImport(true); return }
    setConnecting(true)
    const result = await window.misaka?.connect?.({ uri: activeNode.uri, name: activeNode.name })
    await new Promise((resolve) => setTimeout(resolve, 850))
    setConnecting(false)
    setConnected(true)
    if (result?.mode === 'demo') notify('演示模式已连接 · 放入 Hysteria2 核心后可启用真实连接')
    else notify('安全隧道已建立')
  }

  function importNode() {
    const raw = importText.trim()
    if (!raw.startsWith('hysteria2://')) { notify('当前仅支持 hysteria2:// 节点'); return }
    const hash = raw.split('#')[1] || 'Imported node'
    const node = { id: `node-${Date.now()}`, name: decodeURIComponent(hash), region: '已导入节点', latency: 142, status: 'online', uri: raw, emoji: '◌', note: '刚刚导入' }
    setNodes((prev) => [...prev.filter((n) => n.id !== 'backup'), node, initialNodes[1]])
    setSelected(node.id)
    setImportText('')
    setShowImport(false)
    notify('节点已添加到列表')
  }

  function copyUri() {
    navigator.clipboard?.writeText(activeNode.uri)
    notify('节点链接已复制')
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-icon" src="./qaletx-link.svg" alt="qaletx link" /><div><div className="brand-name">qaletx link</div><div className="brand-sub">PRIVATE ACCESS</div></div></div>
      <div className="side-caption">工作区</div>
      <nav className="nav-list">
        <button className="nav-item active"><span className="nav-dot"></span><span>连接</span><span className="nav-kbd">01</span></button>
        <button className="nav-item" onClick={() => setShowImport(true)}><Icon name="plus" size={16}/><span>导入节点</span><span className="nav-kbd">⌘ I</span></button>
        {account.role === 'root' && <button className="nav-item" onClick={openUsers}><Icon name="settings" size={16}/><span>用户管理</span><span className="nav-kbd">ROOT</span></button>}
      </nav>
      <div className="sidebar-bottom">
        <div className="side-caption">当前版本</div>
        <div className="version-card"><div><span className="status-pip"></span><span>桌面端就绪</span></div><small>v0.1.0 · {appInfo.platform === 'darwin' ? 'macOS' : 'Windows'}</small></div>
        <button className="sidebar-settings" onClick={onLogout}><Icon name="settings" size={16}/>退出登录 · {account.username}</button>
      </div>
    </aside>

    <main className="main-panel">
      <header className="topbar"><div><div className="eyebrow">PRIVATE NETWORK / 01</div><h1>连接中心</h1></div><div className="topbar-right"><div className="secure-chip"><span className="status-pip"></span>端到端加密</div><button className="icon-button" title="设置"><Icon name="settings" size={18}/></button><div className="avatar">{account.username.slice(0, 1).toUpperCase()}</div></div></header>
      <div className="content-grid">
        <section className="hero-card">
          <div className="hero-bg"></div><div className="hero-content">
            <div className="hero-label"><span className="pulse-ring"></span>{connected ? '隧道运行中' : '准备就绪'}</div>
            <div className="hero-title">{connected ? '你的连接很顺畅。' : '让连接，简单一点。'}</div>
            <p className="hero-copy">选择一个节点，剩下的交给 qaletx link。</p>
            <button className={`connect-button ${connected ? 'disconnect' : ''}`} onClick={toggleConnection} disabled={connecting}>{connecting ? <><span className="spinner"></span>正在建立连接</> : connected ? <>断开连接 <Icon name="arrow" size={18}/></> : <>一键连接 <Icon name="arrow" size={18}/></>}</button>
          </div>
          <div className="hero-foot"><span><Icon name="shield" size={15}/>协议 Hysteria2</span><span><Icon name="globe" size={15}/>全局模式</span><span className="hero-foot-right">{connected ? `已保护 ${session.time}` : '等待连接'}</span></div>
        </section>

        <section className="metric-row"><div className="metric-card"><div className="metric-head"><span>下载</span><span className="metric-arrow down">↓</span></div><strong>{session.down}</strong><small>本次会话</small></div><div className="metric-card"><div className="metric-head"><span>上传</span><span className="metric-arrow up">↑</span></div><strong>{session.up}</strong><small>本次会话</small></div><div className="metric-card"><div className="metric-head"><span>连接时长</span><span className="metric-live">LIVE</span></div><strong>{session.time}</strong><small>{connected ? '正在计时' : '尚未连接'}</small></div></section>

        <section className="nodes-panel"><div className="section-head"><div><div className="eyebrow">AVAILABLE ROUTES</div><h2>我的节点 <span>{nodes.filter((n) => n.uri).length}</span></h2></div><button className="outline-button" onClick={() => setShowImport(true)}><Icon name="plus" size={16}/>导入节点</button></div><div className="nodes-list">{nodes.map((node) => <button className={`node-row ${selected === node.id ? 'selected' : ''}`} key={node.id} onClick={() => { if (!connected) setSelected(node.id); else notify('请先断开当前连接') }}><div className="node-symbol">{node.emoji}</div><div className="node-main"><strong>{node.name}</strong><span>{node.region} · {node.note}</span></div><div className="node-latency">{node.latency ? <><span className="latency-bar"><i></i><i></i><i></i><i></i></span>{node.latency} ms</> : <span className="muted">—</span>}</div><div className={`radio ${selected === node.id ? 'checked' : ''}`}><span></span></div></button>)}</div></section>

        <section className="details-panel"><div className="section-head"><div><div className="eyebrow">ACTIVE CONFIGURATION</div><h2>节点信息</h2></div><button className="copy-button" onClick={copyUri} disabled={!activeNode?.uri}><Icon name="copy" size={15}/>复制链接</button></div><div className="config-box"><div className="config-line"><span>名称</span><strong>{activeNode?.name || '未选择'}</strong></div><div className="config-line"><span>服务器</span><strong>{activeDetails?.server || '—'}</strong></div><div className="config-line"><span>SNI</span><strong>{activeDetails?.sni || '—'}</strong></div><div className="config-line"><span>核心状态</span><strong className={appInfo.core ? 'good' : 'warn'}>{appInfo.core ? '已检测到 Hysteria2' : '演示模式 · 未放入核心'}</strong></div></div></section>
      </div>
      <footer className="footer"><span><span className="status-pip"></span>qaletx link 正常运行</span><span>Windows 7+ / macOS Intel & Apple Silicon</span><span>帮助中心 ↗</span></footer>
    </main>

    {showImport && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setShowImport(false)}><div className="modal"><div className="modal-head"><div><div className="eyebrow">ADD A ROUTE</div><h2>导入节点</h2></div><button className="close-button" onClick={() => setShowImport(false)}>×</button></div><p className="modal-copy">粘贴 Hysteria2 分享链接，qaletx link 会自动解析并保存到你的节点列表。</p><textarea autoFocus placeholder="hysteria2://..." value={importText} onChange={(e) => setImportText(e.target.value)}></textarea><div className="modal-example"><span>示例格式</span><code>hysteria2://密码@服务器:端口?sni=域名</code></div><div className="modal-actions"><button className="cancel-button" onClick={() => setShowImport(false)}>取消</button><button className="primary-button" onClick={importNode}><Icon name="upload" size={16}/>添加节点</button></div></div></div>}
    {showUsers && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setShowUsers(false)}><div className="modal admin-modal"><div className="modal-head"><div><div className="eyebrow">ROOT CONSOLE</div><h2>用户管理</h2></div><button className="close-button" onClick={() => setShowUsers(false)}>×</button></div><p className="modal-copy">root 可以管理普通用户。密码只在服务器端以加盐哈希保存。</p><div className="stats-strip"><div><strong>{stats.userCount || users.length}</strong><span>总账号</span></div><div><strong>{stats.activeSessions || 0}</strong><span>活跃会话</span></div><div><strong>H2</strong><span>节点协议</span></div></div><div className="user-list">{adminBusy && users.length === 0 ? <div className="admin-loading">正在读取账号…</div> : users.map((user) => <div className="user-row" key={user.username}><div><strong>{user.username}</strong><span>{user.role === 'root' ? '管理员' : '普通用户'}</span></div><div className="user-actions"><em>{user.username === 'root' ? '受保护' : '可管理'}</em>{user.username !== 'root' && <button className="danger-button" onClick={() => deleteUser(user.username)}>删除</button>}</div></div>)}</div><div className="password-editor"><label>修改 user 密码</label><div className="password-row"><input type="password" placeholder="至少 8 位" value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} /><button className="primary-button" onClick={updateUserPassword} disabled={adminBusy}>保存</button></div></div><div className="password-editor create-user"><label>创建普通用户</label><div className="password-row"><input placeholder="账号名" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} /><input type="password" placeholder="初始密码" value={newAccountPassword} onChange={(e) => setNewAccountPassword(e.target.value)} /><button className="primary-button" onClick={createUser} disabled={adminBusy}>创建</button></div></div></div></div>}
    {notice && <div className="toast"><span className="status-pip"></span>{notice}</div>}
  </div>
}

function App() {
  const [account, setAccount] = useState(() => {
    try { return JSON.parse(localStorage.getItem('misakaAccount') || 'null') } catch { return null }
  })
  if (!account) return <LoginScreen onLogin={(next) => { localStorage.setItem('misakaAccount', JSON.stringify(next)); setAccount(next) }} />
  return <Dashboard account={account} onLogout={() => { localStorage.removeItem('misakaAccount'); setAccount(null) }} />
}

function LoginScreen({ onLogin }) {
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem('misakaApiUrl') || DEFAULT_API_URL)
  const [username, setUsername] = useState('user')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      const response = await apiFetch('/api/login', { baseUrl: apiUrl, method: 'POST', body: { username, password } })
      if (!response.ok) throw new Error(response.data?.error || '无法连接到服务器')
      localStorage.setItem('misakaApiUrl', apiUrl.replace(/\/$/, ''))
      onLogin({ ...response.data.user, token: response.data.token, apiUrl: apiUrl.replace(/\/$/, '') })
    } catch (err) { setError(err.message || '登录失败，请检查服务器地址') } finally { setBusy(false) }
  }
  return <div className="login-shell"><div className="login-orbit"></div><div className="login-card"><div className="brand login-brand"><img className="brand-icon" src="./qaletx-link.svg" alt="qaletx link" /><div><div className="brand-name">qaletx link</div><div className="brand-sub">PRIVATE ACCESS</div></div></div><div className="eyebrow">PRIVATE NETWORK / SIGN IN</div><h1>连接你的工作区。</h1><p className="login-copy">登录后即可使用节点。管理员账号还可以管理用户权限。</p><form onSubmit={submit}><label>服务器地址<input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="http://服务器地址:8787" /></label><label>账号<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></label><label>密码<input autoComplete="current-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>{error && <div className="login-error">{error}</div>}<button className="login-button" disabled={busy}>{busy ? <><span className="spinner"></span>正在验证</> : <>进入 qaletx link <Icon name="arrow" size={18}/></>}</button></form><div className="login-foot"><span><span className="status-pip"></span>安全连接</span><span>Windows / macOS</span></div></div></div>
}

async function apiFetch(pathname, { baseUrl, token, method = 'GET', body } = {}) {
  const root = (baseUrl || localStorage.getItem('misakaApiUrl') || DEFAULT_API_URL).replace(/\/$/, '')
  const response = await fetch(`${root}${pathname}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  let data = {}
  try { data = await response.json() } catch {}
  return { ok: response.ok, data }
}

function incrementTime(value) { const [h, m, s] = value.split(':').map(Number); const total = h * 3600 + m * 60 + s + 1; return [Math.floor(total / 3600), Math.floor(total % 3600 / 60), total % 60].map((n) => String(n).padStart(2, '0')).join(':') }

function parseNode(uri) {
  if (!uri) return null
  try {
    const match = uri.match(/^hysteria2:\/\/([^@]+)@([^/:]+)(?::(\d+))?/i)
    if (!match) return null
    const query = new URLSearchParams(uri.split('?')[1]?.split('#')[0] || '')
    return { server: `${match[2]}:${match[3] || '443'}`, sni: query.get('sni') || match[2], auth: decodeURIComponent(match[1]) }
  } catch { return null }
}

createRoot(document.getElementById('root')).render(<App />)



