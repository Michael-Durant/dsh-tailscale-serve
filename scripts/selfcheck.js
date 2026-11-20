#!/usr/bin/env node
/**
 * Read-only environment check: finds the tailscale CLI, prints the tailnet
 * address, and probes the pairing gate on the current DSH port.
 * Never binds a port and never changes Tailscale state.
 *
 *   node scripts/selfcheck.js --port 51741
 */
import { probePairingGate } from '../index.js'
import { isTailnetAddress } from '../lib/net-guard.js'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const port = portArg >= 0 ? Number(args[portArg + 1]) : 51741

function tryExec (bin, argv) {
  try {
    return execFileSync(bin, argv, { encoding: 'utf8', timeout: 15000 }).trim()
  } catch {
    return ''
  }
}

const candidates = ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
const bin = candidates.find((candidate) => tryExec(candidate, ['version']) !== '')
if (!bin) {
  console.error('FAIL tailscale CLI not found')
  process.exit(1)
}
const version = tryExec(bin, ['version']).split(/\s+/)[0]
const ip = tryExec(bin, ['ip', '-4']).split(/\s+/)[0]
const gate = await probePairingGate(port)

console.log('tailscale    :', version, '(' + bin + ')')
console.log('tailnet ip   :', ip, isTailnetAddress(ip) ? '[tailnet OK]' : '[NOT a tailnet address]')
console.log('dsh port     :', port)
console.log('pairing gate :', gate.present ? 'present' : 'MISSING', '(status ' + gate.status + ')')
if (!isTailnetAddress(ip) || !gate.present) process.exit(2)
