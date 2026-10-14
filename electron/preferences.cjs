'use strict'

const fs=require('node:fs')
const path=require('node:path')
const crypto=require('node:crypto')

const DEFAULT_PROXY_PORT=10808
const validProxyPort=port=>Number.isInteger(port)&&port>=1&&port<=65535

function loadProxyPort(file) {
  try {
    const {proxyPort}=JSON.parse(fs.readFileSync(file,'utf8'))
    return validProxyPort(proxyPort)?proxyPort:DEFAULT_PROXY_PORT
  } catch { return DEFAULT_PROXY_PORT }
}

function saveProxyPort(file,proxyPort) {
  if(!validProxyPort(proxyPort)) throw new Error('本地代理端口必须为 1–65535 之间的整数')
  fs.mkdirSync(path.dirname(file),{recursive:true})
  const temporary=`${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary,JSON.stringify({proxyPort}),{mode:0o600})
    fs.renameSync(temporary,file)
  } finally {
    try { fs.unlinkSync(temporary) } catch(error) { if(error.code!=='ENOENT') throw error }
  }
}

module.exports={DEFAULT_PROXY_PORT,validProxyPort,loadProxyPort,saveProxyPort}
