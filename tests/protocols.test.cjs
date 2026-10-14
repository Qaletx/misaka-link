'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { parseShareUri, singBoxConfig, describeNode } = require('../electron/protocols.cjs')

// All credentials are invented fixtures. Checks do not dial proxy servers.
const ID = '11111111-2222-4333-8444-555555555555'
const PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64url')
const API_SECRET = 'offline-test-controller-secret'
const base64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const vmess = (extra = {}) => `vmess://${base64(JSON.stringify({ v: '2', ps: '测试节点', add: 'example.invalid', port: '443', id: ID, aid: '0', net: 'tcp', type: 'none', tls: '', ...extra }))}`
const config = (uri, options = {}) => JSON.parse(singBoxConfig(uri, { apiSecret: API_SECRET, ...options }))
const outbound = (uri) => config(uri).outbounds[0]

test('Hysteria2 alias, credentials, TLS and obfuscation survive decoding', () => {
  const uri = 'hy2://alice:p%40ss%3Aword@example.invalid:1443/?sni=tls.example.invalid&insecure=1&obfs=salamander&obfs-password=mask%2Bsecret#%E6%B5%8B%E8%AF%95'
  const item = parseShareUri(uri)
  assert.equal(item.scheme, 'hysteria2')
  assert.equal(item.name, '测试')
  const node = outbound(uri)
  assert.equal(node.password, 'alice:p@ss:word')
  assert.deepEqual(node.tls, { enabled: true, server_name: 'tls.example.invalid', insecure: true })
  assert.deepEqual(node.obfs, { type: 'salamander', password: 'mask+secret' })
  assert.equal(node.server_port, 1443)
})

test('Hysteria2 supports auth parameters and percent-encoded userpass', () => {
  assert.equal(outbound('hysteria2://example.invalid?auth=alice%3Ap%40ss').password, 'alice:p@ss')
  assert.equal(outbound('hysteria2://alice%3Ap%40ss@example.invalid').password, 'alice:p@ss')
  assert.throws(() => outbound('hy2://first@example.invalid?auth=second'), /冲突/)
})

test('Hysteria2 supports IPv6 and multi-port ranges', () => {
  const node = outbound('hy2://test@[2001:db8::1]:443,10000-10100/?hopInterval=10s')
  assert.equal(node.server, '2001:db8::1')
  assert.deepEqual(node.server_ports, ['443:443', '10000:10100'])
  assert.equal(node.server_port, undefined)
  assert.equal(node.hop_interval, '10s')
  assert.throws(() => outbound('hy2://test@example.invalid?mport=2000-1000'), /结束端口/)
})

test('Hysteria2 certificate pin is never confused with public-key pin', () => {
  assert.throws(() => outbound('hy2://test@example.invalid?pinSHA256=0123456789abcdef'), /整证书指纹/)
})

test('TUIC preserves QUIC parameters and TLS certificate policy', () => {
  const node = outbound(`tuic://${ID}:secret%2Bkey@example.invalid:10443?congestion_control=bbr&udp_relay_mode=quic&alpn=h3&zero_rtt_handshake=false&heartbeat=10s`)
  assert.equal(node.uuid, ID)
  assert.equal(node.password, 'secret+key')
  assert.equal(node.congestion_control, 'bbr')
  assert.equal(node.udp_relay_mode, 'quic')
  assert.equal(node.zero_rtt_handshake, false)
  assert.equal(node.heartbeat, '10s')
  assert.deepEqual(node.tls.alpn, ['h3'])
  assert.equal(node.tls.insecure, false)
})

test('VLESS is plaintext unless TLS is explicitly requested', () => {
  const node = outbound(`vless://${ID}@example.invalid:80?encryption=none`)
  assert.equal(node.tls, undefined)
  assert.equal(node.transport, undefined)
  assert.equal(node.uuid, ID)
})

test('VLESS Reality preserves key, short ID, fingerprint and flow', () => {
  const node = outbound(`vless://${ID}@192.0.2.10:443?security=reality&pbk=${PUBLIC_KEY}&sid=01234567&sni=tls.example.invalid&fp=chrome&flow=xtls-rprx-vision`)
  assert.deepEqual(node.tls.reality, { enabled: true, public_key: PUBLIC_KEY, short_id: '01234567' })
  assert.deepEqual(node.tls.utls, { enabled: true, fingerprint: 'chrome' })
  assert.equal(node.flow, 'xtls-rprx-vision')
})

