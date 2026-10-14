'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { singBoxConfig } = require('./protocols.cjs')
const { controller, freePort, httpProbe } = require('./core-manager.cjs')

const DEFAULT_URLS = ['https://www.gstatic.com/generate_204', 'https://www.apple.com/library/test/success.html']
const DEADLINE_MS = 18000 // Leave time to stop the owned processes and remove credentials.

function result(ok, latencyMs, message) {
  return { ok, latencyMs, message, checkedAt: new Date().toISOString() }
}

function cancelled(signal) {
  if (signal.aborted) throw new Error('cancelled')
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'))
    const abort = () => { clearTimeout(timer); reject(new Error('cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

// Only ever stop children created by this probe; no name-based process killing.
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve) => {
    let hardTimer, finalTimer
    const done = () => {
      clearTimeout(hardTimer); clearTimeout(finalTimer)
      child.removeListener('exit', done)
      resolve()
    }
    child.once('exit', done)
    hardTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finalTimer = setTimeout(done, 300)
    }, 500)
    try { child.kill() } catch { done() }
  })
}

class NodeProbe {
  constructor({ binary, directory, probeUrls = DEFAULT_URLS, onSpawn = async () => null }) {
    this.binary = binary
    this.directory = directory
    this.probeUrls = [...probeUrls]
    this.onSpawn = onSpawn
    this.jobs = new Set()
    this.closed = false
    this.closing = null
    if (!this.probeUrls.length || this.probeUrls.length > 3 || this.probeUrls.some((value) => {
      try { return !['http:', 'https:'].includes(new URL(value).protocol) } catch { return true }
    })) throw new Error('测速地址无效')
  }

  test(uri) {
    if (this.closed) return Promise.resolve(result(false, null, '测速已取消'))
    if (this.jobs.size >= 2) return Promise.resolve(result(false, null, '正在测试其他线路，请稍后重试'))
    const job = { abort: new AbortController(), check: null, child: null, guardian: null, cleaned: false, timedOut: false, folder: null }
    this.jobs.add(job)
    job.timer = setTimeout(() => { job.timedOut = true; job.abort.abort() }, DEADLINE_MS)
    job.promise = this.run(uri, job).finally(() => {
      clearTimeout(job.timer)
      this.jobs.delete(job)
    })
    return job.promise
  }

  async close() {
    if (this.closing) return this.closing
    this.closed = true
    const jobs = [...this.jobs]
    for (const job of jobs) job.abort.abort()
    this.closing = Promise.allSettled(jobs.map((job) => job.promise)).then(() => undefined)
    return this.closing
  }

  async checkConfig(configPath, job) {
    cancelled(job.abort.signal)
    const child = spawn(this.binary, ['check', '-c', configPath], { windowsHide: true, stdio: 'ignore' })
    job.check = child
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        job.abort.signal.removeEventListener('abort', abort)
        error ? reject(error) : resolve()
      }
      const abort = () => { try { child.kill() } catch {}; finish(new Error('cancelled')) }
      const timer = setTimeout(() => { try { child.kill() } catch {}; finish(new Error('config')) }, 4000)
      job.abort.signal.addEventListener('abort', abort, { once: true })
      child.once('error', () => finish(new Error('core')))
      child.once('exit', (code) => finish(code === 0 ? null : new Error('config')))
      if (job.abort.signal.aborted) abort()
    })
    cancelled(job.abort.signal)
  }

  async attachGuardian(job) {
    const signal = job.abort.signal
    cancelled(signal)
    await new Promise((resolve, reject) => {
      const abort = () => reject(new Error('cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve().then(() => this.onSpawn(job.child.pid)).then((guardian) => {
        // A hook may finish after cancellation. Never leave its late guardian
        // alive, and do not let it delay cancellation of the owned core.
        if (signal.aborted || job.cleaned) {
          try { if (guardian) guardian.kill() } catch {}
        } else job.guardian = guardian
        resolve()
      }, reject).finally(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    })
    cancelled(signal)
  }

  async run(uri, job) {
    const signal = job.abort.signal
    let outcome
    try {
      if (!this.binary || !fs.existsSync(this.binary)) return result(false, null, '安装包缺少代理核心，请重新安装完整版本')
      cancelled(signal)
      const port = await freePort()
      let apiPort = await freePort()
      while (apiPort === port) apiPort = await freePort()
      cancelled(signal)
      const secret = crypto.randomBytes(32).toString('hex')
      let config
      try { config = singBoxConfig(uri, { port, apiPort, apiSecret: secret, mode: 'global' }) }
      catch { return result(false, null, '线路配置无效，请检查链接和协议参数') }
      fs.mkdirSync(this.directory, { recursive: true })
      job.folder = fs.mkdtempSync(path.join(this.directory, 'probe-'))
      const configPath = path.join(job.folder, 'config.json')
      fs.writeFileSync(configPath, config, { mode: 0o600 })
      await this.checkConfig(configPath, job)
      cancelled(signal)
      const child = spawn(this.binary, ['run', '-c', configPath], { windowsHide: true, stdio: 'ignore' })
      job.child = child
      let spawnError = false
      child.once('error', () => { spawnError = true })
      if (!child.pid) throw new Error('core')
      await this.attachGuardian(job)
      const readyDeadline = Date.now() + 4000
      let ready = false
      while (Date.now() < readyDeadline) {
        cancelled(signal)
        if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('core')
        try { await controller(apiPort, secret, '/version', 350, signal); ready = true; break }
        catch { await wait(75, signal) }
      }
      if (!ready) throw new Error('core')
      // sing-box has parsed its configuration; it does not need credentials on
      // disk while the network request is in flight.
      fs.unlinkSync(configPath)
      for (const url of this.probeUrls) {
        cancelled(signal)
        try {
          let latency
          if (url.startsWith('http://')) {
            const start = performance.now()
            await httpProbe(port, url, 5000, signal)
            latency = Math.max(1, Math.round(performance.now() - start))
          } else {
            // Address the exact outbound tag, not whichever route is selected
            // by the running application's normal connection.
            const data = await controller(apiPort, secret, `/proxies/proxy/delay?url=${encodeURIComponent(url)}&timeout=5000`, 5500, signal)
            if (!Number.isFinite(data.delay) || data.delay < 0) throw new Error('unreachable')
            latency = Math.round(data.delay)
          }
          cancelled(signal)
          outcome = result(true, latency, '线路可用')
          break
        } catch { cancelled(signal) }
      }
      if (!outcome) outcome = result(false, null, '线路暂时无法连通，请稍后重试')
    } catch (error) {
      if (signal.aborted) outcome = result(false, null, job.timedOut ? '测速超时，请稍后重试' : '测速已取消')
      else if (error.message === 'config') outcome = result(false, null, '线路配置未通过核心校验')
      else outcome = result(false, null, '测速核心未能启动，请稍后重试')
    } finally {
      // Stop both the validator and runner before removing their temporary files.
      await Promise.all([stopChild(job.check), stopChild(job.child)])
      job.cleaned = true
      if (job.guardian) { try { job.guardian.kill() } catch {}; job.guardian = null }
      if (job.folder) {
        try { fs.rmSync(job.folder, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }) }
        catch { outcome = result(false, null, '测速临时文件清理失败，请退出软件后重试') }
      }
    }
    return outcome
  }
}

module.exports = { NodeProbe }
