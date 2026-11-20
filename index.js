/**
 * dsh-tailscale-serve
 *
 * Exposes the running DSH web server on the machine's Tailscale address only.
 * Two independent paths are created:
 *
 *   1. `tailscale serve` (tailnet-only HTTPS, optional) -> 127.0.0.1:<dsh port>
 *   2. a raw TCP forwarder on <tailnet ip>:<port> -> 127.0.0.1:<dsh port>
 *
 * Security posture (all enforced in code, see README "Security model"):
 *   - the listener can only bind a Tailscale address; 0.0.0.0 and LAN addresses
 *     are rejected unless allowNonTailnet is explicitly enabled;
 *   - the plugin refuses to expose DSH when no pairing gate answers at
 *     /pair-app, unless allowUnpaired is explicitly enabled;
 *   - an optional peer allowlist restricts which tailnet devices may connect.
 *
 * The plugin deliberately implements no authentication of its own: DSH's
 * pairing gate (or whatever you put in front of it) stays the only credential
 * check, so this package cannot silently weaken it.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { format } from 'node:util'
import { isTailnetAddress } from './lib/net-guard.js'
import { createForwarder } from './lib/forwarder.js'

export const name = 'dsh-tailscale-serve'

const DEFAULTS = {
  port: 8081,
  serve: true,
  pairingCheck: 'auto',
  allowUnpaired: false,
  allowNonTailnet: false,
  allowedPeers: [],
  tailscaleBin: '',
  maxConnections: 64,
  retries: 6,
  retryMs: 3000,
  // Startup is retried because DSH boots plugins before its own HTTP listener
  // accepts connections and because a previous forwarder may still hold the port.
  startAttempts: 400,
  startRetryMs: 1500,
  // '' = the default log file, false = no file logging.
  logFile: '',
}

const LOG_MAX_BYTES = 1024 * 1024

export function apply (ctx, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const fileLog = createFileLog(cfg)
  // DSH loggers take a plain string; format here so %s placeholders behave.
  const log = (level, fmt, ...args) => {
    const line = format(fmt, ...args)
    fileLog(level, line)
    ctx.logger?.('dsh-tailscale-serve')?.[level]?.(line)
  }

  log('info', 'starting (attempt window %d x %d ms = %d min)', cfg.startAttempts, cfg.startRetryMs, Math.round(cfg.startAttempts * cfg.startRetryMs / 60000))
  ctx.inject(['webServer'], (scope) => {
    const port = scope?.webServer?.port
    if (!port) {
      log('warn', 'webServer port not available yet; waiting for the next start')
      return
    }
    bootstrap(port, cfg, ctx, log)
  })
}

/**
 * Retry the whole startup instead of giving up on the first refused probe.
 *
 * On a cold DSH start the web server reports its port before it accepts
 * connections, so the /pair-app gate probe can answer ECONNREFUSED. The port
 * can also be held by a forwarder left behind by the previous process. Both
 * are transient, so the plugin keeps trying for cfg.startAttempts rounds and
 * only leaves the port closed (fail closed) when the window is exhausted.
 */
async function bootstrap (port, cfg, ctx, log) {
  let lastReason = 'no attempt yet'
  for (let attempt = 1; attempt <= cfg.startAttempts; attempt += 1) {
    const result = await attemptStart(port, cfg, ctx, log)
    if (result.ok) return
    lastReason = result.reason
    if (attempt <= 5 || attempt % 10 === 0) log('info', 'startup attempt %d/%d: %s', attempt, cfg.startAttempts, result.reason)
    if (attempt < cfg.startAttempts) await delay(cfg.startRetryMs)
  }
  log('error', 'giving up after %d attempts: %s. Port stays closed.', cfg.startAttempts, lastReason)
}

async function attemptStart (port, cfg, ctx, log) {
  const bin = await detectBin(cfg.tailscaleBin)
  if (!bin) return { ok: false, reason: 'tailscale CLI not found; install Tailscale or set tailscaleBin' }

  const ip = await tailnetAddress(bin)
  if (!ip) return { ok: false, reason: 'no Tailscale IPv4 address yet (is Tailscale up and logged in?)' }
  if (!isTailnetAddress(ip) && !cfg.allowNonTailnet) {
    return { ok: false, reason: `refusing to bind ${ip}: not a CGNAT/tailnet address (100.64.0.0/10)` }
  }

  const gate = cfg.pairingCheck === 'off' ? { skipped: true, present: false } : await probePairingGate(port)
  if (!gate.skipped && !gate.present && !cfg.allowUnpaired) {
    return { ok: false, reason: `no pairing gate answered at /pair-app (status ${gate.status ?? 'none'})` }
  }
  if (!gate.present && cfg.allowUnpaired) {
    log('warn', 'SECURITY: allowUnpaired is on — any device on your tailnet can open this DSH without a pairing token.')
  }

  const forwarder = createForwarder({
    bindAddress: ip,
    port: cfg.port,
    targetPort: port,
    allowedPeers: cfg.allowedPeers,
    maxConnections: cfg.maxConnections,
    log,
  })

  const bound = await listenOnce(forwarder)
  if (!bound.ok) {
    forwarder.close()
    return bound
  }

  ctx.effect(() => () => { forwarder.close() }, 'dsh-tailscale-serve: tailnet forwarder')
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => { forwarder.close() })
  }

  if (cfg.serve) pointServe(bin, port, cfg, log)

  log('info', 'ready: http://%s:%d  gate=%s  peers=%s', ip, cfg.port, gate.skipped ? 'check-disabled' : gate.present ? 'paired' : 'UNPAIRED', cfg.allowedPeers.length ? cfg.allowedPeers.join(',') : 'any-tailnet-device')
  return { ok: true }
}

