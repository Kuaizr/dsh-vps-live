/** Standalone smoke test for the browser-live host half outside DSH. */
import http from 'node:http'
import { writeFileSync } from 'node:fs'

const { apply, inject } = await import('../lib/index.js')
if (JSON.stringify(inject) !== JSON.stringify(['webServer', 'connection'])) {
  throw new Error(`unexpected host injection list: ${JSON.stringify(inject)}`)
}

const routes = new Map()
const upgrades = new Map()
const fakeWebServer = {
  register(route) {
    if (route.handler.length >= 3) upgrades.set(route.path, route.handler)
    else routes.set(route.path, route.handler)
    return () => { routes.delete(route.path); upgrades.delete(route.path) }
  },
}

const server = http.createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://x').pathname)
  if (handler === undefined) { res.statusCode = 404; res.end(); return }
  void handler(req, res)
})
server.on('upgrade', (req, socket, head) => {
  const handler = upgrades.get(new URL(req.url, 'http://x').pathname)
  if (handler === undefined) { socket.destroy(); return }
  handler(req, socket, head)
})
await new Promise(resolve => server.listen(8123, '127.0.0.1', resolve))
console.log('test http server on 8123')

const dispose = await apply({ webServer: fakeWebServer, connection: undefined })
console.log('plugin active')

// Connect a WS client the way the web panel would.
const ws = new WebSocket('ws://127.0.0.1:8123/browser-live/ws')
ws.binaryType = 'arraybuffer'
const frames = []
const texts = []
ws.onmessage = event => {
  if (event.data instanceof ArrayBuffer) frames.push(event.data)
  else texts.push(String(event.data))
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })

// Drive the mirrored browser: first page via CDP-visible navigation.
// The plugin only mirrors; use the health endpoint and a second WS client trick:
// navigate through the attached Chromium by opening a page through /json/new.
const newTab = await fetch('http://127.0.0.1:9222/json/new?https://example.com', { method: 'PUT' })
console.log('opened tab:', (await newTab.json()).url)

await new Promise(resolve => setTimeout(resolve, 6000))
console.log('frames received:', frames.length)
console.log('json messages:', texts.slice(0, 6))
if (frames.length > 0) {
  const u8 = new Uint8Array(frames[frames.length - 1])
  writeFileSync('../.smoke-frame.jpg', u8)
  console.log('last frame bytes:', u8.length, 'jpeg magic:', u8[0] === 0xFF && u8[1] === 0xD8)
}

// Input dispatch smoke: mouse move + click at center (example.com is static; just verify no crash).
ws.send(JSON.stringify({ t: 'take', on: true }))
ws.send(JSON.stringify({ t: 'input', k: 'mouse', a: 'move', x: 400, y: 300 }))
ws.send(JSON.stringify({ t: 'input', k: 'mouse', a: 'down', x: 400, y: 300, button: 0, clicks: 1 }))
ws.send(JSON.stringify({ t: 'input', k: 'mouse', a: 'up', x: 400, y: 300, button: 0, clicks: 1 }))
ws.send(JSON.stringify({ t: 'key', a: 'down', key: 'Enter', code: 'Enter' }))
await new Promise(resolve => setTimeout(resolve, 1500))
console.log('after input, frames:', frames.length, 'messages:', texts.length)

const health = await (await fetch('http://127.0.0.1:8123/browser-live/health')).json()
console.log('health:', health)

console.log('SMOKE OK')
ws.close()
await dispose()
server.close()
process.exit(0)
