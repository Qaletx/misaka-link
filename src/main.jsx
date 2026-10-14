import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import WorkspaceExtras,{UsageStrip} from './workspace-extras.jsx'

const DEFAULT_API_URL = import.meta.env.VITE_API_URL || 'http://147.189.161.140:8787'
const ROLE_NAMES = { admin: '管理员', user: '普通用户', shared: '共用用户', root: '超级管理员' }
const INITIAL_STATUS = { phase: 'idle', connected: false, startedAt: null, up: null, down: null, systemProxy: false, port: 10808 }
const PHASE_NAMES = { idle: '尚未连接', connecting: '正在连接', connected: '连接已建立', disconnecting: '正在断开', error: '连接需要检查' }
const MODE_NAMES = { global: '代理请求走线路', 'bypass-local': '绕过局域网' }
const SUPPORTED_SCHEMES = /^(hysteria2|hy2|tuic|vless|vmess|trojan|ss|socks5?|https?):\/\//i

function Icon({ name, size = 18, ...props }) {
  const paths = {
    power: <><path d="M12 3v9"/><path d="M6.1 5.7a8.5 8.5 0 1 0 11.8 0"/></>,
    edit: <><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6Z"/></>,
    pulse: <><path d="M2 12h5l3-8 4 16 3-8h5"/></>,
    cloud: <path d="M7 19a5 5 0 0 1-1-10 6 6 0 0 1 12-1 5.5 5.5 0 0 1 0 11H7Z"/>,
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
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={headingId} className={`modal ${wide ? 'modal-wide' : ''}`}><div className="modal-head"><div><span className="eyebrow">{eyebrow}</span><h2 id={headingId}>{title}</h2></div><button type="button" className="icon-button" aria-label="关闭对话框" onClick={onClose}><Icon name="close"/></button></div><div className="modal-body">{children}</div></section></div>
}

function nodeKey(uri) { return uri.trim().split('#')[0] }
function readLocal(key, fallback = []) { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback } }
function accountStorage(account, suffix) { return `qaletx:v05:${encodeURIComponent(account.apiUrl)}:${encodeURIComponent(account.username)}:${suffix}` }
function legacyNodes() { const saved = readLocal('qaletxNodes'); return Array.isArray(saved) ? saved.filter((node) => !node.private && SUPPORTED_SCHEMES.test(node.uri || '')) : [] }
function roleName(user) { return user.isRoot || user.role === 'root' ? '超级管理员' : ROLE_NAMES[user.role] || '普通用户' }
function scopedNodes(key) { const values = readLocal(key); return Array.isArray(values) ? values.filter((node) => !node.private && SUPPORTED_SCHEMES.test(node.uri || '')).map((node) => ({ ...node, local: true })) : [] }

