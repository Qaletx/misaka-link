const fs = require('fs')
const path = require('path')

const value = String(process.env.QALETX_PRIVATE_NODE_URI || '').trim()
if (value && !/^(hysteria2|hy2):\/\//i.test(value)) throw new Error('QALETX_PRIVATE_NODE_URI must be a Hysteria2 share URL')
const target = path.join(__dirname, '..', 'electron', 'private-node.cjs')
if (!value && fs.existsSync(target)) {
  const existing = require(target)
  if (existing.misaka) { console.log('Using the existing local private-node configuration.'); process.exit(0) }
}
if (!value && process.env.CI) throw new Error('Set the QALETX_PRIVATE_NODE_URI repository secret before building the customer release')
fs.writeFileSync(target, `module.exports = Object.freeze({ misaka: ${JSON.stringify(value)} })\n`, 'utf8')
console.log(value ? 'Private node injected for this build.' : 'No private node provided; the built client will show the private slot as unavailable.')
