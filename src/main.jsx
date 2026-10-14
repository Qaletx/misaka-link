import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const DEFAULT_API_URL = import.meta.env.VITE_API_URL || 'http://147.189.161.140:8787'
const PRIVATE_NODE = { id: 'misaka', privateId: 'misaka', name: 'qaletx 主线路', protocol: 'Hysteria2', private: true }
const INITIAL_STATUS = { phase: 'idle', connected: false, startedAt: null, up: null, down: null, systemProxy: false }
const PHASE_NAMES = { idle: '尚未连接', connecting: '正在连接', connected: '连接已建立', disconnecting: '正在断开', error: '连接需要检查' }
const MODE_NAMES = { global: '全局代理', 'bypass-local': '绕过局域网' }
const SUPPORTED_SCHEMES = /^(hysteria2|hy2|tuic|vless|vmess|trojan|ss|socks5?|https?):\/\//i

function Icon({ name, size = 18, ...props }) {
  const paths = {
    power: <><path d="M12 3v9"/><path d="M6.1 5.7a8.5 8.5 0 1 0 11.8 0"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5"/><circle cx="15" cy="17" r="2.5"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 1 1 8 0v3M12 14v3"/></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    chevron: <path d="m9 5 7 7-7 7"/>,
    shield: <><path d="m12 3 8 3v5c0 5-3.4 8.2-8 10-4.6-1.8-8-5-8-10V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c4 5 4 13 0 18-4-5-4-13 0-18Z"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
    users: <><path d="M3 21v-2a6 6 0 0 1 12 0v2M17 13a5 5 0 0 1 5 5v3"/><circle cx="9" cy="7" r="4"/><path d="M17 3a4 4 0 0 1 0 8"/></>,
    log: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/></>,
    refresh: <><path d="M20 4v6h-6M4 20v-6h6"/><path d="M20 10a8 8 0 0 0-14-5M4 14a8 8 0 0 0 14 5"/></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    down: <path d="M12 4v16m-6-6 6 6 6-6"/>,
    up: <path d="M12 20V4m-6 6 6-6 6 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    logout: <><path d="M9 4H4v16h5M9 12h12m-5-5 5 5-5 5"/></>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>
}

function Brand() { return <div className="brand"><img src="./qaletx-link.svg" alt=""/><div><strong>qaletx<span> link</span></strong><small>A LITTLE CLOSER.</small></div></div> }

function Modal({ title, eyebrow, onClose, children, wide = false }) {
  const headingId = useId()
  const dialog = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    const focusable = () => [...element.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')].filter((item) => item.offsetParent !== null)
    const firstInput = element.querySelector('input:not([disabled]), textarea:not([disabled])')
    ;(firstInput || element).focus()
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) { event.preventDefault(); element.focus(); return }
      if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === element)) { event.preventDefault(); items[items.length - 1].focus() }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={headingId} className={`modal ${wide ? 'modal-wide' : ''}`}><div className="modal-head"><div><span className="eyebrow">{eyebrow}</span><h2 id={headingId}>{title}</h2></div><button type="button" className="icon-button" aria-label="关闭对话框" onClick={onClose}><Icon name="close"/></button></div>{children}</section></div>
}

function nodeKey(uri) { return uri.trim().split('#')[0] }
function loadNodes() {
  try {
    const saved = JSON.parse(localStorage.getItem('qaletxNodes') || '[]')
    const seen = new Set()
    const ids = new Set([PRIVATE_NODE.id])
    const nodes = (Array.isArray(saved) ? saved : []).filter((node) => {
      if (!node || node.private || !SUPPORTED_SCHEMES.test(node.uri || '') || seen.has(nodeKey(node.uri))) return false
      seen.add(nodeKey(node.uri)); return true
    }).map((node, index) => {
      let id = typeof node.id === 'string' && !ids.has(node.id) ? node.id : `imported-${index}`
      while (ids.has(id)) id = `${id}-local`
      ids.add(id)
      return { id, name: String(node.name || '我的线路'), uri: node.uri, protocol: node.protocol || protocolName(node.uri) }
    })
    return [PRIVATE_NODE, ...nodes]
  } catch { return [PRIVATE_NODE] }
}

