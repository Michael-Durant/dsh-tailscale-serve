import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createForwarder } from '../lib/forwarder.js'

const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)))

test('forwards TCP bytes to the loopback target', async () => {
  const target = http.createServer((_req, res) => res.end('hello-through-forwarder'))
  const targetPort = await listen(target)
  const forwarder = createForwarder({ bindAddress: '127.0.0.1', port: 0, targetPort })
  forwarder.listen()
  await new Promise((resolve) => forwarder.server.once('listening', resolve))
  const port = forwarder.server.address().port

  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })
  assert.equal(body, 'hello-through-forwarder')
  forwarder.close()
  target.close()
})

test('drops peers that are not in allowedPeers', async () => {
  const target = http.createServer((_req, res) => res.end('nope'))
  const targetPort = await listen(target)
  const forwarder = createForwarder({ bindAddress: '127.0.0.1', port: 0, targetPort, allowedPeers: ['100.64.0.9'] })
  forwarder.listen()
  await new Promise((resolve) => forwarder.server.once('listening', resolve))
  const port = forwarder.server.address().port

  const outcome = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.on('connect', () => socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'))
    socket.on('data', () => resolve('data'))
    socket.on('close', () => resolve('closed'))
    socket.on('error', () => resolve('closed'))
    setTimeout(() => { socket.destroy(); resolve('timeout') }, 1500)
  })
  assert.equal(outcome, 'closed')
  forwarder.close()
  target.close()
})
