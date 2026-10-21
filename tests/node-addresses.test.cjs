'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { NodeAddresses } = require('../electron/node-addresses.cjs')
const node = (id, uri, privateNode = false) => ({ id, uri, private: privateNode })

test('IPv4, bracketed IPv6, VMess and SS expose only endpoint metadata', async () => {
  const vmess = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'fixture', add: '192.0.2.20', port: '443', id: '00000000-0000-4000-8000-000000000001', aid: '0', net: 'tcp', type: 'none', tls: '' })).toString('base64')
  const nodes = [node('ip', 'hysteria2://secret@192.0.2.1:443?sni=example.com'), node('ipv6', 'socks5://user:secret@[2001:db8::1]:1080'), node('ss', 'ss://' + Buffer.from('aes-128-gcm:secret').toString('base64') + '@192.0.2.2:8388'), node('vmess', vmess)]
  const reader = new NodeAddresses({ resolve: () => { throw new Error('IP must not use DNS') } })
  const result = await reader.describe(nodes)
  assert.deepEqual(result.map(x => x.server), ['192.0.2.1', '2001:db8::1', '192.0.2.2', '192.0.2.20'])
  assert.deepEqual(result.map(x => x.port), [443, 1080, 8388, 443])
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('private endpoints are never parsed or sent to DNS, even when stale public fields are present', async () => {
  let calls = 0
  const reader = new NodeAddresses({ resolve: async () => { calls++; return [] } })
  assert.deepEqual(await reader.describe([node('private', 'hysteria2://secret@hidden.example:443', true)]), [])
  assert.equal(calls, 0)
})

test('domain IPs are resolved and cached without copying passwords or query parameters', async () => {
  let calls = 0
  const reader = new NodeAddresses({ resolve: async () => { calls++; return [{ address: '192.0.2.8', family: 4 }, { address: '2001:db8::8', family: 6 }] } })
  const input = [node('one', 'trojan://secret@node.example:443?sni=other.example'), node('two', 'http://user:secret@node.example:8443')]
  const result = await reader.describe(input)
  assert.deepEqual(result[0].ips, ['192.0.2.8', '2001:db8::8']); assert.equal(calls, 1)
  await reader.describe(input); assert.equal(calls, 1)
  assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(JSON.stringify(result).includes('other.example'), false)
})

test('DNS stalls and malformed imports keep the configured domain and finish without blocking connection', async () => {
  const reader = new NodeAddresses({ timeout: 10, resolve: () => new Promise(() => {}) })
  const result = await reader.describe([node('domain', 'socks5://node.example:1080'), node('invalid', 'invalid://secret')])
  assert.equal(result[0].server, 'node.example'); assert.deepEqual(result[0].ips, [])
  assert.deepEqual(result[1], { id: 'invalid', unavailable: true })
})
