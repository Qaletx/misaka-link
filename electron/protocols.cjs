'use strict'

const { randomBytes } = require('node:crypto')
const { isIP } = require('node:net')
const { domainToASCII } = require('node:url')
const { TextDecoder } = require('node:util')

// Keep the share-link adapter independent of Electron. Unsupported extensions
// must fail here, rather than silently producing a different connection.
// Configuration schema: https://sing-box.sagernet.org/configuration/outbound/
const SCHEMES = new Set(['hysteria2', 'tuic', 'trojan', 'vless', 'vmess', 'ss', 'socks5', 'http', 'https'])
const SS_METHODS = new Set(['none', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305', 'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr', 'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb', 'rc4-md5', 'chacha20-ietf', 'xchacha20'])
const TLS_ALIASES = {
  sni: ['sni', 'peer', 'serverName', 'servername'],
  insecure: ['insecure', 'allowInsecure', 'allow_insecure', 'skip-cert-verify'],
  fingerprint: ['fp', 'fingerprint'],
}

function invalid(message) { throw new Error(message) }
function decode(value, label = '链接') {
  try { return decodeURIComponent(value) } catch { invalid(`${label}包含无效的 URL 编码`) }
}
function decodeBase64(value, label) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/')
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.replace(/=+$/, '').length % 4 === 1) invalid(`${label}的 Base64 编码无效`)
  const bytes = Buffer.from(normalized, 'base64')
  if (bytes.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) invalid(`${label}的 Base64 编码无效`)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { invalid(`${label}不是有效的 UTF-8 文本`) }
}
function integer(value, label, min = 1, max = 65535) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) invalid(`${label}必须是 ${min}–${max} 之间的整数`)
  return Number(value)
}
function host(value) {
  const hostname = String(value || '').replace(/^\[|\]$/g, '')
  if (isIP(hostname)) return hostname
  const ascii = domainToASCII(hostname)
  if (!ascii || ascii.length > 253 || !ascii.replace(/\.$/, '').split('.').every((part) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part))) invalid('节点服务器地址无效')
  return ascii
}
function uuid(value) {
  const id = String(value || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) invalid('节点 UUID 格式无效')
  return id
}
function required(value, label) {
  if (!value) invalid(`节点缺少${label}`)
  return value
}
function oneOf(value, choices, label) {
  if (!choices.includes(value)) invalid(`不支持的${label}；可用值：${choices.join('、')}`)
  return value
}
function bool(value, label) {
  if (['1', 'true', 'yes'].includes(String(value).toLowerCase())) return true
  if (['0', 'false', 'no'].includes(String(value).toLowerCase())) return false
  invalid(`${label}必须为 true/false 或 1/0`)
}
function duration(value, label) {
  if (!/^\d+(?:\.\d+)?(?:ms|s|m|h)$/.test(value) || parseFloat(value) <= 0) invalid(`${label}必须为正数时长，例如 10s`)
  return value
}
function portRanges(value) {
  const ranges = String(value).split(',')
  if (!ranges.length || ranges.length > 64) invalid('端口跳跃范围无效')
  return ranges.map((range) => {
    const pair = range.split(/[-:]/)
    if (pair.length > 2) invalid('端口跳跃范围无效')
    const start = integer(pair[0], '节点端口')
    // sing-box server_ports expects ranges even for a single port.
    if (pair.length === 1) return `${start}:${start}`
    const end = integer(pair[1], '节点端口')
    if (end < start) invalid('端口跳跃的结束端口小于起始端口')
    return `${start}:${end}`
  })
}

// Reading consumes known parameters; finish() catches typos, plugins and
// extensions instead of discarding security/transport options.
function parameters(entries) {
  const values = new Map()
  for (const [key, value] of entries) {
    if (values.has(key)) invalid(`节点参数 ${key.slice(0, 40)} 重复`)
    if (value !== null && typeof value === 'object') invalid(`节点参数 ${key.slice(0, 40)} 格式无效`)
    values.set(key, value === null || value === undefined ? '' : String(value))
  }
  return {
    take(names, fallback) {
      const keys = Array.isArray(names) ? names : [names]
      const found = keys.filter((key) => values.has(key))
      if (!found.length) return fallback
      const value = values.get(found[0])
      if (found.some((key) => values.get(key) !== value)) invalid(`节点参数 ${keys[0]} 存在冲突`)
      found.forEach((key) => values.delete(key))
      return value
    },
    finish() {
      if (values.size) invalid(`当前不支持节点参数：${[...values.keys()].map((key) => key.replace(/[^\w-]/g, '').slice(0, 40)).join('、')}`)
    },
  }
}