function Dashboard({ account, onLogout }) {
  const root = Boolean(account.isRoot)
  const shared = account.role === 'shared'
  const canManage = Boolean(account.permissions?.manageUsers)
  const storageKey = accountStorage(account, 'nodes')
  const notesKey = accountStorage(account, 'annotations')
  const [cloudNodes, setCloudNodes] = useState([])
  const [localNodes, setLocalNodes] = useState(() => shared ? scopedNodes(storageKey) : [])
  const [localNotes, setLocalNotes] = useState(() => shared ? readLocal(notesKey, {}) : {})
  const nodes = useMemo(() => [...cloudNodes.map((node) => shared && node.private ? { ...node, ...localNotes[node.id] } : node), ...(shared ? localNodes : [])], [cloudNodes, shared, localNodes, localNotes])
  const [selected, setSelected] = useState('')
  const [pendingSelected, setPendingSelected] = useState('')
  const [status, setStatus] = useState(INITIAL_STATUS)
  const [portDraft, setPortDraft] = useState('10808')
  const [portSaving, setPortSaving] = useState(false)
  const [operation, setOperation] = useState(false)
  const [cancelling, setCancelling] = useState(false)
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
  const [newRole, setNewRole] = useState('user')
  const [currentPassword, setCurrentPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [nodeEditor, setNodeEditor] = useState(null)
  const [nodeBusy, setNodeBusy] = useState(false)
  const [nodeError, setNodeError] = useState('')
  const [syncState, setSyncState] = useState({ loading: true, error: '', at: null })
  const [tests, setTests] = useState({})
  const [assignment, setAssignment] = useState(null)
  const [assignChecks, setAssignChecks] = useState({})
  const [logs, setLogs] = useState([])
  const [logError, setLogError] = useState('')
  const [logFilter, setLogFilter] = useState('all')
  const [monthlyUsage,setMonthlyUsage]=useState(null)
  const [quotaUser,setQuotaUser]=useState(null)
  const [meterNode,setMeterNode]=useState(null)
  const panelRef = useRef(panel)
  const refreshId = useRef(0)
  const mutation = useRef(false)
  const testsInFlight = useRef(new Set())
  const connectAttempt = useRef(0)
  const noticeTimer = useRef(null)
  panelRef.current = panel
  const activeNode = useMemo(() => nodes.find((node) => node.id === selected) || nodes[0], [nodes, selected])
  const privateNodes = cloudNodes.filter((node) => node.private)
  const connected = Boolean(status.connected)
  const busy = operation || status.phase === 'connecting' || status.phase === 'disconnecting'
  const canCancel = !connected && busy && !cancelling && status.phase !== 'disconnecting'
  const notify = useCallback((message, type = 'success') => {
    clearTimeout(noticeTimer.current); setNotice({ message, type }); noticeTimer.current = setTimeout(() => setNotice(null), 5200)
  }, [])
  const closePanel = () => { if (!adminBusy && !importBusy && !nodeBusy) { setPanel(null); setImportErrors([]); setNodeError(''); setNewPassword(''); setCurrentPassword(''); setConfirmation('') } }
  useEffect(() => { if (panel === 'settings') setPortDraft(String(status.port || 10808)) }, [panel, status.port])
  const request = useCallback(async (path, options = {}) => {
    const response = await apiFetch(path, { baseUrl: account.apiUrl, token: account.token, ...options })
    if (!response.ok) { const error = new Error(response.data.error || `请求失败（${response.status}）`); error.status = response.status; throw error }
    return response.data
  }, [account.apiUrl, account.token])
  const refreshNodes = useCallback(async () => {
    const id = ++refreshId.current
    setSyncState((state) => ({ ...state, loading: true }))
    try {
      const data = await request('/api/nodes')
      if (refreshId.current !== id) return
      setCloudNodes(Array.isArray(data.nodes) ? data.nodes.map((node) => ({ ...node, local: false })) : [])
      setSyncState({ loading: false, error: '', at: Date.now() })
    } catch (error) { if (refreshId.current === id) setSyncState((state) => ({ ...state, loading: false, error: error.message })); throw error }
  }, [request])
  useEffect(() => {
    refreshNodes().catch(() => {})
    const timer = setInterval(() => { if (!mutation.current && !['node-edit', 'private-create', 'assign', 'import', 'user-edit'].includes(panelRef.current)) refreshNodes().catch(() => {}) }, 30000)
    return () => { clearInterval(timer); refreshId.current++ }
  }, [refreshNodes])
  useEffect(() => {
    let active = true
    const receive = (next) => { if (active && next) setStatus({ ...INITIAL_STATUS, ...next }) }
    window.misaka?.getInfo?.().then((data) => active && setInfo(data)).catch(() => notify('无法读取客户端信息', 'error'))
    window.misaka?.getStatus?.().then(receive).catch(() => {})
    const unsubscribe = window.misaka?.onStatus?.(receive)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { active = false; clearInterval(timer); clearTimeout(noticeTimer.current); unsubscribe?.() }
  }, [notify])
  useEffect(() => { if (status.nodeId && status.connected) setSelected(status.nodeId) }, [status.nodeId, status.connected])
  useEffect(()=>{
    const selection=window.misaka?.onSelection?.(id=>setSelected(id))
    const diagnostics=window.misaka?.onDiagnostics?.(()=>setPanel('logs'))
    window.misaka?.getPreferences?.().then(value=>{const id=value.selection?.nodeId||value.selection?.id;if(id)setSelected(id)}).catch(()=>{})
    return()=>{selection?.();diagnostics?.()}
  },[])
  useEffect(()=>{
    window.misaka?.setCatalog?.(nodes.map(node=>({id:node.id,name:node.name,local:node.local,...(node.local?{uri:node.uri}:{})}))).catch(()=>{})
    if(activeNode&&!connected&&!busy)window.misaka?.setSelection?.({...coreNode(activeNode),mode:routeMode}).catch(()=>{})
  },[nodes,activeNode,routeMode,connected,busy])
  useEffect(() => {
    const keydown = (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i' && !panel) { event.preventDefault(); setPanel('import') } }
    document.addEventListener('keydown', keydown); return () => document.removeEventListener('keydown', keydown)
  }, [panel])

  function saveLocal(next) { localStorage.setItem(storageKey, JSON.stringify(next)); setLocalNodes(next) }
  function mergeNode(node) { setCloudNodes((previous) => previous.some((item) => item.id === node.id) ? previous.map((item) => item.id === node.id ? { ...node, local: false } : item) : [...previous, { ...node, local: false }]); setSyncState({ loading: false, error: '', at: Date.now() }) }
  async function syncStatus() { const next = await window.misaka?.getStatus?.(); if (next) setStatus({ ...INITIAL_STATUS, ...next }); return next }
  function coreNode(node) { return node.local ? { uri: node.uri, id: node.id } : { nodeId: node.id, id: node.id } }
  async function toggleConnection() {
    if (busy) return
    if (!window.misaka?.connect) { notify('请在已安装的桌面客户端中连接', 'error'); return }
    const attempt = ++connectAttempt.current
    setOperation(true)
    try {
      if (connected) { const result = await window.misaka.disconnect(); if (result?.ok === false) throw new Error(result.message || '断开失败，请重试'); await syncStatus(); notify('已断开，系统代理已恢复') }
      else {
        if (!activeNode) throw new Error('请先导入线路，或请管理员分配私有线路')
        const result = await window.misaka.connect({ ...coreNode(activeNode), name: activeNode.name, mode: routeMode })
        if (attempt !== connectAttempt.current) return
        if (!result?.ok) throw new Error(result?.message || '连接未能建立，请查看诊断日志')
        await syncStatus(); notify('连接已建立')
      }
    } catch (error) { if (attempt === connectAttempt.current) { notify(error.message || '连接操作失败', 'error'); await syncStatus().catch(() => {}) } }
    finally { if (attempt === connectAttempt.current) setOperation(false) }
  }
  async function cancelConnection() {
    if (cancelling) return
    ++connectAttempt.current
    setCancelling(true)
    try {
      const result = await window.misaka.disconnect()
      if (result?.ok === false) throw new Error(result.message || '取消连接失败')
      await syncStatus()
      notify('连接已取消')
    } catch (error) { notify(error.message || '取消连接失败', 'error'); await syncStatus().catch(() => {}) }
    finally { setCancelling(false); setOperation(false) }
  }
  async function testNode(node) {
    if (testsInFlight.current.has(node.id)) return
    testsInFlight.current.add(node.id); setTests((previous) => ({ ...previous, [node.id]: { busy: true } }))
    try {
      if (!window.misaka?.testNode) throw new Error('请更新桌面客户端后再测试')
      const result = await window.misaka.testNode(coreNode(node))
      setTests((previous) => ({ ...previous, [node.id]: { ...result, busy: false } }))
    } catch (error) { setTests((previous) => ({ ...previous, [node.id]: { ok: false, message: error.message, busy: false } })) }
    finally { testsInFlight.current.delete(node.id) }
  }
  async function logout() { if (busy) return; setOperation(true); try { await onLogout() } catch (error) { notify(error.message || '未能安全断开，请重试', 'error') } finally { setOperation(false) } }

  async function importNodes(event) {
    event.preventDefault(); if (!importText.trim() || importBusy) return
    setImportBusy(true); setImportErrors([]); mutation.current = true; refreshId.current++
    try {
      if (!window.misaka?.validateNodes) throw new Error('请在桌面客户端中导入线路')
      const result = await window.misaka.validateNodes(importText)
      const known = new Set(nodes.filter((node) => node.uri).map((node) => nodeKey(node.uri)))
      const errors = [...(result?.errors || [])]
      let saved = 0, duplicates = 0
      const additions = []
      for (const node of result?.nodes || []) {
        if (!node.uri || !SUPPORTED_SCHEMES.test(node.uri)) continue
        if (known.has(nodeKey(node.uri))) { duplicates++; continue }
        try {
          if (shared) additions.push({ ...node, id: `local-${Date.now()}-${additions.length}`, name: node.name || '我的线路', note: '', local: true })
          else { const data = await request('/api/nodes', { method: 'POST', body: { uri: node.uri, name: node.name || '我的线路', note: '' } }); mergeNode(data.node) }
          known.add(nodeKey(node.uri)); saved++
        } catch (error) { errors.push(`“${node.name || '线路'}”未保存：${error.message}`) }
      }
      if (shared && additions.length) saveLocal([...localNodes, ...additions])
      if (!saved && !duplicates && !errors.length) errors.push('没有识别到有效的分享链接，请检查后重试。')
      setImportErrors(errors)
      if (saved || duplicates) notify(`已${shared ? '保存到本机' : '同步'} ${saved} 条线路${duplicates ? `，跳过 ${duplicates} 条重复线路` : ''}`)
      if (errors.length === 0 && (saved || duplicates)) { setImportText(''); setPanel('nodes') }
    } catch (error) { setImportErrors([error.message || '导入失败，输入已保留']) }
    finally { setImportBusy(false); mutation.current = false }
  }
  async function copyNode(node) { if (node.private || !node.uri) return; try { await navigator.clipboard.writeText(node.uri); notify('分享链接已复制') } catch { notify('无法访问剪贴板，请重试', 'error') } }
  function openNodes() { setPendingSelected(activeNode?.id || ''); setPanel('nodes') }
  function chooseNode(node) { if (busy) { notify('请等待当前连接操作完成', 'error'); return }; if (panel !== 'nodes') openNodes(); setPendingSelected(node.id) }
  async function confirmNodeSelection() {
    const node = nodes.find((item) => item.id === pendingSelected)
    if (!node) { notify('请选择一条可用线路', 'error'); return }
    if (busy) { notify('请等待当前连接操作完成', 'error'); return }
    const switching = connected && activeNode?.id !== node.id
    setSelected(node.id)
    await window.misaka?.setSelection?.({...coreNode(node),mode:routeMode,manual:true})
    setPanel(null)
    if (!switching) { notify(connected ? '当前线路保持连接' : `已选用 ${node.name}，点击一键连接即可使用`); return }
    const attempt = ++connectAttempt.current
    setOperation(true)
    try {
      const result = await window.misaka.connect({ ...coreNode(node), name: node.name, mode: routeMode,manual:true })
      if (attempt !== connectAttempt.current) return
      if (!result?.ok) throw new Error(result?.message || '切换线路失败，请查看诊断日志')
      await syncStatus(); notify(`已切换并连接 ${node.name}`)
    } catch (error) { if (attempt === connectAttempt.current) { notify(error.message || '切换线路失败', 'error'); await syncStatus().catch(() => {}) } }
    finally { if (attempt === connectAttempt.current) setOperation(false) }
  }
  async function saveProxyPort(event) {
    event.preventDefault()
    const port = Number(portDraft)
    if (!/^\d+$/.test(portDraft.trim()) || !Number.isInteger(port) || port < 1 || port > 65535) { notify('端口必须是 1–65535 之间的整数', 'error'); return }
    setPortSaving(true)
    try {
      if (!window.misaka?.setProxyPort) throw new Error('请更新桌面客户端后再修改端口')
      const result = await window.misaka.setProxyPort(port)
      if (!result?.ok) throw new Error(result?.message || '端口设置未保存')
      await syncStatus(); notify(`本地代理端口已设为 ${port}，下次连接生效`)
    } catch (error) { notify(error.message || '端口设置失败', 'error') }
    finally { setPortSaving(false) }
  }
  function editNode(node) { setNodeEditor({ ...node, note: node.note || '' }); setNodeError(''); setPanel('node-edit') }
  async function saveNode(event) {
    event.preventDefault(); if (nodeBusy) return
    setNodeBusy(true); setNodeError(''); mutation.current = true; refreshId.current++
    try {
      const body = { name: nodeEditor.name.trim(), note: nodeEditor.note.trim() }
      if (nodeEditor.local) saveLocal(localNodes.map((node) => node.id === nodeEditor.id ? { ...node, ...body } : node))
      else if (shared && nodeEditor.private) { const next = { ...localNotes, [nodeEditor.id]: body }; localStorage.setItem(notesKey, JSON.stringify(next)); setLocalNotes(next) }
      else {
        const endpoint = nodeEditor.private ? root ? '/api/private-nodes/' : '/api/node-annotations/' : '/api/nodes/'
        const data = await request(`${endpoint}${encodeURIComponent(nodeEditor.id)}`, { method: 'PATCH', body: { ...body, ...(!nodeEditor.private || root ? { revision: nodeEditor.revision } : {}) } }); mergeNode(data.node)
      }
      setPanel('nodes'); notify(shared ? '名称和备注已保存到本机' : '名称和备注已同步')
    } catch (error) {
      if (error.status === 409) { await refreshNodes().catch(() => {}); setNodeError('这条线路已在其他设备修改。你的输入已保留；请返回线路列表，重新打开最新版本后编辑。') }
      else setNodeError(`${error.message}。输入已保留，请重试。`)
    } finally { setNodeBusy(false); mutation.current = false }
  }
  function newPrivate(node = null) { setNodeEditor({ name: node?.name || '', note: node?.note || '', uri: '', sourceNodeId: node?.id }); setNodeError(''); setPanel('private-create') }
  async function createPrivate(event) {
    event.preventDefault(); if (nodeBusy) return
    setNodeBusy(true); setNodeError(''); mutation.current = true; refreshId.current++
    try {
      let uri = nodeEditor.uri.trim()
      if (!nodeEditor.sourceNodeId) {
        if (uri.split(/\r?\n/).filter((line) => line.trim()).length !== 1) throw new Error('每次只能添加一条私有线路，请只粘贴一条分享链接')
        if (!window.misaka?.validateNodes) throw new Error('请使用新版桌面客户端验证线路')
        const validation = await window.misaka.validateNodes(uri)
        if (validation.nodes?.length !== 1 || validation.errors?.length) throw new Error(validation.errors?.[0] || '线路分享链接无效，请检查协议与参数')
        uri = validation.nodes[0].uri
      }
      const data = await request('/api/private-nodes', { method: 'POST', body: { ...(nodeEditor.sourceNodeId ? { sourceNodeId: nodeEditor.sourceNodeId } : { uri }), name: nodeEditor.name.trim(), note: nodeEditor.note.trim() } })
      await refreshNodes(); setPanel('nodes'); notify('私有线路已创建，可点击“分配用户”设置使用权限')
      if (data.node) setSelected(data.node.id)
    } catch (error) { setNodeError(`${error.message}。输入已保留。`) } finally { setNodeBusy(false); mutation.current = false }
  }
  async function refreshUsers() { const data = await request('/api/users'); setUsers(data.users || []); try { const summary = await request('/api/stats'); setStats(summary) } catch { setStats({ userCount: (data.users || []).length, activeSessions: null }) }; return data.users || [] }
  async function openUsers() { setPanel('users'); setAdminBusy(true); try { await refreshUsers() } catch (error) { notify(error.message, 'error') } finally { setAdminBusy(false) } }
  async function openAssignment(node) {
    setAssignment(node); setPanel('assign'); setNodeError(''); setAdminBusy(true)
    try { const values = await refreshUsers(); setAssignChecks(Object.fromEntries(values.filter((user) => !user.isRoot).map((user) => [user.username, Boolean(user.privateNodeAccess && user.privateNodeIds?.includes(node.id))]))) }
    catch (error) { setNodeError(error.message) } finally { setAdminBusy(false) }
  }
  async function saveAssignment(event) {
    event.preventDefault(); if (adminBusy || nodeError) return
    setAdminBusy(true); const failures = []
    try {
      for (const user of users.filter((value) => !value.isRoot)) {
        const enabled = Boolean(assignChecks[user.username]); const previous = Boolean(user.privateNodeAccess && user.privateNodeIds?.includes(assignment.id))
        if (enabled === previous) continue
        const validIds = new Set(privateNodes.map((node) => node.id)); const ids = new Set((user.privateNodeIds || []).filter((id) => validIds.has(id))); if (enabled) ids.add(assignment.id); else ids.delete(assignment.id)
        try { await request(`/api/users/${encodeURIComponent(user.username)}`, { method: 'PATCH', body: { privateNodeIds: [...ids], ...(enabled ? { privateNodeAccess: true } : {}) } }) }
        catch (error) { failures.push(`${user.username}：${error.message}`) }
      }
      await refreshUsers()
      if (failures.length) setNodeError(`部分授权未保存：${failures.join('；')}。请重新打开此面板后重试。`)
      else { setPanel('nodes'); notify('线路使用权限已保存') }
    } catch (error) { setNodeError(error.message) } finally { setAdminBusy(false) }
  }
  async function createUser(event) {
    event.preventDefault(); if (adminBusy) return
    setAdminBusy(true)
    try { await request('/api/users', { method: 'POST', body: { username: newUsername.trim(), password: newPassword, role: newRole } }); setNewUsername(''); setNewPassword(''); await refreshUsers(); setPanel('users'); notify('新账号已创建') }
    catch (error) { notify(error.message, 'error') } finally { setAdminBusy(false) }
  }
  async function toggleUser(user) {
    setAdminBusy(true)
    try { await request(`/api/users/${encodeURIComponent(user.username)}`, { method: 'PATCH', body: { disabled: !user.disabled } }); await refreshUsers(); notify(user.disabled ? '账号已启用' : '账号已停用') }
    catch (error) { notify(error.message, 'error') } finally { setAdminBusy(false) }
  }
  function editUser(user) { setEditor({ ...user, privateNodeIds: (user.privateNodeIds || []).filter((id) => privateNodes.some((node) => node.id === id)), expiresAt: user.expiresAt ? new Date(user.expiresAt).toISOString().slice(0, 10) : '' }); setNewPassword(''); setPanel('user-edit') }
  async function saveUser(event) {
    event.preventDefault(); if (adminBusy) return
    setAdminBusy(true)
    try {
      await request(`/api/users/${encodeURIComponent(editor.username)}`, { method: 'PATCH', body: { role: editor.role, disabled: editor.disabled, expiresAt: editor.expiresAt ? new Date(`${editor.expiresAt}T23:59:59`).toISOString() : null, ...(root ? { privateNodeAccess: editor.privateNodeAccess, privateNodeIds: editor.privateNodeIds.filter((id) => privateNodes.some((node) => node.id === id)) } : {}) } })
      if (newPassword) await request(`/api/users/${encodeURIComponent(editor.username)}/password`, { method: 'PATCH', body: { password: newPassword } })
      await refreshUsers(); setNewPassword(''); setPanel('users'); notify('账号设置已保存')
    } catch (error) { notify(error.message, 'error') } finally { setAdminBusy(false) }
  }
  async function confirmDelete() {
    setAdminBusy(true); mutation.current = true; refreshId.current++
    try {
      if (deleteTarget.kind === 'node') {
        const node = deleteTarget.node
        if (status.nodeId === node.id && (connected || busy)) throw new Error('请先断开当前线路')
        if (node.local) saveLocal(localNodes.filter((item) => item.id !== node.id))
        else { await request(`${node.private ? '/api/private-nodes/' : '/api/nodes/'}${encodeURIComponent(node.id)}`, { method: 'DELETE' }); setCloudNodes((previous) => previous.filter((item) => item.id !== node.id)) }
        setPanel('nodes'); notify(node.local ? '本机线路已移除' : '线路已从服务器移除')
      } else { await request(`/api/users/${encodeURIComponent(deleteTarget.username)}`, { method: 'DELETE' }); await refreshUsers(); setPanel('users'); notify('账号已删除') }
      setDeleteTarget(null)
    } catch (error) { notify(error.message, 'error') } finally { setAdminBusy(false); mutation.current = false }
  }
  async function changeOwnPassword(event) {
    event.preventDefault(); if (adminBusy || shared) return
    if (newPassword !== confirmation) { notify('两次输入的新密码不一致', 'error'); return }
    setAdminBusy(true)
    try { await request('/api/me/password', { method: 'POST', body: { currentPassword, password: newPassword } }); await onLogout() }
    catch (error) { notify(error.message, 'error') } finally { setAdminBusy(false) }
  }
  const refreshLogs = useCallback(async () => {
    try { if (!window.misaka?.getLogs) throw new Error('诊断日志仅在桌面客户端中可用'); const data = await window.misaka.getLogs(); setLogs(Array.isArray(data) ? data : []); setLogError('') }
    catch (error) { setLogError(error.message || '读取日志失败') }
  }, [])
  useEffect(() => { if (panel !== 'logs') return; refreshLogs(); const timer = setInterval(refreshLogs, 2000); return () => clearInterval(timer) }, [panel, refreshLogs])
  const shownLogs = logs.filter((entry) => logFilter === 'all' || /error|warn/i.test(entry.level || ''))
  const sessionTime = formatDuration(status.startedAt, now)
  const nodeAvailable = Boolean(activeNode)
  const currentMode = connected ? status.mode || routeMode : routeMode
  const syncLabel = syncState.loading ? '正在同步线路' : syncState.error ? '同步失败 · 需要重试' : shared ? '私有线路已更新 · 个人线路仅本机' : syncState.at ? `已同步 · ${new Date(syncState.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '等待同步'
  const legacy = useMemo(legacyNodes, [])
  function nodeRow(node, tools = false) {
    if (!node) return <div className="empty-node"><Icon name="globe" size={25}/><div><strong>{syncState.loading ? '正在获取你的线路…' : '还没有可用线路'}</strong><p>{syncState.error || '导入个人线路，或请管理员分配私有线路。'}</p></div><button className="text-button" onClick={() => setPanel('import')}>导入线路</button></div>
    const checked = (tools ? pendingSelected || activeNode?.id : activeNode?.id) === node.id
    const test = tests[node.id]
    const testLabel = test?.busy ? '测试中' : test?.ok && Number.isFinite(test.latencyMs) ? `${test.latencyMs} ms` : !test ? '测试延迟' : /正在测试其他/.test(test.message || '') ? '稍后再试' : /取消/.test(test.message || '') ? '已取消' : /超时/.test(test.message || '') ? '测试超时' : /无法连通/.test(test.message || '') ? '未连通' : '测试失败'
    return <div className={`node-row node-card ${checked ? 'selected' : ''}`} key={node.id}>
      <div className="node-heading"><button className="node-select" aria-pressed={checked} onClick={() => chooseNode(node)} disabled={busy}><span className={`node-symbol ${node.private ? 'managed' : ''}`}><Icon name={node.private ? 'shield' : 'globe'} size={19}/></span><span className="node-main"><strong>{node.name}</strong><small>{node.protocol} <span>·</span> {node.private ? '私有线路' : node.local ? '仅本机' : '账号云同步'}</small></span><span className="node-tag">{node.private ? <><Icon name="lock" size={11}/>私有</> : <Icon name={node.local ? 'user' : 'cloud'} size={13}/>}</span><span className={`radio ${checked ? 'checked' : ''}`}>{checked && <Icon name="check" size={10}/>}</span></button><button className={`probe-button ${test?.ok ? 'reachable' : test && !test.busy ? 'unreachable' : ''}`} disabled={test?.busy} title={test?.message || '测试线路连通性与实际请求延迟，不改变当前连接'} aria-label={`测试 ${node.name} 连通性`} onClick={() => testNode(node)}>{test?.busy ? <span className="spinner"/> : <Icon name="pulse" size={14}/>}<span>{testLabel}</span></button></div>
      {node.note && <p className="node-note">{node.note}</p>}
      {tools && test && !test.busy && !test.ok && <p className="node-test-error" role="status">{test.message || '测试未完成，请重试'}</p>}
      {tools && <div className="node-tool-row"><button className="text-button" onClick={() => editNode(node)}><Icon name="edit" size={12}/>名称与备注</button>{!node.private && <button className="text-button" onClick={() => copyNode(node)}><Icon name="copy" size={12}/>复制链接</button>}{root && <button className="text-button" onClick={() => node.private ? openAssignment(node) : newPrivate(node)}><Icon name={node.private ? 'users' : 'shield'} size={12}/>{node.private ? '分配用户' : '设为私有'}</button>}{root && node.private && node.protocol?.toLowerCase() === 'hysteria2' && <button className="text-button" onClick={() => { setMeterNode(node); setPanel('meter') }}><Icon name="shield" size={12}/>{node.metered ? '管理接管' : '服务端接管'}</button>}{(!node.private || root) && <button className="text-button danger" disabled={status.nodeId === node.id && (connected || busy)} onClick={() => { setDeleteTarget({ kind: 'node', node }); setPanel('delete') }}><Icon name="trash" size={12}/>移除</button>}</div>}
    </div>
  }

  const extras=<WorkspaceExtras account={account} request={request} panel={panel} setPanel={setPanel} status={status} Modal={Modal} Icon={Icon} notify={notify} onLogout={onLogout} onUsage={setMonthlyUsage} onOpenUsers={openUsers} targetUser={quotaUser} meterNode={meterNode} onNodeUpdated={mergeNode}/>
  return <div className="app-shell">
    <aside className="sidebar"><Brand/><span className="side-caption">你的工作区</span><nav className="nav-list" aria-label="主导航"><button className={`nav-item ${!panel ? 'active' : ''}`} onClick={() => setPanel(null)}><Icon name="power"/><span>连接中心</span><i/></button><button className={`nav-item ${panel === 'nodes' || panel === 'import' ? 'active' : ''}`} onClick={openNodes}><Icon name="globe"/><span>我的线路</span><small>{nodes.length}</small></button><button className={`nav-item ${panel === 'settings' ? 'active' : ''}`} onClick={() => setPanel('settings')}><Icon name="settings"/><span>偏好设置</span></button><button className={`nav-item ${panel === 'logs' ? 'active' : ''}`} onClick={() => setPanel('logs')}><Icon name="log"/><span>诊断日志</span></button>{canManage && <><span className="side-caption admin-caption">管理工作区</span><button className={`nav-item ${panel === "overview" ? "active" : ""}`} onClick={() => setPanel("overview")}><Icon name="pulse"/><span>管理概览</span></button><button className={`nav-item ${panel === 'users' ? 'active' : ''}`} onClick={openUsers}><Icon name="users"/><span>用户管理</span><small>{root ? 'ROOT' : 'ADMIN'}</small></button></>}</nav><div className="sidebar-bottom"><div className="version-card"><span className={`status-dot ${info.core ? 'green' : ''}`}/><div><strong>{info.core ? '代理核心就绪' : '等待核心'}</strong><small>{info.version ? `v${info.version}` : 'qaletx link'} · {info.platform === 'darwin' ? 'macOS' : info.platform === 'win32' ? 'Windows' : '桌面客户端'}</small></div></div><button className="sidebar-account" onClick={() => setPanel('account')}><span className="avatar">{account.username?.slice(0, 1).toUpperCase()}</span><span><strong>{account.username}</strong><small>{roleName(account)}</small></span><Icon name="chevron" size={14}/></button></div></aside>
    <main className="main-panel"><header className="topbar"><div><span className="eyebrow">A QUIETER WAY TO CONNECT</span><h1>连接，简单一点<span>。</span></h1></div><div className="topbar-right"><span className="status-chip"><i className={`status-dot ${connected ? 'green' : ''}`}/>{PHASE_NAMES[status.phase] || '尚未连接'}</span><button className="icon-button" aria-label="偏好设置" onClick={() => setPanel('settings')}><Icon name="settings"/></button></div></header>
      <div className="dashboard-grid"><section className={`connection-card ${connected ? 'is-connected' : ''} ${busy ? 'is-working' : ''}`} aria-label="连接控制"><div className="connection-art" aria-hidden="true"><i/><i/><i/><b/></div><div className="connection-copy"><span className="connection-label"><i/>{connected ? 'CONNECTED' : busy ? 'CONNECTING' : 'READY WHEN YOU ARE'}</span><h2>{connected ? <>世界，近在眼前。</> : <>一键，连接你的世界。</>}</h2><strong className="current-line">{activeNode?.name || '选择一条线路'}</strong><p>{status.phase === 'connecting' ? `${status.stage || '正在准备连接'}${status.stageStartedAt ? ` · ${Math.max(0,Math.floor((now-status.stageStartedAt)/1000))} 秒` : ''}` : status.phase === 'error' ? '连接遇到了问题，可以重试或查看诊断。' : connected ? '系统代理已接管，安心继续你的工作。' : nodeAvailable ? '已为你选好线路，点击连接即可开始。' : '导入线路或联系管理员，即可开始连接。'}</p><button className={`connect-button ${connected || canCancel ? 'disconnect' : ''}`} disabled={cancelling || status.phase === 'disconnecting' || (!connected && !nodeAvailable && !busy)} onClick={canCancel ? cancelConnection : toggleConnection}>{busy && !canCancel ? <span className="spinner"/> : <Icon name="power" size={17}/>}<span>{status.phase === 'disconnecting' || cancelling ? '正在取消' : canCancel ? '取消连接' : connected ? '断开连接' : '一键连接'}</span><Icon name="arrow" size={17}/></button>{status.recoveryReason && <small className="recovery-note">{status.recoveryReason}{status.retryAt ? ` · ${Math.max(0,Math.ceil((status.retryAt-now)/1000))} 秒后重试` : ''}</small>}</div><div className="connection-footer"><span><Icon name="globe" size={13}/>{MODE_NAMES[currentMode]}</span><span>{activeNode?.protocol || '选择线路'}</span></div></section>
      <section className="session-panel" aria-label="本次连接状态"><div className="panel-caption"><span className="eyebrow">THIS SESSION</span><Icon name="clock" size={16}/></div><div className="session-clock"><strong>{sessionTime}</strong><span>{connected ? '本次连接时长' : '连接后开始计时'}</span></div><div className="traffic-grid"><div><span><Icon name="down" size={13}/>下载</span><strong>{formatBytes(status.down)}</strong></div><div><span><Icon name="up" size={13}/>上传</span><strong>{formatBytes(status.up)}</strong></div></div><div className="proxy-status"><span className={`status-dot ${status.systemProxy ? 'green' : ''}`}/>{status.systemProxy ? '系统代理已开启' : '系统代理未接管'}<button aria-label="查看连接诊断" onClick={() => setPanel('logs')}><Icon name="chevron" size={13}/></button></div></section>
      <div className="monthly-usage"><UsageStrip usage={monthlyUsage}/></div><section className="nodes-panel"><div className="section-head"><div><span className="eyebrow">YOUR CONNECTIONS</span><h2>可用线路 <span>{nodes.length}</span></h2></div><button className="text-button" onClick={openNodes}>管理线路<Icon name="chevron" size={14}/></button></div><div className="nodes-preview">{nodeRow(activeNode)}</div><div className="nodes-bottom"><span><Icon name="lock" size={12}/>{activeNode?.private ? '私有线路由管理员分配，不提供分享导出。' : shared ? '共用账号的个人线路仅保存在本机。' : '个人线路与账号同步，换台电脑也能继续。'}</span><button className="text-button" onClick={openNodes}>切换线路<Icon name="refresh" size={13}/></button></div></section>
      {(status.error || !nodeAvailable) && <div className="inline-error" role="status"><span>{!nodeAvailable ? syncState.error || '暂无线路，请导入或联系管理员分配。' : status.error}</span><button className="text-button" onClick={() => setPanel('logs')}>查看诊断</button></div>}
      </div><footer className="footer"><span>qaletx link <i/> 给连接留一点简单</span><button onClick={() => setPanel('logs')}><Icon name="log" size={12}/>连接诊断</button></footer>
    </main>

    {!['settings','logs','account'].includes(panel) && extras}
    {panel === 'nodes' && <Modal title="我的线路" eyebrow="YOUR CONNECTIONS" onClose={closePanel} wide>
      <div className={`sync-strip ${syncState.error ? 'sync-error' : ''}`}><span><Icon name="cloud" size={14}/>{syncLabel}</span><button className="text-button" disabled={syncState.loading || nodeBusy || importBusy} onClick={() => refreshNodes().catch((error) => notify(error.message, 'error'))}><Icon name="refresh" size={13}/>刷新</button></div>
      {syncState.error && <p className="form-error" role="alert">{syncState.error}。列表可能不是最新状态，连接和测试时会重新验证权限。</p>}
      <div className="modal-node-list">{nodes.length ? nodes.map((node) => nodeRow(node, true)) : nodeRow(null)}</div>
      <div className="node-selection-bar"><div><span>准备使用的线路</span><strong>{nodes.find((node) => node.id === pendingSelected)?.name || activeNode?.name || '请选择线路'}</strong><small>{connected ? '确认后会自动断开当前线路并连接新线路' : '确认后回到连接中心，一键连接即可使用'}</small></div><button className="primary-button" disabled={busy || !nodes.length || !nodes.some((node) => node.id === pendingSelected)} onClick={confirmNodeSelection}><Icon name="check" size={15}/>{connected && pendingSelected !== activeNode?.id ? '确认切换并连接' : '确认选择'}</button></div>
      {legacy.length > 0 && <details className="legacy-import"><summary>发现旧版本本机线路（{legacy.length} 条）</summary><p>这些线路尚未归属任何账号。确认它们属于你后，可手动导入{shared ? '当前账号的本机列表' : '当前账号并同步到其他设备'}。原数据会保留。</p><button className="text-button" onClick={() => { setImportText(legacy.map((node) => node.uri).join('\n')); setImportErrors([]); setPanel('import') }}>确认属于我，查看并导入</button></details>}
      <div className="modal-actions"><span className="quiet-text">共 {nodes.length} 条 · 私有 {privateNodes.length} 条</span>{root && <button className="secondary-button" onClick={() => newPrivate()}><Icon name="shield" size={14}/>新增私有</button>}<button className="primary-button" onClick={() => { setImportErrors([]); setPanel('import') }}><Icon name="plus" size={15}/>导入线路</button></div>
    </Modal>}
    {panel === 'node-edit' && nodeEditor && <Modal title="名称与备注" eyebrow="MAKE IT YOURS" onClose={() => !nodeBusy && setPanel('nodes')}><p className="modal-copy">{nodeEditor.private ? root ? '修改私有线路的默认名称和备注。用户自己的备注仍会保留。' : shared ? '备注仅保存在此电脑，不影响其他人。' : '这是你自己的名称和备注，会随账号同步，不影响其他用户。' : shared ? '名称和备注仅保存在此电脑。' : '保存后，其他电脑登录此账号即可同步。'}</p><form className="stack-form" onSubmit={saveNode}><label className="field-label">线路名称<input required maxLength={100} value={nodeEditor.name} onChange={(event) => setNodeEditor({ ...nodeEditor, name: event.target.value })}/></label><label className="field-label">备注<textarea maxLength={500} rows={3} value={nodeEditor.note} onChange={(event) => setNodeEditor({ ...nodeEditor, note: event.target.value })} placeholder="例如：日常工作 · 晚间备用"/></label>{nodeError && <p className="form-error" role="alert">{nodeError}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={nodeBusy} onClick={() => setPanel('nodes')}>返回线路</button><button className="primary-button" disabled={nodeBusy || !nodeEditor.name.trim()}>{nodeBusy ? '正在保存' : '保存名称与备注'}</button></div></form></Modal>}
    {panel === 'private-create' && nodeEditor && root && <Modal title={nodeEditor.sourceNodeId ? '将线路设为私有' : '新增私有线路'} eyebrow="PRIVATE CONNECTION" onClose={() => !nodeBusy && setPanel('nodes')}><p className="modal-copy">私有线路由你分配给指定用户。用户无法复制分享链接；创建后，点击“分配用户”开放使用。</p><form className="stack-form" onSubmit={createPrivate}>{!nodeEditor.sourceNodeId && <label className="field-label">线路分享链接<textarea required rows={3} spellCheck={false} value={nodeEditor.uri} onChange={(event) => setNodeEditor({ ...nodeEditor, uri: event.target.value })} placeholder="粘贴一条有效的分享链接"/></label>}<label className="field-label">默认名称<input required maxLength={100} value={nodeEditor.name} onChange={(event) => setNodeEditor({ ...nodeEditor, name: event.target.value })}/></label><label className="field-label">默认备注<textarea maxLength={500} rows={2} value={nodeEditor.note} onChange={(event) => setNodeEditor({ ...nodeEditor, note: event.target.value })}/></label>{nodeError && <p className="form-error" role="alert">{nodeError}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={nodeBusy} onClick={() => setPanel('nodes')}>取消</button><button className="primary-button" disabled={nodeBusy || !nodeEditor.name.trim()}>{nodeBusy ? '正在保存' : '创建私有线路'}</button></div></form></Modal>}
    {panel === 'assign' && assignment && root && <Modal title="分配线路给用户" eyebrow="SHARE ACCESS, NOT LINKS" onClose={() => !adminBusy && setPanel('nodes')} wide><p className="modal-copy">线路：<strong>{assignment.name}</strong>。勾选用户即可开放这条线路，同时启用其私有线路开关；取消勾选只撤销这条线路的权限。</p><form onSubmit={saveAssignment}><div className="assignment-list">{adminBusy && !users.length ? <p className="empty-message">正在读取用户…</p> : users.filter((user) => !user.isRoot).map((user) => <label className="assignment-row" key={user.username}><input type="checkbox" disabled={adminBusy} checked={Boolean(assignChecks[user.username])} onChange={(event) => setAssignChecks({ ...assignChecks, [user.username]: event.target.checked })}/><span><strong>{user.username}</strong><small>{roleName(user)} · {user.disabled ? '已停用' : '已启用'}{!user.privateNodeAccess ? ' · 私有线路开关关闭' : ''}</small></span><Icon name="user" size={16}/></label>)}{!adminBusy && users.filter((user) => !user.isRoot).length === 0 && <p className="empty-message">还没有可分配的用户，请先在用户管理中创建。</p>}</div>{nodeError && <p className="form-error" role="alert">{nodeError}</p>}<div className="modal-actions"><span className="quiet-text">root 始终可管理所有私有线路</span><button type="button" className="secondary-button" disabled={adminBusy} onClick={() => setPanel('nodes')}>返回</button><button className="primary-button" disabled={adminBusy || Boolean(nodeError)}>{adminBusy ? '正在保存' : '保存使用权限'}</button></div></form></Modal>}
    {panel === 'import' && <Modal title="把你的线路带进来" eyebrow="ADD CONNECTIONS" onClose={closePanel}><p className="modal-copy">支持 Hysteria2、TUIC、VLESS、VMess、Trojan、Shadowsocks、SOCKS 和 HTTP 分享链接。每行一条，重复线路会自动跳过。</p><p className="import-storage"><Icon name={shared ? "user" : "cloud"} size={14}/>{shared ? "共用账号：导入线路仅保存在这台电脑，不上传服务器。" : "导入线路将保存到你的账号，其他电脑登录后自动同步。"}</p><form onSubmit={importNodes}><label className="field-label">分享链接<textarea required value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴一条或多条分享链接" rows={6} spellCheck={false}/></label>{importErrors.length > 0 && <div className="form-error" role="alert">{importErrors.map((error, index) => <p key={index}>{error}</p>)}</div>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={importBusy} onClick={() => setPanel('nodes')}>返回线路</button><button className="primary-button" disabled={importBusy || !importText.trim()}>{importBusy ? <span className="spinner"/> : <Icon name="plus" size={15}/>}验证并导入</button></div></form></Modal>}
    {panel === 'settings' && <Modal title="按你的习惯连接" eyebrow="PREFERENCES" onClose={closePanel}>{extras}<div className="settings-section"><h3>系统代理 · 代理范围</h3><p>仅遵循系统代理的应用会使用线路。更改在下次连接时生效。</p><div className="mode-options">{Object.entries(MODE_NAMES).map(([value, label]) => <button key={value} className={`mode-option ${routeMode === value ? 'selected' : ''}`} aria-pressed={routeMode === value} onClick={() => { setRouteMode(value); localStorage.setItem('qaletxRouteMode', value) }}><Icon name={value === 'global' ? 'globe' : 'shield'} size={21}/><strong>{label}</strong><span>{value === 'global' ? '应用发送到本地代理的请求走线路' : '本机和局域网地址直接访问'}</span>{routeMode === value && <i><Icon name="check" size={12}/></i>}</button>)}</div></div><div className="settings-section"><h3>本地代理</h3><p>HTTP 与 SOCKS 共用一个本地端口。默认 10808，设置保存在这台电脑。</p><form className="proxy-port-form" onSubmit={saveProxyPort}><label className="field-label">监听端口<input type="number" min="1" max="65535" step="1" inputMode="numeric" value={portDraft} disabled={connected || busy || portSaving} onChange={(event) => setPortDraft(event.target.value)}/></label><button type="button" className="text-button" disabled={connected || busy || portSaving || portDraft === '10808'} onClick={() => setPortDraft('10808')}>恢复默认</button><button className="primary-button" disabled={connected || busy || portSaving || portDraft === String(status.port)}>{portSaving ? '正在保存' : '保存端口'}</button></form><div className="setting-row"><strong>当前地址</strong><span>127.0.0.1:{status.port || 10808}</span></div>{(connected || busy) && <p className="port-hint">断开连接后可以修改端口。</p>}</div><div className="settings-section"><h3>关闭窗口与退出</h3><div className="setting-row"><strong>关闭窗口</strong><span>收起到系统托盘，保持当前连接</span></div><div className="setting-row"><strong>彻底退出</strong><span>从托盘退出时断开连接并恢复系统代理</span></div><div className="setting-row"><strong>系统代理</strong><span>连接成功后接管，断开后恢复原设置</span></div></div><div className="modal-actions"><button className="secondary-button" onClick={() => setPanel('logs')}><Icon name="log" size={14}/>连接诊断</button><button className="primary-button" onClick={closePanel}>完成</button></div></Modal>}
    {panel === 'logs' && <Modal title="连接诊断" eyebrow="CONNECTION DIAGNOSTICS" onClose={closePanel} wide>{extras}<div className="diagnostic-summary"><div><span>代理核心</span><strong>{info.core ? info.coreName || '已就绪' : '未检测到'}</strong></div><div><span>连接状态</span><strong>{PHASE_NAMES[status.phase] || '未知'}</strong></div><div><span>系统代理</span><strong>{status.systemProxy ? '已接管' : '未接管'}</strong></div></div><div className="log-toolbar"><label>显示<select value={logFilter} onChange={(event) => setLogFilter(event.target.value)}><option value="all">全部日志</option><option value="issues">警告与错误</option></select></label><button className="text-button" onClick={refreshLogs}><Icon name="refresh" size={14}/>刷新</button></div>{logError && <p className="form-error" role="alert">{logError}</p>}<div className="log-list" tabIndex={0} aria-label="诊断日志">{shownLogs.length ? shownLogs.map((entry, index) => <div className={`log-entry ${entry.level}`} key={`${entry.time}-${index}`}><time>{formatLogTime(entry.time)}</time><em>{entry.level || 'info'}</em><span>{entry.message}</span></div>) : <div className="empty-state"><Icon name="log" size={28}/><strong>{logFilter === 'issues' ? '暂无警告或错误' : '暂无连接日志'}</strong><p>连接操作产生的诊断信息会显示在这里。</p></div>}</div><div className="modal-actions"><span className="quiet-text">每 2 秒更新 · 敏感信息已脱敏</span><button className="secondary-button" disabled={!shownLogs.length} onClick={async () => { try { await navigator.clipboard.writeText(shownLogs.map((entry) => `${entry.time} [${entry.level}] ${entry.message}`).join('\n')); notify('诊断日志已复制') } catch { notify('复制失败，请重试', 'error') } }}><Icon name="copy" size={14}/>复制日志</button></div></Modal>}
    {panel === 'account' && <Modal title="我的账号" eyebrow="YOUR ACCOUNT" onClose={closePanel}>{extras}<div className="account-summary"><span className="avatar large">{account.username?.slice(0, 1).toUpperCase()}</span><div><strong>{account.username}</strong><span>{roleName(account)} · {account.expiresAt ? `有效期至 ${new Date(account.expiresAt).toLocaleDateString()}` : '长期有效'}</span></div></div>{shared ? <><div className="shared-notice"><Icon name="users" size={25}/><h3>这是一个共用账号</h3><p>为保证其他使用者能正常登录，密码由管理员统一管理。你的手动线路与备注仅保存到当前电脑。</p></div><div className="modal-actions"><button className="text-button danger" disabled={busy} onClick={logout}><Icon name="logout" size={14}/>{operation ? '正在断开' : '退出登录'}</button><button className="primary-button" onClick={closePanel}>知道了</button></div></> : <form onSubmit={changeOwnPassword} className="stack-form"><h3>修改登录密码</h3><label className="field-label">当前密码<input required type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)}/></label><div className="form-columns"><label className="field-label">新密码<input required minLength={8} type="password" autoComplete="new-password" placeholder="至少 8 位" value={newPassword} onChange={(event) => setNewPassword(event.target.value)}/></label><label className="field-label">确认新密码<input required minLength={8} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}/></label></div><p className="quiet-text">密码修改成功后需要重新登录。</p><div className="modal-actions"><button type="button" className="text-button danger" disabled={busy || adminBusy} onClick={logout}><Icon name="logout" size={14}/>{operation ? '正在断开' : '退出登录'}</button><button className="primary-button" disabled={adminBusy}>{adminBusy ? '正在保存' : '修改密码'}</button></div></form>}</Modal>}
    {panel === 'users' && canManage && <Modal title="管理你的用户" eyebrow={root ? 'ROOT WORKSPACE' : 'ADMIN WORKSPACE'} onClose={closePanel} wide><div className="admin-stats"><div><strong>{users.length}</strong><span>可管理账号</span></div><div><strong>{users.filter((user) => !user.disabled).length}</strong><span>已启用</span></div><div><strong>{stats.activeSessions ?? '—'}</strong><span>登录会话</span></div></div><div className="user-toolbar"><span className="quiet-text">{root ? '角色、私有线路权限、密码与有效期' : '管理普通账号和共用账号'}</span><button className="text-button" disabled={adminBusy} onClick={openUsers}><Icon name="refresh" size={14}/>刷新</button></div><div className="user-list">{adminBusy && !users.length ? <p className="empty-message">正在读取用户…</p> : users.map((user) => <div className="user-row" key={user.username}><span className="user-avatar">{user.username.slice(0, 1).toUpperCase()}</span><div className="user-info"><strong>{user.username}<em className={user.disabled ? 'badge-disabled' : ''}>{roleName(user)}</em></strong><span>{user.disabled ? '已停用 · ' : user.expiresAt && Date.parse(user.expiresAt) < now ? '已过期 · ' : ''}{user.expiresAt ? `到期 ${new Date(user.expiresAt).toLocaleDateString()}` : '长期有效'}{root && !user.isRoot ? ` · 私有线路${user.privateNodeAccess ? ` ${user.privateNodeIds?.length || 0} 条` : '已关闭'}` : ''}</span></div>{!user.isRoot && (root || user.role !== 'admin') && <div className="user-actions"><button className="text-button" disabled={adminBusy} onClick={() => { setQuotaUser(user); setPanel("quota") }}>流量与设备</button><button className="text-button" disabled={adminBusy} onClick={() => editUser(user)}>编辑</button><button className="text-button" disabled={adminBusy} onClick={() => toggleUser(user)}>{user.disabled ? '启用' : '停用'}</button><button className="icon-button danger" disabled={adminBusy} aria-label={`删除用户 ${user.username}`} onClick={() => { setDeleteTarget({ kind: 'user', username: user.username }); setPanel('delete') }}><Icon name="trash" size={14}/></button></div>}</div>)}</div><div className="modal-actions"><span className="quiet-text">{root ? 'root 账号受保护' : '管理员与私有线路权限由 root 管理'}</span><button className="primary-button" disabled={adminBusy} onClick={() => { setNewUsername(''); setNewPassword(''); setNewRole('user'); setPanel('create-user') }}><Icon name="plus" size={14}/>创建账号</button></div></Modal>}
    {panel === 'create-user' && canManage && <Modal title="创建一个新账号" eyebrow="NEW ACCOUNT" onClose={() => !adminBusy && setPanel('users')}><form onSubmit={createUser} className="stack-form"><label className="field-label">账号名称<input autoComplete="off" required value={newUsername} onChange={(event) => setNewUsername(event.target.value)} placeholder="例如：customer01"/></label><label className="field-label">账号类型<select value={newRole} onChange={(event) => setNewRole(event.target.value)}><option value="user">普通用户 · 云同步个人线路</option><option value="shared">共用用户 · 禁止自行改密</option>{root && <option value="admin">管理员 · 管理普通与共用用户</option>}</select></label><label className="field-label">初始密码<input autoComplete="new-password" required minLength={8} type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 8 位"/></label><p className="quiet-text">新账号默认启用、长期有效。私有线路需由 root 单独分配。</p><div className="modal-actions"><button type="button" className="secondary-button" disabled={adminBusy} onClick={() => setPanel('users')}>取消</button><button className="primary-button" disabled={adminBusy}>{adminBusy ? '正在创建' : '创建账号'}</button></div></form></Modal>}
    {panel === 'user-edit' && editor && canManage && <Modal title={`编辑 ${editor.username}`} eyebrow="ACCOUNT SETTINGS" onClose={() => !adminBusy && setPanel('users')}><form onSubmit={saveUser} className="stack-form"><div className="form-columns"><label className="field-label">账号类型<select value={editor.role} onChange={(event) => setEditor({ ...editor, role: event.target.value })}><option value="user">普通用户</option><option value="shared">共用用户</option>{root && <option value="admin">管理员</option>}</select></label><label className="field-label">账号状态<select value={editor.disabled ? 'disabled' : 'enabled'} onChange={(event) => setEditor({ ...editor, disabled: event.target.value === 'disabled' })}><option value="enabled">启用</option><option value="disabled">停用</option></select></label></div><label className="field-label">有效期至<input type="date" value={editor.expiresAt} onChange={(event) => setEditor({ ...editor, expiresAt: event.target.value })}/><small>留空表示长期有效；选定日期截至当地时间 23:59。</small></label>{root && <div className="permission-editor"><label className="permission-switch"><span><strong>允许使用私有线路</strong><small>关闭后，这个账号无法使用任何私有线路</small></span><input type="checkbox" role="switch" checked={Boolean(editor.privateNodeAccess)} onChange={(event) => setEditor({ ...editor, privateNodeAccess: event.target.checked })}/></label>{editor.privateNodeAccess && <div className="private-choices">{privateNodes.length ? privateNodes.map((node) => <label className="private-choice" key={node.id}><input type="checkbox" checked={editor.privateNodeIds.includes(node.id)} onChange={(event) => setEditor({ ...editor, privateNodeIds: event.target.checked ? [...editor.privateNodeIds, node.id] : editor.privateNodeIds.filter((id) => id !== node.id) })}/><span>{node.name}</span><Icon name="lock" size={12}/></label>) : <p className="quiet-text">暂无私有线路，请先从“我的线路”中添加。</p>}</div>}</div>}<label className="field-label">重置密码<input minLength={8} type="password" autoComplete="new-password" placeholder="留空保留原密码" value={newPassword} onChange={(event) => setNewPassword(event.target.value)}/><small>管理员可以重置共用账号密码；重置后需通知所有使用者重新登录。</small></label><div className="modal-actions"><button type="button" className="secondary-button" disabled={adminBusy} onClick={() => setPanel('users')}>取消</button><button className="primary-button" disabled={adminBusy}>{adminBusy ? '正在保存' : '保存更改'}</button></div></form></Modal>}
    {panel === 'delete' && deleteTarget && <Modal title={deleteTarget.kind === 'node' ? '移除这条线路？' : '删除这个账号？'} eyebrow="PLEASE CONFIRM" onClose={() => !adminBusy && setPanel(deleteTarget.kind === 'node' ? 'nodes' : 'users')}><p className="modal-copy">{deleteTarget.kind === 'node' ? deleteTarget.node.private ? `删除“${deleteTarget.node.name}”后，所有获授权用户都将无法再使用这条私有线路。` : `“${deleteTarget.node.name}”将从${deleteTarget.node.local ? '本机线路列表' : '账号云端线路列表（包括其他电脑）'}移除。` : `删除“${deleteTarget.username}”后，该用户将无法继续登录。这项操作无法撤销。`}</p><div className="modal-actions"><button className="secondary-button" disabled={adminBusy} onClick={() => setPanel(deleteTarget.kind === 'node' ? 'nodes' : 'users')}>取消</button><button className="primary-button danger-solid" disabled={adminBusy} onClick={confirmDelete}>{adminBusy ? '正在删除' : '确认删除'}</button></div></Modal>}
    {notice && <div role={notice.type === 'error' ? 'alert' : 'status'} className={`toast ${notice.type}`}><Icon name={notice.type === 'error' ? 'log' : 'check'} size={16}/>{notice.message}<button aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={13}/></button></div>}
  </div>
}

function App() {
  const [account, setAccount] = useState(() => { const saved = readLocal('misakaAccount', null); return saved?.token && typeof saved.username === 'string' ? saved : null })
  const [readyToken, setReadyToken] = useState(null)
  const [message, setMessage] = useState('')
  const accountRef = useRef(account)
  const logoutPromise = useRef(null)
  accountRef.current = account
  const logout = useCallback((forced = false) => {
    if (logoutPromise.current) return logoutPromise.current
    logoutPromise.current = (async () => {
      const previous = accountRef.current
      try {
        const result = await window.misaka?.clearSession?.()
        if (result?.ok === false) throw new Error(result.message || '断开失败，请重试')
      } catch (error) { if (!forced) throw error }
      if (previous?.token && !forced) apiFetch('/api/logout', { baseUrl: previous.apiUrl, method: 'POST', token: previous.token }).catch(() => {})
      localStorage.removeItem('misakaAccount'); setReadyToken(null); setAccount(null); setMessage(forced ? '登录已失效，请重新登录。' : '')
    })().finally(() => { logoutPromise.current = null })
    return logoutPromise.current
  }, [])
  const login = async (next) => {
    if (!window.misaka?.setSession) throw new Error('请使用新版桌面客户端登录')
    const result = await window.misaka.setSession({ apiUrl: next.apiUrl, token: next.token })
    if (!result?.ok) throw new Error(result?.message || '客户端会话初始化失败，请重试')
    const verified = { ...next, ...result.user }
    localStorage.setItem('misakaAccount', JSON.stringify(verified)); setMessage(''); setReadyToken(next.token); setAccount(verified)
  }
  useEffect(() => {
    if (!account?.token || readyToken === account.token) return
    let cancelled = false
    const initialize = async () => {
      try {
        if (!window.misaka?.setSession) throw new Error('请使用新版桌面客户端登录')
        const result = await window.misaka.setSession({ apiUrl: account.apiUrl, token: account.token })
        if (!result?.ok) throw new Error(result?.message || '无法验证登录，请重新登录')
        if (!cancelled) { const verified = { ...account, ...result.user }; localStorage.setItem('misakaAccount', JSON.stringify(verified)); setAccount(verified); setReadyToken(account.token) }
      } catch (error) { if (!cancelled) { await Promise.resolve(window.misaka?.clearSession?.()).catch(() => {}); localStorage.removeItem('misakaAccount'); setAccount(null); setMessage(error.message) } }
    }
    initialize(); return () => { cancelled = true }
  }, [account?.token, readyToken])
  useEffect(() => {
    if (!account?.token || readyToken !== account.token) return
    const expired = (event) => { if (event.detail?.token === accountRef.current?.token) logout(true).catch(() => {}) }
    const verify = async () => {
      try {
        const response = await apiFetch('/api/me', { baseUrl: account.apiUrl, token: account.token })
        if (response.ok && response.data.user && accountRef.current?.token === account.token) setAccount((current) => { if (!current) return current; const next = { ...current, ...response.data.user }; localStorage.setItem('misakaAccount', JSON.stringify(next)); return next })
      } catch {}
    }
    window.addEventListener('qaletx-session-expired', expired); verify()
    const timer = setInterval(verify, 60000)
    return () => { window.removeEventListener('qaletx-session-expired', expired); clearInterval(timer) }
  }, [account?.token, account?.apiUrl, readyToken, logout])
  if (!account) return <LoginScreen message={message} onLogin={login}/>
  if (readyToken !== account.token) return <main className="login-shell"><section className="login-card boot-card"><Brand/><span className="spinner"/><p>正在验证账号并准备线路…</p></section></main>
  return <Dashboard key={`${account.apiUrl}:${account.username}:${account.token}`} account={account} onLogout={() => logout(false)}/>
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
      const info=await window.misaka?.getInfo?.()
      const response = await apiFetch('/api/login', { baseUrl: DEFAULT_API_URL, method: 'POST', body: { username: username.trim(), password,...(info?.device?{device:info.device}:{}) } })
      if (!response.ok) throw new Error(response.data.error || '登录失败，请检查账号和密码')
      if (!response.data.token || !response.data.user) throw new Error('服务器返回的登录信息不完整')
      localStorage.setItem('misakaApiUrl', DEFAULT_API_URL); await onLogin({ ...response.data.user, token: response.data.token, apiUrl: DEFAULT_API_URL })
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
