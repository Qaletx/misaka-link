'use strict'

const { lookup } = require('node:dns').promises
const { isIP } = require('node:net')
const { describeNode } = require('./protocols.cjs')

class NodeAddresses {
  constructor({ resolve = lookup, timeout = 2500, ttl = 60000 } = {}) {
    Object.assign(this, { resolve, timeout, ttl }); this.cache = new Map()
  }
  async ips(host) {
    if (isIP(host)) return [host]
    const cached = this.cache.get(host)
    if (cached && cached.expires > Date.now()) return cached.promise
    let timer
    const promise = Promise.race([
      Promise.resolve().then(() => this.resolve(host, { all: true })).then(items => [...new Set(items.map(item => item.address).filter(address => isIP(address)))]),
      new Promise(resolve => { timer = setTimeout(() => resolve([]), this.timeout) }),
    ]).catch(() => []).finally(() => clearTimeout(timer))
    if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value)
    this.cache.set(host, { expires: Date.now() + this.ttl, promise })
    return promise
  }
  async describe(nodes) {
    if (!Array.isArray(nodes) || nodes.length > 200) return []
    // Do not fetch /config, inspect or resolve any private node, even if a
    // stale client happens to include a URI or old public metadata for it.
    const queue = nodes.filter(node => node && !node.private && typeof node.id === 'string' && node.id.length <= 200 && typeof node.uri === 'string' && node.uri.length <= 32768)
    const result = new Array(queue.length); let cursor = 0
    const deadline = Date.now() + this.timeout * 2
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (cursor < queue.length) {
        const index = cursor++, node = queue[index]
        try {
          const { server, port } = describeNode(node.uri)
          result[index] = { id: node.id, server, port, ips: isIP(server) ? [server] : Date.now() < deadline ? await this.ips(server) : [] }
        } catch { result[index] = { id: node.id, unavailable: true } }
      }
    }))
    return result
  }
}

module.exports = { NodeAddresses }
