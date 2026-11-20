import { apply } from '../index.js'
const logs = []
const ctx = {
  logger: () => ({
    info: (m) => logs.push('info ' + m),
    warn: (m) => logs.push('warn ' + m),
    error: (m) => logs.push('error ' + m),
  }),
  inject: (_s, cb) => cb({ webServer: { port: 19999 } }),
  effect: () => {},
}
apply(ctx, { port: 18082, serve: false })
await new Promise((r) => setTimeout(r, 3000))
console.log(logs.join('\n'))
const net = await import('node:net')
const hit = await new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: 18082 })
  s.on('connect', () => { s.destroy(); resolve('LISTENING (BAD)') })
  s.on('error', () => resolve('closed (good)'))
})
console.log('port 18082 ->', hit)