test('VLESS WS translates early data embedded in the path', () => {
  const node = outbound(`vless://${ID}@example.invalid?security=tls&type=ws&path=%2Fsocket%3Fed%3D2048&host=cdn.example.invalid&alpn=h2%2Chttp%2F1.1`)
  assert.deepEqual(node.transport, { type: 'ws', path: '/socket', headers: { Host: 'cdn.example.invalid' }, max_early_data: 2048, early_data_header_name: 'Sec-WebSocket-Protocol' })
  assert.deepEqual(node.tls.alpn, ['h2', 'http/1.1'])
})

test('Trojan websocket and grpc parameters are preserved', () => {
  const ws = outbound('trojan://p%3A%40ss@example.invalid?type=ws&path=%2Fproxy&host=cdn.example.invalid')
  assert.equal(ws.password, 'p:@ss')
  assert.equal(ws.tls.enabled, true)
  assert.deepEqual(ws.transport, { type: 'ws', path: '/proxy', headers: { Host: 'cdn.example.invalid' } })
  const grpc = outbound('trojan://secret@example.invalid?type=grpc&serviceName=stream&mode=gun')
  assert.deepEqual(grpc.transport, { type: 'grpc', service_name: 'stream' })
})

test('VMess JSON decodes metadata and TLS websocket settings', () => {
  const uri = vmess({ net: 'ws', tls: 'tls', sni: 'tls.example.invalid', host: 'cdn.example.invalid', path: '/socket', scy: 'aes-128-gcm', allowInsecure: false })
  const node = outbound(uri)
  assert.equal(node.security, 'aes-128-gcm')
  assert.equal(node.alter_id, 0)
  assert.deepEqual(node.transport, { type: 'ws', path: '/socket', headers: { Host: 'cdn.example.invalid' } })
  assert.equal(node.tls.server_name, 'tls.example.invalid')
  assert.equal(node.tls.insecure, false)
  assert.equal(describeNode(uri).name, '测试节点')
})

test('VMess gRPC maps path to service_name, preserves alter ID', () => {
  const node = outbound(vmess({ net: 'grpc', type: 'gun', path: 'stream', aid: '1' }))
  assert.deepEqual(node.transport, { type: 'grpc', service_name: 'stream' })
  assert.equal(node.alter_id, 1)
})

test('VMess uses transport Host for old TLS links while preserving explicit SNI', () => {
  assert.equal(outbound(vmess({ net: 'ws', tls: 'tls', host: 'cdn.example.invalid' })).tls.server_name, 'cdn.example.invalid')
  assert.equal(outbound(vmess({ net: 'ws', tls: 'tls', host: 'cdn.example.invalid', sni: 'sni.example.invalid' })).tls.server_name, 'sni.example.invalid')
})

test('SS SIP002 supports base64 userinfo without altering case or password punctuation', () => {
  const node = outbound(`ss://${base64('aes-256-gcm:p@ss:WithCAPS')}@example.invalid:8388#Example`)
  assert.equal(node.type, 'shadowsocks')
  assert.equal(node.method, 'aes-256-gcm')
  assert.equal(node.password, 'p@ss:WithCAPS')
  assert.equal(node.server_port, 8388)
})

test('SS SIP002 supports percent-encoded plain credentials and 2022 keys', () => {
  const key = Buffer.alloc(16, 3).toString('base64')
  const node = outbound(`ss://2022-blake3-aes-128-gcm:${encodeURIComponent(key)}@[2001:db8::2]:8388/`)
  assert.equal(node.password, key)
  assert.equal(node.server, '2001:db8::2')
})

test('SS legacy all-base64 supports password @ and colon', () => {
  const uri = `ss://${base64('chacha20-ietf-poly1305:p@ss:Word@192.0.2.1:8388')}#Legacy`
  const node = outbound(uri)
  assert.equal(node.password, 'p@ss:Word')
  assert.equal(node.server, '192.0.2.1')
  assert.equal(describeNode(uri).name, 'Legacy')
})

test('SOCKS5 uses sing-box socks type, correct version and default port', () => {
  const node = outbound('socks5://alice:p%40ss@example.invalid')
  assert.equal(node.type, 'socks')
  assert.equal(node.version, '5')
  assert.equal(node.server_port, 1080)
  assert.equal(node.username, 'alice')
  assert.equal(node.password, 'p@ss')
})

test('HTTP and HTTPS preserve distinct transport security and standard ports', () => {
  const http = outbound('http://alice:secret@example.invalid')
  const https = outbound('https://alice:secret@example.invalid?sni=tls.example.invalid')
  assert.equal(http.type, 'http')
  assert.equal(http.server_port, 80)
  assert.equal(http.tls, undefined)
  assert.equal(https.type, 'http')
  assert.equal(https.server_port, 443)
  assert.equal(https.tls.server_name, 'tls.example.invalid')
})

