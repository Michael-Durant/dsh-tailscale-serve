#!/usr/bin/env node
/**
 * Offline smoke test of the full apply() path against the *running* DSH:
 * starts the forwarder on a scratch port, forwards to the current DSH port,
 * opens a real connection through it and prints what happened. No DSH restart,
 * no change to Tailscale state (serve is disabled here).
 *
 *   node scripts/smoke.js --dsh-port 51741 --port 18081
 */
import http from 'node:http'
import { apply } from '../index.js'

const argv = process.argv.slice(2)
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? Number(argv[i + 1]) : fallback
}
const dshPort = opt('--dsh-port', 51741)
const port = opt('--port', 18081)

const bindIp = (await import('node:child_process')).execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split(/\s+/)[0]
const logs = []
const logger = () => ({
  info: (fmt, ...args) => { logs.push(['info', fmt, args]) },
  warn: (fmt, ...args) => { logs.push(['warn', fmt, args]) },
  error: (fmt, ...args) => { logs.push(['error', fmt, args]) },
})

const cleanups = []
const ctx = {
  logger,
  inject: (_services, callback) => callback({ webServer: { port: dshPort } }),
  effect: (fn) => { cleanups.push(fn) },
}

apply(ctx, { port, serve: false, allowedPeers: [], pairingCheck: 'auto', allowUnpaired: false })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await wait(4000)

const fetchStatus = (path, host) => new Promise((resolve) => {
  const req = http.get({ host: bindIp, port, path, timeout: 6000, headers: { host } }, (res) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (c) => { body += c })
    res.on('end', () => resolve({ status: res.statusCode, bytes: body.length }))
  })
  req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout' }) })
  req.on('error', (e) => resolve({ status: 'error:' + e.code }))
})

const result = await fetchStatus('/pair-app', '127.0.0.1')

console.log('--- plugin logs ---')
for (const [level, fmt, args] of logs) console.log(level, fmt, ...args)
console.log('--- through the forwarder ---')
console.log(JSON.stringify(result))
for (const fn of cleanups) { try { fn() } catch {} }
process.exit(result.status === 200 ? 0 : 1)