/**
 * Raw TCP forwarder: <bindAddress>:<port> -> 127.0.0.1:<targetPort>.
 *
 * Kept separate from index.js so it can be unit-tested without Tailscale:
 * any listenable address works here, while index.js is the layer that refuses
 * to hand it anything but a tailnet address.
 */
import net from 'node:net'
import { peerAllowed } from './net-guard.js'

export function createForwarder ({ bindAddress, port, targetPort, allowedPeers = [], maxConnections = 64, log = () => {}, onError } = {}) {
  let active = 0
  const server = net.createServer((client) => {
    const remote = client.remoteAddress ?? ''
    if (!peerAllowed(remote, allowedPeers)) {
      log('warn', 'rejected %s (not in allowedPeers)', remote)
      client.destroy()
      return
    }
    if (active >= maxConnections) {
      log('warn', 'rejected %s: connection limit %d reached', remote, maxConnections)
      client.destroy()
      return
    }
    active += 1
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort })
    client.pipe(upstream)
    upstream.pipe(client)
    const done = () => { active = Math.max(0, active - 1) }
    client.on('error', () => { upstream.destroy(); done() })
    upstream.on('error', () => { client.destroy(); done() })
    client.on('close', done)
    upstream.on('close', done)
  })
  if (onError) server.on('error', onError)
  return {
    server,
    listen: () => server.listen(port, bindAddress),
    close: () => server.close(),
    get active () { return active },
  }
}