test('metadata does not contain credentials or original link', () => {
  const info = describeNode('trojan://secret-test-pass@example.invalid:8443#Office')
  assert.deepEqual(info, { name: 'Office', protocol: 'trojan', server: 'example.invalid', port: 8443, transport: 'tcp', tls: true, insecure: false })
  assert.ok(!JSON.stringify(info).includes('secret-test-pass'))
})

test('controller only listens on loopback, requires auth, and supports independent ports', () => {
  const result = config('socks5://example.invalid', { port: 18080, apiPort: 18081 })
  assert.deepEqual(result.inbounds[0], { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 18080 })
  assert.equal(result.experimental.clash_api.external_controller, '127.0.0.1:18081')
  assert.equal(result.experimental.clash_api.secret, API_SECRET)
  assert.deepEqual(result.experimental.clash_api.access_control_allow_origin, [])
  const first = JSON.parse(singBoxConfig('socks5://example.invalid')).experimental.clash_api.secret
  const second = JSON.parse(singBoxConfig('socks5://example.invalid')).experimental.clash_api.secret
  assert.equal(first.length, 64)
  assert.notEqual(first, second)
})

test('bypass-local only bypasses private IPs; global has no bypass rules', () => {
  assert.deepEqual(config('socks5://example.invalid', { mode: 'bypass-local' }).route.rules, [{ ip_is_private: true, action: 'route', outbound: 'direct' }])
  assert.deepEqual(config('socks5://example.invalid').route.rules, [])
  assert.equal(config('socks5://example.invalid').route.final, 'proxy')
  assert.throws(() => config('socks5://example.invalid', { mode: 'china' }), /路由模式/)
})

const invalidCases = [
  ['unsupported scheme', 'wireguard://example.invalid', /不支持的节点协议/],
  ['unknown parameter', 'hy2://test@example.invalid?surprise=secret', /不支持节点参数/],
  ['duplicate parameter', 'hy2://test@example.invalid?sni=a&sni=b', /重复/],
  ['conflicting aliases', 'hy2://test@example.invalid?insecure=true&allowInsecure=false', /冲突/],
  ['invalid boolean', 'hy2://test@example.invalid?insecure=sometimes', /true\/false/],
  ['invalid port', 'trojan://test@example.invalid:99999', /端口/],
  ['zero port', 'trojan://test@example.invalid:0', /端口/],
  ['missing password', 'hy2://example.invalid', /认证信息/],
  ['missing obfs password', 'hy2://test@example.invalid?obfs=salamander', /混淆密码/],
  ['unknown obfs', 'hy2://test@example.invalid?obfs=unknown&obfs-password=x', /混淆方式/],
  ['unsupported SS plugin', `ss://${base64('aes-128-gcm:pass')}@example.invalid:8388?plugin=v2ray-plugin%3Btls`, /插件/],
  ['invalid base64', 'ss://bad**base64', /Base64/],
  ['invalid vmess json', `vmess://${base64('{broken')}`, /JSON/],
  ['vmess unexpected extension', vmess({ mux: true }), /不支持节点参数/],
  ['unsupported transport', `vless://${ID}@example.invalid?type=kcp`, /传输方式/],
  ['reality missing key', `vless://${ID}@example.invalid?security=reality`, /公钥/],
  ['reality invalid short id', `vless://${ID}@example.invalid?security=reality&pbk=${PUBLIC_KEY}&sid=abc`, /shortId/],
  ['TLS mismatch', `vless://${ID}@example.invalid?sni=tls.example.invalid`, /TLS 未启用/],
  ['vision websocket conflict', `vless://${ID}@example.invalid?security=tls&type=ws&flow=xtls-rprx-vision`, /TCP/],
  ['plaintext encryption extension', `vless://${ID}@example.invalid?encryption=unsupported`, /encryption/],
  ['invalid uuid', 'vless://not-a-uuid@example.invalid', /UUID/],
  ['grpc multi unsupported', 'trojan://test@example.invalid?type=grpc&mode=multi', /multi/],
  ['unescaped colon in trojan password', 'trojan://user:password@example.invalid', /冒号/],
  ['TUIC conflicting relay settings', `tuic://${ID}:test@example.invalid?udp_over_stream=true&udp_relay_mode=native`, /同时设置/],
  ['QUIC uTLS unsupported', 'hy2://test@example.invalid?fp=chrome', /QUIC/],
  ['unsupported TLS fingerprint', 'trojan://test@example.invalid?fp=not-a-browser', /TLS 指纹/],
  ['SS 2022 invalid key', 'ss://2022-blake3-aes-128-gcm:password@example.invalid:8388', /密钥/],
  ['WS repeated early data', `vless://${ID}@example.invalid?type=ws&path=%2Fsocket%3Fed%3D1%26ed%3D2`, /重复/],
  ['malformed percent encoding', 'trojan://test%zz@example.invalid', /编码/],
  ['raw newline in URI', 'trojan://test@example.invalid\n?insecure=1', /空白/],
  ['path lost by generic parser', 'https://example.invalid/a-secret-endpoint', /地址路径/],
]
for (const [name, uri, error] of invalidCases) test(`rejects ${name}`, () => assert.throws(() => config(uri), error))