function parseShadowsocks(raw) {
  const body = raw.slice(raw.indexOf('://') + 3)
  const hashIndex = body.indexOf('#')
  const name = hashIndex < 0 ? '' : decode(body.slice(hashIndex + 1), '节点名称')
  const withoutHash = hashIndex < 0 ? body : body.slice(0, hashIndex)
  const queryIndex = withoutHash.indexOf('?')
  const address = (queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex)).replace(/\/$/, '')
  const query = new URLSearchParams(queryIndex < 0 ? '' : withoutHash.slice(queryIndex + 1))
  let credentials, endpoint
  if (address.includes('@')) {
    const at = address.lastIndexOf('@')
    const userinfo = address.slice(0, at)
    endpoint = address.slice(at + 1)
    if (userinfo.includes(':')) {
      const colon = userinfo.indexOf(':')
      credentials = { method: decode(userinfo.slice(0, colon), '加密方式'), password: decode(userinfo.slice(colon + 1), '密码') }
    } else {
      const decoded = decodeBase64(decode(userinfo), 'Shadowsocks 凭据')
      const colon = decoded.indexOf(':')
      if (colon < 1) invalid('Shadowsocks 凭据缺少加密方式或密码')
      credentials = { method: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
    }
  } else {
    const decoded = decodeBase64(decode(address), 'Shadowsocks 链接')
    const at = decoded.lastIndexOf('@')
    const colon = decoded.indexOf(':')
    if (at <= colon || colon < 1) invalid('Shadowsocks 旧版链接格式无效')
    credentials = { method: decoded.slice(0, colon), password: decoded.slice(colon + 1, at) }
    endpoint = decoded.slice(at + 1)
  }
  let parsed
  try { parsed = new URL(`ss://${endpoint}`) } catch { invalid('Shadowsocks 服务器或端口无效') }
  if (parsed.username || parsed.password || parsed.pathname || parsed.search || parsed.hash || !parsed.port) invalid('Shadowsocks 服务器地址必须包含有效端口')
  return { scheme: 'ss', parsed, name, data: { ...credentials, server: host(parsed.hostname), port: integer(parsed.port, '节点端口') }, query }
}