function listenOnce (forwarder) {
  return new Promise((resolve) => {
    const server = forwarder.server
    const cleanup = () => {
      server.off('error', onError)
      server.off('listening', onListening)
    }
    const onError = (error) => { cleanup(); resolve({ ok: false, reason: `forwarder bind failed on port: ${error.code ?? error.message}` }) }
    const onListening = () => { cleanup(); resolve({ ok: true }) }
    server.once('error', onError)
    server.once('listening', onListening)
    forwarder.listen()
  })
}

function delay (ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Mirror the DSH logger into a log file so a desktop app that swallows stderr
 * still leaves evidence of what the plugin did at boot.
 */
function createFileLog (cfg) {
  if (cfg.logFile === false) return () => {}
  const target = typeof cfg.logFile === 'string' && cfg.logFile !== ''
    ? cfg.logFile
    : path.join(os.homedir(), '.dsh', 'logs', 'dsh-tailscale-serve.log')
  let prepared = false
  return (level, line) => {
    try {
      if (!prepared) {
        prepared = true
        fs.mkdirSync(path.dirname(target), { recursive: true })
        try {
          if (fs.statSync(target).size > LOG_MAX_BYTES) fs.writeFileSync(target, '')
        } catch {}
      }
      fs.appendFileSync(target, `${new Date().toISOString()} ${level.padEnd(5)} ${line}\n`)
    } catch {}
  }
}

function canRun (bin) {
  return new Promise((resolve) => {
    execFile(bin, ['version'], { windowsHide: true, timeout: 15000 }, (error) => resolve(!error))
  })
}

async function detectBin (explicit) {
  const candidates = explicit
    ? [explicit]
    : process.platform === 'win32'
      ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\IPN\\tailscale.exe']
      : process.platform === 'darwin'
        ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale']
        : ['tailscale', '/usr/bin/tailscale', '/usr/sbin/tailscale']
  for (const candidate of candidates) {
    if (await canRun(candidate)) return candidate
  }
  return ''
}

function tailnetAddress (bin) {
  return new Promise((resolve) => {
    execFile(bin, ['ip', '-4'], { windowsHide: true, timeout: 15000 }, (error, stdout) => {
      if (error) return resolve('')
      resolve(String(stdout).trim().split(/\s+/)[0] ?? '')
    })
  })
}

/**
 * A pairing plugin answers /pair-app with an HTML shell (200). Plain DSH does
 * not serve that route, so "200 on /pair-app" is a cheap, dependency-free
 * signal that a gate is installed in front of the app.
 */
export function probePairingGate (port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/pair-app', timeout: timeoutMs, headers: { host: '127.0.0.1' } }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { if (body.length < 8192) body += chunk })
      response.on('end', () => {
        const looksLikeGate = response.statusCode === 200 && /pair|dsh|harness/i.test(body)
        resolve({ present: looksLikeGate, status: response.statusCode })
      })
    })
    request.on('timeout', () => { request.destroy(); resolve({ present: false, status: 'timeout' }) })
    request.on('error', (error) => resolve({ present: false, status: error.code ?? 'error' }))
  })
}

function pointServe (bin, port, cfg, log, attempt = 1) {
  execFile(bin, ['serve', '--bg', `http://127.0.0.1:${port}`], { windowsHide: true, timeout: 30000 }, (error, _stdout, stderr) => {
    if (!error) {
      log('info', 'tailscale serve -> http://127.0.0.1:%d (tailnet-only)', port)
      return
    }
    if (attempt < cfg.retries) {
      setTimeout(() => pointServe(bin, port, cfg, log, attempt + 1), cfg.retryMs)
      return
    }
    log('warn', 'tailscale serve failed after %d attempts: %s', cfg.retries, stderr || error.message)
  })
}