test('local config options fail before binding unsafe/invalid ports', () => {
  assert.throws(() => config('http://example.invalid', { port: 0 }), /端口/)
  assert.throws(() => config('http://example.invalid', { port: 10809 }), /不能相同/)
  assert.throws(() => config('http://example.invalid', { apiSecret: 'bad\nvalue' }), /控制密钥/)
})

const corePath = process.env.QALETX_TEST_CORE || path.join(__dirname, '..', 'core', process.platform === 'win32' ? 'sing-box.exe' : process.platform === 'darwin' ? `sing-box-${process.arch === 'arm64' ? 'arm64' : 'amd64'}` : 'sing-box')
const coreCases = [
  ['hysteria2', 'hy2://test@example.invalid:443?sni=tls.example.invalid&obfs=salamander&obfs-password=test-mask&up=10&down=100'],
  ['hysteria2-port-hopping', 'hy2://test@[2001:db8::1]:443,10000-10100/?hopInterval=10s'],
  ['hysteria2-gecko', 'hy2://test@example.invalid?obfs=gecko&obfs-password=test-mask'],
  ['tuic', `tuic://${ID}:test@example.invalid?congestion_control=bbr&udp_relay_mode=quic&alpn=h3&zero_rtt_handshake=false&heartbeat=10s`],
  ['vless-plaintext', `vless://${ID}@example.invalid:80?encryption=none`],
  ['vless-reality', `vless://${ID}@192.0.2.10:443?security=reality&pbk=${PUBLIC_KEY}&sid=01234567&sni=tls.example.invalid&flow=xtls-rprx-vision`],
  ['vless-ws', `vless://${ID}@example.invalid?security=tls&type=ws&path=%2Fws%3Fed%3D2048&host=cdn.example.invalid`],
  ['vless-http', `vless://${ID}@example.invalid?security=tls&type=http&path=%2Fproxy&host=cdn.example.invalid`],
  ['vless-httpupgrade', `vless://${ID}@example.invalid?security=tls&type=httpupgrade&path=%2Fproxy&host=cdn.example.invalid`],
  ['trojan-ws', 'trojan://test@example.invalid?type=ws&path=%2Fws&host=cdn.example.invalid'],
  ['trojan-grpc', 'trojan://test@example.invalid?type=grpc&serviceName=stream'],
  ['vmess', vmess({ net: 'ws', tls: 'tls', host: 'cdn.example.invalid', path: '/socket', scy: 'aes-128-gcm' })],
  ['ss-sip002', `ss://${base64('aes-256-gcm:p@ss:Word')}@example.invalid:8388`],
  ['ss-legacy', `ss://${base64('chacha20-ietf-poly1305:pass@192.0.2.1:8388')}`],
  ['ss-2022', `ss://2022-blake3-aes-128-gcm:${encodeURIComponent(Buffer.alloc(16, 3).toString('base64'))}@example.invalid:8388`],
  ['socks5', 'socks5://test:pass@example.invalid:1080'],
  ['http', 'http://test:pass@example.invalid:8080'],
  ['https', 'https://test:pass@example.invalid:443?sni=tls.example.invalid'],
]

test('bundled sing-box validates every supported protocol fixture offline', { skip: !fs.existsSync(corePath) && !process.env.QALETX_TEST_CORE }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qaletx-protocol-check-'))
  try {
    for (const [name, uri] of coreCases) {
      await t.test(name, () => {
        const file = path.join(directory, `${name}.json`)
        fs.writeFileSync(file, singBoxConfig(uri, { apiSecret: API_SECRET, mode: 'bypass-local' }))
        const result = spawnSync(corePath, ['check', '-c', file], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
        assert.ifError(result.error)
        assert.equal(result.status, 0, `sing-box check failed for ${name}: ${result.stderr || result.stdout}`)
      })
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