/** Parse a supported share URI. This result contains secrets: never send it to the renderer. */
function parseShareUri(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 32768) invalid('节点链接为空或过长')
  let uri = raw.trim()
  if (/[\u0000-\u0020\u007f]/.test(uri) || /%(?![\da-f]{2})/i.test(uri)) invalid('节点链接包含空白、控制字符或无效编码')
  const schemeMatch = uri.match(/^([a-z][a-z\d+.-]*):\/\//i)
  if (!schemeMatch) invalid('节点分享链接格式无效')
  let scheme = schemeMatch[1].toLowerCase()
  if (scheme === 'hy2') scheme = 'hysteria2'
  if (!SCHEMES.has(scheme)) invalid('不支持的节点协议；请使用 Hysteria2、TUIC、VLESS、VMess、Trojan、SS、SOCKS5 或 HTTP(S)')
  uri = scheme + uri.slice(schemeMatch[1].length)
  if (scheme === 'ss') return parseShadowsocks(uri)
  if (scheme === 'vmess') {
    const payload = uri.slice(8)
    if (/[?#]/.test(payload)) invalid('VMess 链接必须使用 Base64 JSON 格式')
    let data
    const json = decodeBase64(payload, 'VMess 链接')
    try { data = JSON.parse(json) } catch { invalid('VMess 链接中的 JSON 无效') }
    if (!data || Array.isArray(data) || typeof data !== 'object') invalid('VMess 节点内容必须为对象')
    return { scheme, data, name: typeof data.ps === 'string' ? data.ps : '' }
  }
  let serverPorts
  if (scheme === 'hysteria2') {
    const authority = uri.match(/^hysteria2:\/\/([^/?#]+)/)?.[1] || ''
    const endpoint = authority.slice(authority.lastIndexOf('@') + 1)
    const portMatch = endpoint.match(/(?:\]|[^:]):([\d,-]+)$/)
    if (portMatch && /[,-]/.test(portMatch[1])) {
      serverPorts = portRanges(portMatch[1])
      const firstPort = serverPorts[0].split(':')[0]
      const updated = authority.slice(0, authority.length - portMatch[1].length) + firstPort
      uri = `hysteria2://${updated}${uri.slice('hysteria2://'.length + authority.length)}`
    }
  }
  let parsed
  try { parsed = new URL(uri) } catch { invalid('节点服务器地址或端口无效') }
  host(parsed.hostname)
  if (parsed.port) integer(parsed.port, '节点端口')
  if (parsed.pathname && parsed.pathname !== '/') invalid('分享链接的地址路径不受支持，请通过 path 参数指定传输路径')
  const name = parsed.hash ? decode(parsed.hash.slice(1), '节点名称') : ''
  return { scheme, parsed, name, serverPorts }
}

function tlsConfig(params, server, security, { quic = false, reality = false } = {}) {
  const serverName = params.take(TLS_ALIASES.sni, '')
  const insecure = params.take(TLS_ALIASES.insecure)
  const alpn = params.take('alpn', '')
  const fingerprint = params.take(TLS_ALIASES.fingerprint, '')
  if (params.take('pinSHA256')) invalid('当前核心不支持 Hysteria2 pinSHA256 整证书指纹；请使用证书校验或升级支持该功能的核心')
  const publicKey = params.take(['pbk', 'publicKey'], '')
  const shortId = params.take(['sid', 'shortId'], '')
  if (security === 'none') {
    if (serverName || alpn || fingerprint || publicKey || shortId || (insecure !== undefined && bool(insecure, 'insecure'))) invalid('TLS 未启用，但链接包含 TLS/Reality 参数')
    return undefined
  }
  const tls = { enabled: true, server_name: serverName || server, insecure: insecure === undefined || insecure === '' ? false : bool(insecure, 'insecure') }
  if (alpn) {
    tls.alpn = alpn.split(',').map((value) => value.trim())
    if (tls.alpn.some((value) => !value || Buffer.byteLength(value) > 255 || /[\u0000-\u001f\u007f]/.test(value))) invalid('ALPN 参数无效')
  }
  if (quic && fingerprint) invalid('QUIC 节点不支持 uTLS fingerprint 参数')
  if (fingerprint || reality) tls.utls = { enabled: true, fingerprint: oneOf(fingerprint || 'chrome', ['chrome', 'firefox', 'edge', 'safari', '360', 'qq', 'ios', 'android', 'random', 'randomized'], 'TLS 指纹') }
  if (reality) {
    if (!/^[\w-]{43}$/.test(publicKey) || Buffer.from(publicKey, 'base64url').length !== 32) invalid('Reality publicKey/pbk 必须为 32 字节 Base64URL 公钥')
    if (!/^(?:[\da-f]{2}){0,8}$/i.test(shortId)) invalid('Reality shortId/sid 必须为最多 16 位偶数长度十六进制字符')
    if (tls.insecure) invalid('Reality 不接受跳过验证参数 insecure')
    tls.reality = { enabled: true, public_key: publicKey, short_id: shortId }
  } else if (publicKey || shortId) invalid('节点包含 Reality 参数，但 security 不是 reality')
  return tls
}

function transportConfig(params) {
  let type = params.take(['type', 'net'], 'tcp') || 'tcp'
  if (type === 'h2') type = 'http'
  if (type === 'raw') type = 'tcp'
  oneOf(type, ['tcp', 'ws', 'grpc', 'http', 'httpupgrade'], '传输方式')
  const path = params.take('path', '')
  const hostHeader = params.take('host', '')
  const headerType = params.take(['headerType', 'header-type'], '')
  const serviceName = params.take(['serviceName', 'servicename', 'service_name'], '')
  const grpcMode = params.take('mode', '')
  const earlyData = params.take(['ed', 'maxEarlyData'])
  const earlyHeader = params.take(['eh', 'earlyDataHeaderName'], '')
  if (headerType && headerType !== 'none') invalid('暂不支持 TCP HTTP 伪装或其他 headerType；请使用 WS/gRPC 节点')
  if (type !== 'ws' && ((earlyData !== undefined && earlyData !== '') || earlyHeader)) invalid('early data 参数仅支持 WebSocket')
  if (type !== 'grpc' && (serviceName || grpcMode)) invalid('gRPC 参数与传输方式不匹配')
  if (type === 'tcp') {
    if (path || hostHeader) invalid('TCP 节点不能携带 WS/HTTP path 或 host 参数')
    return undefined
  }
  if (type === 'grpc') {
    if (grpcMode && grpcMode !== 'gun') invalid('暂不支持 gRPC multi 模式')
    if (path || hostHeader) invalid('gRPC 请使用 serviceName 与 sni；path/host 参数不受支持')
    return { type, service_name: serviceName }
  }
  if (path && !path.startsWith('/')) invalid('传输路径必须以 / 开头')
  const transport = { type, path: path || '/' }
  if (hostHeader) {
    if (/[\r\n]/.test(hostHeader)) invalid('Host 头包含无效字符')
    if (type === 'ws') transport.headers = { Host: hostHeader }
    else transport.host = type === 'http' ? hostHeader.split(',').map((h) => h.trim()) : hostHeader
  }
  if (type === 'ws') {
    // v2rayN also places ed in the WS path; remove it from the HTTP path
    // and translate it to sing-box's early-data settings.
    const pathUrl = new URL(transport.path, 'https://path.invalid')
    if (pathUrl.searchParams.getAll('ed').length > 1) invalid('WebSocket path 内 early data 参数重复')
    const embeddedEarly = pathUrl.searchParams.get('ed')
    if (embeddedEarly !== null && earlyData !== undefined && embeddedEarly !== earlyData) invalid('WebSocket early data 参数冲突')
    const maxEarly = earlyData === undefined ? embeddedEarly : earlyData
    if (maxEarly !== undefined && maxEarly !== null && maxEarly !== '') {
      transport.max_early_data = integer(maxEarly, 'WebSocket early data', 0, 65535)
      transport.early_data_header_name = earlyHeader || 'Sec-WebSocket-Protocol'
      if (embeddedEarly !== null) {
        pathUrl.searchParams.delete('ed')
        transport.path = pathUrl.pathname + pathUrl.search
      }
    } else if (earlyHeader) invalid('earlyDataHeaderName 需要同时提供 maxEarlyData')
  }
  return transport
}

function makeVmess(item) {
  const params = parameters(Object.entries(item.data))
  const version = params.take('v', '2')
  if (version && version !== '2') invalid('仅支持 VMess v2 JSON 分享格式')
  params.take('ps')
  const server = host(params.take('add'))
  const outbound = { type: 'vmess', tag: 'proxy', server, server_port: integer(params.take('port', '443'), '节点端口'), uuid: uuid(params.take('id')), security: oneOf(params.take(['scy', 'security'], 'auto') || 'auto', ['auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305', 'aes-128-ctr'], 'VMess 加密方式'), alter_id: integer(params.take(['aid', 'alterId'], '0') || '0', 'alterId', 0, 65535) }
  const transport = params.take('net', 'tcp') || 'tcp'
  const disguise = params.take('type', '')
  if (disguise && disguise !== 'none' && !(transport === 'grpc' && disguise === 'gun')) invalid('不支持 VMess 传输伪装 type 参数')
  const path = params.take('path', '')
  const hostHeader = params.take('host', '')
  const tlsMode = oneOf(params.take('tls', '') || 'none', ['none', 'tls'], 'VMess TLS 类型')
  // Older v2rayN VMess links used the transport Host as the TLS name before
  // the dedicated sni field was introduced. Explicit sni still takes priority.
  const tlsDefaultName = tlsMode === 'tls' && ['ws', 'h2', 'http', 'httpupgrade'].includes(transport) && hostHeader ? hostHeader.split(',')[0].trim() : server
  outbound.tls = tlsConfig(params, tlsDefaultName, tlsMode)
  const fields = [['type', transport]]
  if (transport === 'grpc') {
    fields.push(['serviceName', path])
    if (hostHeader) invalid('VMess gRPC host 不受支持；请使用 sni')
  } else fields.push(['path', path], ['host', hostHeader])
  const transParams = parameters(fields)
  outbound.transport = transportConfig(transParams)
  transParams.finish()
  params.finish()
  return outbound
}

function outboundFor(item) {
  if (item.scheme === 'vmess') return makeVmess(item)
  const p = item.parsed
  const params = parameters(item.query || p.searchParams.entries())
  const defaultPort = item.scheme === 'socks5' ? 1080 : item.scheme === 'http' ? 80 : 443
  const outbound = { type: item.scheme, tag: 'proxy', server: host(p.hostname), server_port: integer(p.port || defaultPort, '节点端口') }
  const username = decode(p.username, '认证信息')
  const password = decode(p.password, '密码')
  if (item.scheme === 'ss') {
    const plugin = params.take('plugin')
    if (plugin) invalid('暂不支持 Shadowsocks 插件，请使用不依赖插件的节点')
    outbound.type = 'shadowsocks'
    Object.assign(outbound, { server: item.data.server, server_port: item.data.port, method: item.data.method, password: item.data.password })
    if (!SS_METHODS.has(outbound.method)) invalid('当前核心不支持此 Shadowsocks 加密方式')
    if (outbound.method !== 'none') required(outbound.password, '密码')
    if (outbound.method.startsWith('2022-')) {
      const keyLength = outbound.method === '2022-blake3-aes-128-gcm' ? 16 : 32
      const keys = outbound.password.split(':')
      if (keys.some((key) => !/^[\w+/]+={0,2}$/.test(key) || Buffer.from(key, 'base64').length !== keyLength || Buffer.from(key, 'base64').toString('base64').replace(/=+$/, '') !== key.replace(/=+$/, ''))) invalid(`Shadowsocks 2022 密钥必须为 ${keyLength} 字节的 Base64；多用户密钥使用冒号连接`)
    }
  } else if (item.scheme === 'hysteria2') {
    const auth = params.take('auth')
    const userInfo = username + (p.password ? `:${password}` : '')
    if (auth !== undefined && userInfo && auth !== userInfo) invalid('Hysteria2 的 auth 与链接认证信息冲突')
    outbound.password = required(auth === undefined ? userInfo : auth, '认证信息')
    outbound.tls = tlsConfig(params, outbound.server, 'tls', { quic: true })
    const obfs = params.take('obfs', '')
    const obfsPassword = params.take(['obfs-password', 'obfsPassword'], '')
    if (obfs) outbound.obfs = { type: oneOf(obfs, ['salamander', 'gecko'], 'Hysteria2 混淆方式'), password: required(obfsPassword, '混淆密码') }
    else if (obfsPassword) invalid('指定混淆密码时必须同时指定 obfs')
    for (const [names, field] of [[['upmbps', 'up'], 'up_mbps'], [['downmbps', 'down'], 'down_mbps']]) {
      const bandwidth = params.take(names)
      if (bandwidth !== undefined) outbound[field] = integer(bandwidth, '带宽 Mbps', 1, 100000)
    }
    const multiPort = params.take(['mport', 'ports'])
    if (multiPort && item.serverPorts) invalid('端口跳跃参数重复')
    const ranges = multiPort ? portRanges(multiPort) : item.serverPorts
    if (ranges) { outbound.server_ports = ranges; delete outbound.server_port }
    const hop = params.take(['hop-interval', 'hopInterval'])
    if (hop) {
      if (!ranges) invalid('hopInterval 需要端口跳跃配置')
      outbound.hop_interval = duration(hop, '端口跳跃间隔')
    }
  } else if (item.scheme === 'tuic') {
    outbound.uuid = uuid(username)
    outbound.password = required(password, '密码')
    outbound.tls = tlsConfig(params, outbound.server, 'tls', { quic: true })
    const congestion = params.take(['congestion_control', 'congestion-control'])
    const relay = params.take(['udp_relay_mode', 'udp-relay-mode'])
    const overStream = params.take(['udp_over_stream', 'udp-over-stream'])
    const zeroRtt = params.take(['zero_rtt_handshake', 'zero-rtt-handshake'])
    const heartbeat = params.take('heartbeat')
    if (congestion) outbound.congestion_control = oneOf(congestion, ['cubic', 'new_reno', 'bbr'], '拥塞控制算法')
    if (relay) outbound.udp_relay_mode = oneOf(relay, ['native', 'quic'], 'UDP 转发模式')
    if (overStream !== undefined) outbound.udp_over_stream = bool(overStream, 'udp_over_stream')
    if (outbound.udp_over_stream && relay) invalid('udp_over_stream 不能与 udp_relay_mode 同时设置')
    if (zeroRtt !== undefined) outbound.zero_rtt_handshake = bool(zeroRtt, 'zero_rtt_handshake')
    if (heartbeat) outbound.heartbeat = duration(heartbeat, 'heartbeat')
  } else if (item.scheme === 'trojan' || item.scheme === 'vless') {
    if (password) invalid('该协议认证信息含有未转义的冒号，请将密码中的特殊字符进行 URL 编码')
    const security = oneOf(params.take('security', item.scheme === 'trojan' ? 'tls' : 'none') || 'none', item.scheme === 'vless' ? ['none', 'tls', 'reality'] : ['none', 'tls'], 'TLS 类型')
    outbound.tls = tlsConfig(params, outbound.server, security, { reality: security === 'reality' })
    outbound.transport = transportConfig(params)
    if (item.scheme === 'trojan') outbound.password = required(username, '密码')
    else {
      outbound.uuid = uuid(username)
      const encryption = params.take('encryption', 'none')
      if (encryption && encryption !== 'none') invalid('当前核心不支持 VLESS encryption 扩展')
      const flow = params.take('flow', '')
      if (flow) {
        oneOf(flow, ['xtls-rprx-vision'], 'VLESS flow')
        if (!outbound.tls || outbound.transport) invalid('xtls-rprx-vision 需要 TCP + TLS/Reality')
        outbound.flow = flow
      }
      const packet = params.take(['packetEncoding', 'packet_encoding'])
      if (packet !== undefined) outbound.packet_encoding = oneOf(packet, ['', 'xudp', 'packetaddr'], 'UDP 编码')
    }
  } else if (item.scheme === 'socks5' || item.scheme === 'http' || item.scheme === 'https') {
    if (username) outbound.username = username
    if (password) outbound.password = password
    if (item.scheme === 'socks5') { outbound.type = 'socks'; outbound.version = '5' }
    else {
      outbound.type = 'http'
      outbound.tls = tlsConfig(params, outbound.server, item.scheme === 'https' ? 'tls' : 'none')
    }
  }
  const network = params.take('network')
  if (network) {
    if (item.scheme === 'http' || item.scheme === 'https') invalid('HTTP 代理不支持 network 参数')
    outbound.network = oneOf(network, ['tcp', 'udp'], '网络类型')
  }
  params.finish()
  return outbound
}

/** Returns secret-free, validated metadata for an imported, non-private node. */
function describeNode(uri) {
  const item = parseShareUri(uri)
  const outbound = outboundFor(item)
  return {
    name: (item.name || `${item.scheme.toUpperCase()} · ${outbound.server}`).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120),
    protocol: item.scheme,
    server: outbound.server,
    port: outbound.server_port || Number(outbound.server_ports[0].split(':')[0]),
    transport: outbound.transport?.type || (['hysteria2', 'tuic'].includes(item.scheme) ? 'quic' : 'tcp'),
    tls: Boolean(outbound.tls?.enabled),
    insecure: Boolean(outbound.tls?.insecure),
  }
}

/**
 * Produces a sing-box 1.14 configuration. Pass a per-session random apiSecret
 * from main.cjs; if omitted, a secret is generated and included in the result.
 * bypass-local only bypasses private IPs. It is not a geographic routing mode.
 */
function singBoxConfig(uri, options = {}) {
  const { port = 10808, apiPort = 10809, apiSecret = '', mode = 'global' } = options
  const listenPort = integer(port, '本地代理端口')
  const controllerPort = integer(apiPort, '本地控制端口')
  if (listenPort === controllerPort) invalid('本地代理端口与控制端口不能相同')
  oneOf(mode, ['global', 'bypass-local'], '路由模式')
  if (typeof apiSecret !== 'string' || /[\r\n\u0000]/.test(apiSecret)) invalid('本地控制密钥无效')
  const outbound = outboundFor(parseShareUri(uri))
  return JSON.stringify({
    log: { level: 'warn' },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: listenPort }],
    outbounds: [outbound, { type: 'direct', tag: 'direct' }],
    route: { auto_detect_interface: true, rules: mode === 'bypass-local' ? [{ ip_is_private: true, action: 'route', outbound: 'direct' }] : [], final: 'proxy' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${controllerPort}`, secret: apiSecret || randomBytes(32).toString('hex'), default_mode: mode === 'global' ? 'global' : 'rule', access_control_allow_origin: [], access_control_allow_private_network: false } },
  }, null, 2)
}

module.exports = { parseShareUri, singBoxConfig, describeNode }
