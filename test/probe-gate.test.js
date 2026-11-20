import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { probePairingGate } from '../index.js'

function serve (handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

test('probePairingGate detects a pairing shell', async () => {
  const server = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>DeepSeek Harness</title><script>pair</script>') })
  const { port } = server.address()
  const gate = await probePairingGate(port)
  server.close()
  assert.equal(gate.present, true)
  assert.equal(gate.status, 200)
})

test('probePairingGate reports missing gate on 404 and refuses plain JSON 200', async () => {
  const missing = await serve((_req, res) => { res.writeHead(404); res.end('not found') })
  const notGate = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
  const a = await probePairingGate(missing.address().port)
  const b = await probePairingGate(notGate.address().port)
  missing.close()
  notGate.close()
  assert.equal(a.present, false)
  assert.equal(a.status, 404)
  assert.equal(b.present, false)
})
