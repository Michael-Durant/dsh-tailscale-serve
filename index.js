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
import http from 'node:http'
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
}

export function apply (ctx, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) }
  // DSH loggers take a plain string; format here so %s placeholders behave.
  const log = (level, fmt, ...args) => ctx.logger?.('dsh-tailscale-serve')?.[level]?.(format(fmt, ...args))

  ctx.inject(['webServer'], (scope) => {
    const port = scope?.webServer?.port
    if (!port) {
      log('warn', 'webServer port not available yet; waiting for the next start')
      return
    }
    start(port, cfg, ctx, log)
  })
}

async function start (port, cfg, ctx, log) {
  const bin = await detectBin(cfg.tailscaleBin)
  if (!bin) {
    log('error', 'tailscale CLI not found. Install Tailscale or set tailscaleBin. Port stays closed.')
    return
  }

  const ip = await tailnetAddress(bin)
  if (!ip) {
    log('error', 'no Tailscale IPv4 address (is Tailscale up and logged in?). Port stays closed.')
    return
  }
  if (!isTailnetAddress(ip) && !cfg.allowNonTailnet) {
    log('error', 'refusing to bind %s: not a CGNAT/tailnet address (100.64.0.0/10). Set allowNonTailnet to override.', ip)
    return
  }

  const gate = cfg.pairingCheck === 'off' ? { skipped: true, present: false } : await probePairingGate(port)
  if (!gate.skipped && !gate.present && !cfg.allowUnpaired) {
    log('error', 'no pairing gate answered at /pair-app (status %s). Install a pairing plugin such as @linxin666/dsh-remote-web-ui, or set allowUnpaired: true to expose DSH to every device on your tailnet.', gate.status ?? 'none')
    return
  }
  if (!gate.present && cfg.allowUnpaired) {
    log('warn', 'SECURITY: allowUnpaired is on — any device on your tailnet can open this DSH without a pairing token.')
  }

  if (cfg.serve) pointServe(bin, port, cfg, log)
  startForwarder(ip, port, cfg, ctx, log)

  log('info', 'ready: http://%s:%d  gate=%s  peers=%s', ip, cfg.port, gate.skipped ? 'check-disabled' : gate.present ? 'paired' : 'UNPAIRED', cfg.allowedPeers.length ? cfg.allowedPeers.join(',') : 'any-tailnet-device')
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

function startForwarder (ip, port, cfg, ctx, log, attempt = 1) {
  const forwarder = createForwarder({
    bindAddress: ip,
    port: cfg.port,
    targetPort: port,
    allowedPeers: cfg.allowedPeers,
    maxConnections: cfg.maxConnections,
    log,
    onError: (error) => {
      if (attempt < 10) {
        setTimeout(() => startForwarder(ip, port, cfg, ctx, log, attempt + 1), cfg.retryMs)
        return
      }
      log('error', 'forwarder failed: %s', error.message)
    },
  })
  forwarder.listen()
  log('info', 'forwarder listening on %s:%d -> 127.0.0.1:%d', ip, cfg.port, port)
  ctx.effect(() => () => { forwarder.close() }, 'dsh-tailscale-serve: tailnet forwarder')
}