function Dashboard({ account, onLogout }) {
  const [nodes, setNodes] = useState(loadNodes)
  const [selected, setSelected] = useState('misaka')
  const [status, setStatus] = useState(INITIAL_STATUS)
  const [operation, setOperation] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [info, setInfo] = useState({ core: false, platform: 'unknown' })
  const [panel, setPanel] = useState(null)
  const [notice, setNotice] = useState(null)
  const [routeMode, setRouteMode] = useState(() => localStorage.getItem('qaletxRouteMode') === 'bypass-local' ? 'bypass-local' : 'global')
  const [importText, setImportText] = useState('')
  const [importErrors, setImportErrors] = useState([])
  const [importBusy, setImportBusy] = useState(false)
  const [users, setUsers] = useState([])
  const [stats, setStats] = useState({ userCount: 0, activeSessions: 0 })
  const [adminBusy, setAdminBusy] = useState(false)
  const [editor, setEditor] = useState(null)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [logs, setLogs] = useState([])
  const [logError, setLogError] = useState('')
  const [logFilter, setLogFilter] = useState('all')
  const noticeTimer = useRef(null)
  const activeNode = useMemo(() => nodes.find((node) => node.id === selected) || nodes[0], [nodes, selected])
  const connected = Boolean(status.connected)
  const busy = operation || status.phase === 'connecting' || status.phase === 'disconnecting'
  const notify = useCallback((message, type = 'success') => {
    clearTimeout(noticeTimer.current); setNotice({ message, type }); noticeTimer.current = setTimeout(() => setNotice(null), 4600)
  }, [])
  const closePanel = () => { if (!adminBusy && !importBusy) { setPanel(null); setImportErrors([]); setNewPassword(''); setCurrentPassword(''); setConfirmation('') } }

  useEffect(() => {
    try { localStorage.setItem('qaletxNodes', JSON.stringify(nodes.filter((node) => !node.private))) } catch { notify('本机存储已满，新增线路可能无法在重启后保留', 'error') }
  }, [nodes, notify])
  useEffect(() => {
    let active = true
    const receive = (next) => { if (active && next) setStatus({ ...INITIAL_STATUS, ...next }) }
    window.misaka?.getInfo?.().then((data) => active && setInfo(data)).catch(() => notify('无法读取客户端信息', 'error'))
    window.misaka?.getStatus?.().then(receive).catch(() => {})
    const unsubscribe = window.misaka?.onStatus?.(receive)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { active = false; clearInterval(timer); clearTimeout(noticeTimer.current); unsubscribe?.() }
  }, [notify])
  useEffect(() => {
    if (status.nodeId && nodes.some((node) => node.id === status.nodeId) && status.connected) setSelected(status.nodeId)
  }, [status.nodeId, status.connected, nodes])
  useEffect(() => {
    const keydown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i' && !panel) { event.preventDefault(); setPanel('import') }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [panel])

  const request = async (path, options = {}) => {
    const response = await apiFetch(path, { baseUrl: account.apiUrl, token: account.token, ...options })
    if (!response.ok) throw new Error(response.data.error || `请求失败（${response.status}）`)
    return response.data
  }

  async function syncStatus() {
    const next = await window.misaka?.getStatus?.()
    if (next) setStatus({ ...INITIAL_STATUS, ...next })
    return next
  }

  async function toggleConnection() {
    if (busy) return
    if (!window.misaka?.connect) { notify('请在已安装的桌面客户端中连接', 'error'); return }
    setOperation(true)
    try {
      if (connected) {
        const result = await window.misaka.disconnect()
        if (result?.ok === false) throw new Error(result.message || '断开失败，请重试')
        await syncStatus(); notify('已断开，系统代理已恢复')
      } else {
        await request('/api/me')
        const result = await window.misaka.connect({ ...(activeNode.private ? { privateId: activeNode.privateId } : { uri: activeNode.uri }), name: activeNode.name, id: activeNode.id, mode: routeMode })
        if (!result?.ok) throw new Error(result?.message || '连接未能建立，请查看诊断日志')
        await syncStatus(); notify('连接已建立')
      }
    } catch (error) { notify(error.message || '连接操作失败', 'error'); await syncStatus().catch(() => {}) }
    finally { setOperation(false) }
  }

  async function logout() {
    if (busy) return
    setOperation(true)
    try { await onLogout() } catch (error) { notify(error.message || '未能安全断开，请重试', 'error') } finally { setOperation(false) }
  }

  async function importNodes(event) {
    event.preventDefault()
    if (!importText.trim() || importBusy) return
    setImportBusy(true); setImportErrors([])
    try {
      if (!window.misaka?.validateNodes) throw new Error('请在桌面客户端中导入线路')
      const result = await window.misaka.validateNodes(importText)
      const known = new Set(nodes.filter((node) => node.uri).map((node) => nodeKey(node.uri)))
      const additions = []
      let duplicates = 0
      for (const node of result?.nodes || []) {
        if (!node.uri || !SUPPORTED_SCHEMES.test(node.uri)) continue
        const key = nodeKey(node.uri)
        if (known.has(key)) { duplicates++; continue }
        known.add(key)
        additions.push({ id: `node-${Date.now()}-${additions.length}`, name: node.name || '我的线路', uri: node.uri, protocol: node.protocol || protocolName(node.uri) })
      }
      if (additions.length) { setNodes((previous) => [...previous, ...additions]); if (!connected && !busy) setSelected(additions[0].id) }
      const errors = result?.errors || []
      setImportErrors(errors)
      if (!additions.length && !duplicates && !errors.length) setImportErrors(['没有识别到有效的分享链接，请检查后重试。'])
      if (additions.length || duplicates) notify(`已添加 ${additions.length} 条线路${duplicates ? `，跳过 ${duplicates} 条重复线路` : ''}`)
      if (errors.length === 0 && (additions.length || duplicates)) { setImportText(''); setPanel('nodes') }
    } catch (error) { setImportErrors([error.message || '导入失败']) } finally { setImportBusy(false) }
  }

  async function copyNode(node) {
    if (node.private || !node.uri) return
    try { await navigator.clipboard.writeText(node.uri); notify('分享链接已复制') } catch { notify('无法访问剪贴板，请重试', 'error') }
  }

  function chooseNode(node) {
    if (busy || connected) { notify('请先断开连接，再切换线路', 'error'); return }
    setSelected(node.id)
  }

  async function refreshUsers() {
    const [userData, statsData] = await Promise.all([request('/api/users'), request('/api/stats')])
    setUsers(userData.users || []); setStats(statsData)
  }
  async function openUsers() {
    setPanel('users'); setAdminBusy(true)
    try { await refreshUsers() } catch (error) { notify(error.message, 'error') } finally { setAdminBusy(false) }
  }
  async function createUser(event) {
    event.preventDefault(); if (adminBusy) return
    setAdminBusy(true)
    try {
      await request('/api/users', { method: 'POST', body: { username: newUsername.trim(), password: newPassword } })
      setNewUsername(''); setNewPassword(''); await refreshUsers(); setPanel('users'); notify('新账号已创建')
    } catch (error) { notify(error.message, 'error') } finally { setAdminBusy(false) }
  }
  async function toggleUser(user) {
    setAdminBusy(true)
    try { await request(`/api/users/${encodeURIComponent(user.username)}`, { method: 'PATCH', body: { disabled: !user.disabled } }); await refreshUsers(); notify(user.disabled ? '账号已启用' : '账号已停用') }
    catch (error) { notify(error.message, 'error') } finally { setAdminBusy(false) }
  }
  async function saveUser(event) {
    event.preventDefault(); if (adminBusy) return
    setAdminBusy(true)
    try {
      await request(`/api/users/${encodeURIComponent(editor.username)}`, { method: 'PATCH', body: { disabled: editor.disabled, expiresAt: editor.expiresAt ? new Date(`${editor.expiresAt}T23:59:59`).toISOString() : null } })
      if (newPassword) await request(`/api/users/${encodeURIComponent(editor.username)}/password`, { method: 'PATCH', body: { password: newPassword } })
      await refreshUsers(); setNewPassword(''); setPanel('users'); notify('账号设置已保存')
    } catch (error) { notify(error.message, 'error') } finally { setAdminBusy(false) }
  }
  async function confirmDelete() {
    if (deleteTarget?.kind === 'node') {
      if (connected || busy) { notify('请先断开连接', 'error'); return }
      setNodes((previous) => previous.filter((node) => node.id !== deleteTarget.node.id))
      if (selected === deleteTarget.node.id) setSelected(PRIVATE_NODE.id)
      setPanel('nodes'); setDeleteTarget(null); notify('本机线路已移除'); return
    }
    setAdminBusy(true)
    try { await request(`/api/users/${encodeURIComponent(deleteTarget.username)}`, { method: 'DELETE' }); await refreshUsers(); setPanel('users'); setDeleteTarget(null); notify('账号已删除') }
    catch (error) { notify(error.message, 'error') } finally { setAdminBusy(false) }
  }
  async function changeOwnPassword(event) {
    event.preventDefault(); if (adminBusy) return
    if (newPassword !== confirmation) { notify('两次输入的新密码不一致', 'error'); return }
    setAdminBusy(true)
    try {
      await request('/api/me/password', { method: 'POST', body: { currentPassword, password: newPassword } })
      await onLogout();
    } catch (error) { notify(error.message, 'error') } finally { setAdminBusy(false) }
  }

  const refreshLogs = useCallback(async () => {
    try { if (!window.misaka?.getLogs) throw new Error('诊断日志仅在桌面客户端中可用'); const data = await window.misaka.getLogs(); setLogs(Array.isArray(data) ? data : []); setLogError('') }
    catch (error) { setLogError(error.message || '读取日志失败') }
  }, [])
  useEffect(() => {
    if (panel !== 'logs') return
    refreshLogs(); const timer = setInterval(refreshLogs, 2000)
    return () => clearInterval(timer)
  }, [panel, refreshLogs])
  const shownLogs = logs.filter((entry) => logFilter === 'all' || /error|warn/i.test(entry.level || ''))
  const sessionTime = formatDuration(status.startedAt, now)
  const nodeAvailable = !activeNode.private || info.privateNode !== false
  const currentMode = connected ? status.mode || routeMode : routeMode

  function nodeRow(node, tools = false) {
    const checked = selected === node.id
    return <div className={`node-row ${checked ? 'selected' : ''}`} key={node.id}><button className="node-select" aria-pressed={checked} onClick={() => chooseNode(node)} disabled={busy}><span className={`node-symbol ${node.private ? 'managed' : ''}`}><Icon name={node.private ? 'shield' : 'globe'} size={19}/></span><span className="node-main"><strong>{node.name}</strong><small>{node.protocol} <span>·</span> {node.private ? '内置托管线路' : '个人导入线路'}</small></span><span className="node-tag">{node.private ? <><Icon name="lock" size={11}/>私有</> : '本机'}</span><span className={`radio ${checked ? 'checked' : ''}`}>{checked && <Icon name="check" size={10}/>}</span></button>{tools && !node.private && <div className="node-actions"><button className="icon-button" aria-label={`复制 ${node.name} 的分享链接`} onClick={() => copyNode(node)}><Icon name="copy" size={15}/></button><button className="icon-button danger" aria-label={`删除 ${node.name}`} disabled={connected || busy} onClick={() => { setDeleteTarget({ kind: 'node', node }); setPanel('delete') }}><Icon name="trash" size={15}/></button></div>}</div>
  }

  return <div className="app-shell">
    <aside className="sidebar"><Brand/><span className="side-caption">你的工作区</span><nav className="nav-list" aria-label="主导航"><button className={`nav-item ${!panel ? 'active' : ''}`} onClick={() => setPanel(null)}><Icon name="power"/><span>连接中心</span><i/></button><button className={`nav-item ${panel === 'nodes' || panel === 'import' ? 'active' : ''}`} onClick={() => setPanel('nodes')}><Icon name="globe"/><span>我的线路</span><small>{nodes.length}</small></button><button className={`nav-item ${panel === 'settings' ? 'active' : ''}`} onClick={() => setPanel('settings')}><Icon name="settings"/><span>偏好设置</span></button><button className={`nav-item ${panel === 'logs' ? 'active' : ''}`} onClick={() => setPanel('logs')}><Icon name="log"/><span>诊断日志</span></button>{account.role === 'root' && <><span className="side-caption admin-caption">管理工作区</span><button className={`nav-item ${panel === 'users' ? 'active' : ''}`} onClick={openUsers}><Icon name="users"/><span>用户管理</span><small>ROOT</small></button></>}</nav><div className="sidebar-bottom"><div className="version-card"><span className={`status-dot ${info.core ? 'green' : ''}`}/><div><strong>{info.core ? '代理核心就绪' : '等待核心'}</strong><small>{info.version ? `v${info.version}` : 'qaletx link'} · {info.platform === 'darwin' ? 'macOS' : info.platform === 'win32' ? 'Windows' : '桌面客户端'}</small></div></div><button className="sidebar-account" onClick={() => setPanel('account')}><span className="avatar">{account.username?.slice(0, 1).toUpperCase()}</span><span><strong>{account.username}</strong><small>{account.role === 'root' ? '管理员账号' : '个人账号'}</small></span><Icon name="chevron" size={14}/></button></div></aside>
    <main className="main-panel"><header className="topbar"><div><span className="eyebrow">A QUIETER WAY TO CONNECT</span><h1>连接，简单一点<span>。</span></h1></div><div className="topbar-right"><span className="status-chip"><i className={`status-dot ${connected ? 'green' : ''}`}/>{PHASE_NAMES[status.phase] || '尚未连接'}</span><button className="icon-button" aria-label="偏好设置" onClick={() => setPanel('settings')}><Icon name="settings"/></button></div></header>
      <div className="dashboard-grid"><section className={`connection-card ${connected ? 'is-connected' : ''} ${busy ? 'is-working' : ''}`} aria-label="连接控制"><div className="connection-art" aria-hidden="true"><i/><i/><i/><b/></div><div className="connection-copy"><span className="connection-label"><i/>{connected ? 'CONNECTED' : busy ? 'CONNECTING' : 'READY WHEN YOU ARE'}</span><h2>{connected ? <>世界，近在眼前。</> : <>你的世界，<br/>一键连通。</>}</h2><p>{status.phase === 'error' ? '连接遇到了问题，可以重试或查看诊断。' : connected ? '系统代理已接管，安心继续你的工作。' : '已为你选好线路，点击连接即可开始。'}</p><button className={`connect-button ${connected ? 'disconnect' : ''}`} disabled={busy || !nodeAvailable} onClick={toggleConnection}>{busy ? <span className="spinner"/> : <Icon name="power" size={17}/>}<span>{status.phase === 'disconnecting' ? '正在断开' : busy ? '正在连接' : connected ? '断开连接' : '一键连接'}</span><Icon name="arrow" size={17}/></button></div><div className="connection-footer"><span><Icon name="globe" size={13}/>{MODE_NAMES[currentMode]}</span><span>{activeNode.protocol}</span></div></section>
      <section className="session-panel" aria-label="本次连接状态"><div className="panel-caption"><span className="eyebrow">THIS SESSION</span><Icon name="clock" size={16}/></div><div className="session-clock"><strong>{sessionTime}</strong><span>{connected ? '本次连接时长' : '连接后开始计时'}</span></div><div className="traffic-grid"><div><span><Icon name="down" size={13}/>下载</span><strong>{formatBytes(status.down)}</strong></div><div><span><Icon name="up" size={13}/>上传</span><strong>{formatBytes(status.up)}</strong></div></div><div className="proxy-status"><span className={`status-dot ${status.systemProxy ? 'green' : ''}`}/>{status.systemProxy ? '系统代理已开启' : '系统代理未接管'}<button aria-label="查看连接诊断" onClick={() => setPanel('logs')}><Icon name="chevron" size={13}/></button></div></section>
      <section className="nodes-panel"><div className="section-head"><div><span className="eyebrow">YOUR CONNECTIONS</span><h2>可用线路 <span>{nodes.length}</span></h2></div><button className="text-button" onClick={() => setPanel('nodes')}>管理线路<Icon name="chevron" size={14}/></button></div><div className="nodes-preview">{nodeRow(activeNode)}</div><div className="nodes-bottom"><span><Icon name="lock" size={12}/>{activeNode.private ? '内置线路由 qaletx 托管，不提供分享导出。' : '你的个人线路，仅保存在这台设备。'}</span><button className="text-button" onClick={() => setPanel('nodes')}>切换线路<Icon name="refresh" size={13}/></button></div></section>
      {(status.error || !nodeAvailable) && <div className="inline-error" role="status"><span>{!nodeAvailable ? '内置线路尚未配置，请联系管理员。' : status.error}</span><button className="text-button" onClick={() => setPanel('logs')}>查看诊断</button></div>}
      </div><footer className="footer"><span>qaletx link <i/> 给连接留一点简单</span><button onClick={() => setPanel('logs')}><Icon name="log" size={12}/>连接诊断</button></footer>
    </main>

    {panel === 'nodes' && <Modal title="我的线路" eyebrow="YOUR CONNECTIONS" onClose={closePanel} wide><p className="modal-copy">选择一条线路，回到首页一键连接。个人线路可以导入、复制与移除。</p><div className="modal-node-list">{nodes.map((node) => nodeRow(node, true))}</div><div className="modal-actions"><span className="quiet-text">共 {nodes.length} 条 · 包含 1 条托管线路</span><button className="primary-button" onClick={() => { setImportErrors([]); setPanel('import') }}><Icon name="plus" size={15}/>导入线路</button></div></Modal>}
    {panel === 'import' && <Modal title="把你的线路带进来" eyebrow="ADD CONNECTIONS" onClose={closePanel}><p className="modal-copy">支持 Hysteria2、TUIC、VLESS、VMess、Trojan、Shadowsocks、SOCKS 和 HTTP 分享链接。每行一条，重复线路会自动跳过。</p><form onSubmit={importNodes}><label className="field-label">分享链接<textarea required value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴一条或多条分享链接" rows={6} spellCheck={false}/></label>{importErrors.length > 0 && <div className="form-error" role="alert">{importErrors.map((error, index) => <p key={index}>{error}</p>)}</div>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={importBusy} onClick={() => setPanel('nodes')}>返回线路</button><button className="primary-button" disabled={importBusy || !importText.trim()}>{importBusy ? <span className="spinner"/> : <Icon name="plus" size={15}/>}验证并导入</button></div></form></Modal>}
    {panel === 'settings' && <Modal title="按你的习惯连接" eyebrow="PREFERENCES" onClose={closePanel}><div className="settings-section"><h3>代理范围</h3><p>更改在下次连接时生效。</p><div className="mode-options">{Object.entries(MODE_NAMES).map(([value, label]) => <button key={value} className={`mode-option ${routeMode === value ? 'selected' : ''}`} aria-pressed={routeMode === value} onClick={() => { setRouteMode(value); localStorage.setItem('qaletxRouteMode', value) }}><Icon name={value === 'global' ? 'globe' : 'shield'} size={21}/><strong>{label}</strong><span>{value === 'global' ? '通过代理访问所有目标' : '本机和局域网地址直接访问'}</span>{routeMode === value && <i><Icon name="check" size={12}/></i>}</button>)}</div></div><div className="settings-section"><h3>关闭窗口与退出</h3><div className="setting-row"><strong>关闭窗口</strong><span>收起到系统托盘，保持当前连接</span></div><div className="setting-row"><strong>彻底退出</strong><span>从托盘退出时断开连接并恢复系统代理</span></div><div className="setting-row"><strong>系统代理</strong><span>连接成功后接管，断开后恢复原设置</span></div></div><div className="modal-actions"><button className="secondary-button" onClick={() => setPanel('logs')}><Icon name="log" size={14}/>连接诊断</button><button className="primary-button" onClick={closePanel}>完成</button></div></Modal>}
    {panel === 'logs' && <Modal title="连接诊断" eyebrow="CONNECTION DIAGNOSTICS" onClose={closePanel} wide><div className="diagnostic-summary"><div><span>代理核心</span><strong>{info.core ? info.coreName || '已就绪' : '未检测到'}</strong></div><div><span>连接状态</span><strong>{PHASE_NAMES[status.phase] || '未知'}</strong></div><div><span>系统代理</span><strong>{status.systemProxy ? '已接管' : '未接管'}</strong></div></div><div className="log-toolbar"><label>显示<select value={logFilter} onChange={(event) => setLogFilter(event.target.value)}><option value="all">全部日志</option><option value="issues">警告与错误</option></select></label><button className="text-button" onClick={refreshLogs}><Icon name="refresh" size={14}/>刷新</button></div>{logError && <p className="form-error" role="alert">{logError}</p>}<div className="log-list" tabIndex={0} aria-label="诊断日志">{shownLogs.length ? shownLogs.map((entry, index) => <div className={`log-entry ${entry.level}`} key={`${entry.time}-${index}`}><time>{formatLogTime(entry.time)}</time><em>{entry.level || 'info'}</em><span>{entry.message}</span></div>) : <div className="empty-state"><Icon name="log" size={28}/><strong>{logFilter === 'issues' ? '暂无警告或错误' : '暂无连接日志'}</strong><p>连接操作产生的诊断信息会显示在这里。</p></div>}</div><div className="modal-actions"><span className="quiet-text">每 2 秒更新 · 敏感信息已脱敏</span><button className="secondary-button" disabled={!shownLogs.length} onClick={async () => { try { await navigator.clipboard.writeText(shownLogs.map((entry) => `${entry.time} [${entry.level}] ${entry.message}`).join('\n')); notify('诊断日志已复制') } catch { notify('复制失败，请重试', 'error') } }}><Icon name="copy" size={14}/>复制日志</button></div></Modal>}
    {panel === 'account' && <Modal title="我的账号" eyebrow="YOUR ACCOUNT" onClose={closePanel}><div className="account-summary"><span className="avatar large">{account.username?.slice(0, 1).toUpperCase()}</span><div><strong>{account.username}</strong><span>{account.role === 'root' ? '管理员' : '普通用户'} · {account.expiresAt ? `有效期至 ${new Date(account.expiresAt).toLocaleDateString()}` : '长期有效'}</span></div></div><form onSubmit={changeOwnPassword} className="stack-form"><h3>修改登录密码</h3><label className="field-label">当前密码<input required type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)}/></label><div className="form-columns"><label className="field-label">新密码<input required minLength={8} type="password" autoComplete="new-password" placeholder="至少 8 位" value={newPassword} onChange={(event) => setNewPassword(event.target.value)}/></label><label className="field-label">确认新密码<input required minLength={8} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}/></label></div><p className="quiet-text">密码修改成功后需要重新登录。</p><div className="modal-actions"><button type="button" className="text-button danger" disabled={busy || adminBusy} onClick={logout}><Icon name="logout" size={14}/>{operation ? '正在断开' : '退出登录'}</button><button className="primary-button" disabled={adminBusy}>{adminBusy ? '正在保存' : '修改密码'}</button></div></form></Modal>}
    {panel === 'users' && account.role === 'root' && <Modal title="管理你的用户" eyebrow="ROOT WORKSPACE" onClose={closePanel} wide><div className="admin-stats"><div><strong>{stats.userCount ?? users.length}</strong><span>全部账号</span></div><div><strong>{users.filter((user) => !user.disabled).length}</strong><span>已启用</span></div><div><strong>{stats.activeSessions ?? '—'}</strong><span>登录会话</span></div></div><div className="user-toolbar"><span className="quiet-text">管理密码、有效期和账号状态</span><button className="text-button" disabled={adminBusy} onClick={openUsers}><Icon name="refresh" size={14}/>刷新</button></div><div className="user-list">{adminBusy && !users.length ? <p className="empty-message">正在读取用户…</p> : users.map((user) => <div className="user-row" key={user.username}><span className="user-avatar">{user.username.slice(0, 1).toUpperCase()}</span><div className="user-info"><strong>{user.username}<em className={user.disabled ? 'badge-disabled' : ''}>{user.role === 'root' ? '管理员' : user.disabled ? '已停用' : user.expiresAt && Date.parse(user.expiresAt) < now ? '已过期' : '使用中'}</em></strong><span>{user.expiresAt ? `到期 ${new Date(user.expiresAt).toLocaleDateString()}` : '长期有效'}</span></div>{user.role !== 'root' && <div className="user-actions"><button className="text-button" disabled={adminBusy} onClick={() => { setEditor({ ...user, expiresAt: user.expiresAt ? new Date(user.expiresAt).toISOString().slice(0, 10) : '' }); setNewPassword(''); setPanel('user-edit') }}>编辑</button><button className="text-button" disabled={adminBusy} onClick={() => toggleUser(user)}>{user.disabled ? '启用' : '停用'}</button><button className="icon-button danger" disabled={adminBusy} aria-label={`删除用户 ${user.username}`} onClick={() => { setDeleteTarget({ kind: 'user', username: user.username }); setPanel('delete') }}><Icon name="trash" size={14}/></button></div>}</div>)}</div><div className="modal-actions"><span className="quiet-text">管理员账号受保护</span><button className="primary-button" disabled={adminBusy} onClick={() => { setNewUsername(''); setNewPassword(''); setPanel('create-user') }}><Icon name="plus" size={14}/>创建账号</button></div></Modal>}
    {panel === 'create-user' && account.role === 'root' && <Modal title="创建一个新账号" eyebrow="NEW ACCOUNT" onClose={() => !adminBusy && setPanel('users')}><form onSubmit={createUser} className="stack-form"><label className="field-label">账号名称<input autoComplete="off" required value={newUsername} onChange={(event) => setNewUsername(event.target.value)} placeholder="例如：customer01"/></label><label className="field-label">初始密码<input autoComplete="new-password" required minLength={8} type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 8 位"/></label><p className="quiet-text">新账号默认启用、长期有效，之后可在编辑中调整。</p><div className="modal-actions"><button type="button" className="secondary-button" disabled={adminBusy} onClick={() => setPanel('users')}>取消</button><button className="primary-button" disabled={adminBusy}>{adminBusy ? '正在创建' : '创建账号'}</button></div></form></Modal>}
    {panel === 'user-edit' && editor && account.role === 'root' && <Modal title={`编辑 ${editor.username}`} eyebrow="ACCOUNT SETTINGS" onClose={() => !adminBusy && setPanel('users')}><form onSubmit={saveUser} className="stack-form"><label className="field-label">账号状态<select value={editor.disabled ? 'disabled' : 'enabled'} onChange={(event) => setEditor({ ...editor, disabled: event.target.value === 'disabled' })}><option value="enabled">启用</option><option value="disabled">停用</option></select></label><label className="field-label">有效期至<input type="date" value={editor.expiresAt} onChange={(event) => setEditor({ ...editor, expiresAt: event.target.value })}/><small>留空表示长期有效；选择的日期截至当地时间 23:59。</small></label><label className="field-label">重置密码<input minLength={8} type="password" autoComplete="new-password" placeholder="留空保留原密码" value={newPassword} onChange={(event) => setNewPassword(event.target.value)}/><small>设置新密码后，用户需要重新登录。</small></label><div className="modal-actions"><button type="button" className="secondary-button" disabled={adminBusy} onClick={() => setPanel('users')}>取消</button><button className="primary-button" disabled={adminBusy}>{adminBusy ? '正在保存' : '保存更改'}</button></div></form></Modal>}
    {panel === 'delete' && deleteTarget && <Modal title={deleteTarget.kind === 'node' ? '移除这条线路？' : '删除这个账号？'} eyebrow="PLEASE CONFIRM" onClose={() => !adminBusy && setPanel(deleteTarget.kind === 'node' ? 'nodes' : 'users')}><p className="modal-copy">{deleteTarget.kind === 'node' ? `“${deleteTarget.node.name}”将从本机线路列表移除。` : `删除“${deleteTarget.username}”后，该用户将无法继续登录。这项操作无法撤销。`}</p><div className="modal-actions"><button className="secondary-button" disabled={adminBusy} onClick={() => setPanel(deleteTarget.kind === 'node' ? 'nodes' : 'users')}>取消</button><button className="primary-button danger-solid" disabled={adminBusy} onClick={confirmDelete}>{adminBusy ? '正在删除' : '确认删除'}</button></div></Modal>}
    {notice && <div role={notice.type === 'error' ? 'alert' : 'status'} className={`toast ${notice.type}`}><Icon name={notice.type === 'error' ? 'log' : 'check'} size={16}/>{notice.message}<button aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={13}/></button></div>}
  </div>
}

function App() {
  const [account, setAccount] = useState(() => { try { const saved = JSON.parse(localStorage.getItem('misakaAccount') || 'null'); return saved?.token && typeof saved.username === 'string' ? saved : null } catch { return null } })
  const [message, setMessage] = useState('')
  const accountRef = useRef(account)
  const logoutPromise = useRef(null)
  accountRef.current = account
  const logout = useCallback((forced = false) => {
    if (logoutPromise.current) return logoutPromise.current
    logoutPromise.current = (async () => {
      const previous = accountRef.current
      try { const result = await window.misaka?.disconnect?.(); if (result?.ok === false) throw new Error(result.message || '断开失败，请重试') }
      catch (error) { if (!forced) throw error }
      if (previous?.token && !forced) apiFetch('/api/logout', { baseUrl: previous.apiUrl, method: 'POST', token: previous.token }).catch(() => {})
      localStorage.removeItem('misakaAccount'); setAccount(null); setMessage(forced ? '登录已失效，请重新登录。' : '')
    })().finally(() => { logoutPromise.current = null })
    return logoutPromise.current
  }, [])
  useEffect(() => {
    if (!account?.token) return
    const expired = (event) => { if (event.detail?.token === accountRef.current?.token) logout(true).catch(() => {}) }
    const verify = async () => {
      try { const response = await apiFetch('/api/me', { baseUrl: account.apiUrl, token: account.token }); if (response.ok && response.data.user && accountRef.current?.token === account.token) { setAccount((current) => { if (!current) return current; const next = { ...current, ...response.data.user }; localStorage.setItem('misakaAccount', JSON.stringify(next)); return next }) } } catch {}
    }
    window.addEventListener('qaletx-session-expired', expired); verify()
    const timer = setInterval(verify, 60000)
    return () => { window.removeEventListener('qaletx-session-expired', expired); clearInterval(timer) }
  }, [account?.token, account?.apiUrl, logout])
  if (!account) return <LoginScreen message={message} onLogin={(next) => { localStorage.setItem('misakaAccount', JSON.stringify(next)); setMessage(''); setAccount(next) }}/>
  return <Dashboard account={account} onLogout={() => logout(false)}/>
}

function LoginScreen({ onLogin, message }) {
  const [username, setUsername] = useState('user')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault(); if (busy) return
    setError(''); setBusy(true)
    try {
      const response = await apiFetch('/api/login', { baseUrl: DEFAULT_API_URL, method: 'POST', body: { username: username.trim(), password } })
      if (!response.ok) throw new Error(response.data.error || '登录失败，请检查账号和密码')
      if (!response.data.token || !response.data.user) throw new Error('服务器返回的登录信息不完整')
      localStorage.setItem('misakaApiUrl', DEFAULT_API_URL); onLogin({ ...response.data.user, token: response.data.token, apiUrl: DEFAULT_API_URL })
    } catch (issue) { setError(issue.message || '暂时无法登录，请稍后重试') } finally { setBusy(false) }
  }
  return <main className="login-shell"><div className="login-art" aria-hidden="true"><i/><i/><i/></div><section className="login-card"><Brand/><span className="eyebrow">WELCOME TO YOUR SPACE</span><h1>世界很大。<br/>连接很简单<span>。</span></h1><p className="login-copy">登录你的账号，让距离近一点。</p><form onSubmit={submit}><label className="field-label">账号<input required autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="输入账号"/></label><label className="field-label">密码<span className="password-input"><input required autoComplete="current-password" type={visible ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码"/><button type="button" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} onClick={() => setVisible(!visible)}><Icon name="eye" size={17}/></button></span></label>{(error || message) && <div className="form-error" role="alert">{error || message}</div>}<button className="login-button" disabled={busy}><span>{busy ? '正在登录' : '登录并开始'}</span>{busy ? <span className="spinner"/> : <Icon name="arrow" size={18}/>}</button></form><div className="login-foot"><span><Icon name="lock" size={12}/>你的专属连接空间</span><small>qaletx link</small></div></section></main>
}

async function apiFetch(pathname, { baseUrl, token, method = 'GET', body } = {}) {
  const root = (baseUrl || DEFAULT_API_URL).replace(/\/$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(`${root}${pathname}`, { method, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = {}
    try { data = await response.json() } catch { if (controller.signal.aborted) throw new Error('请求超时，请检查网络后重试') }
    if (response.status === 401 && token) window.dispatchEvent(new CustomEvent('qaletx-session-expired', { detail: { token } }))
    return { ok: response.ok, status: response.status, data }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('请求超时，请检查网络后重试')
    throw new Error('无法连接账号服务，请检查网络或联系管理员')
  } finally { clearTimeout(timer) }
}

function protocolName(uri) { const scheme = (uri?.split(':')[0] || '').toLowerCase(); return ({ hy2: 'Hysteria2', hysteria2: 'Hysteria2', vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', ss: 'Shadowsocks', tuic: 'TUIC', socks5: 'SOCKS5', socks: 'SOCKS', http: 'HTTP', https: 'HTTPS' })[scheme] || '代理' }
function formatBytes(bytes) { if (!Number.isFinite(bytes) || bytes < 0) return '—'; const unit = bytes < 1024 ? 0 : Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4); return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}` }
function formatDuration(startedAt, now) { if (!startedAt) return '00:00:00'; const start = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt); const seconds = Math.max(0, Math.floor((now - start) / 1000)) || 0; return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map((value) => String(value).padStart(2, '0')).join(':') }
function formatLogTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour12: false }) }

createRoot(document.getElementById('root')).render(<App />)
