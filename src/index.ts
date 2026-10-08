/** Host half of the browser-live plugin: own Chromium, CDP screencast, WS bridge. @module */
import net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core'
import { registerDesktopTools } from './desktop-tools.ts'

export const name = 'browser-live'

/** Services required to register, authenticate, and expose the live-view routes and desktop tools. */
export const inject = ['webServer', 'connection', 'tools', 'systemPrompt']

const DEBUG_PORT = Number(process.env.BROWSER_LIVE_PORT ?? 9222)
function detectChromiumExecutable(): string {
  const cache = join(process.env.HOME ?? '', '.cache/ms-playwright')
  try {
    const dirs = readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse()
    for (const dir of dirs) {
      const candidate = join(cache, dir, 'chrome-headless-shell-linux-arm64', 'chrome-headless-shell')
      if (existsSync(candidate)) return candidate
    }
    const full = join(cache, dirs.length > 0 ? '' : '')
    const fullDirs = readdirSync(cache).filter(d => d.startsWith('chromium-')).sort().reverse()
    for (const dir of fullDirs) {
      const arch = process.arch === 'arm64' ? 'chrome-linux-arm64' : 'chrome-linux'
      const candidate = join(cache, dir, arch, 'chrome')
      if (existsSync(candidate)) return candidate
    }
  } catch {}
  return 'chromium-browser'
}
const EXECUTABLE = process.env.BROWSER_LIVE_EXECUTABLE ?? detectChromiumExecutable()
const WS_PATH = '/browser-live/ws'
const HEALTH_PATH = '/browser-live/health'
const DESKTOP_WS_PATH = '/desktop-live/ws'
const VNC_PORT = 5999

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** Script installed in every mirrored page: report the cursor the agent moves. */
const CURSOR_INIT = `(() => {
  if (window.__dshLiveInit) return
  window.__dshLiveInit = true
  let last = 0
  const send = (k, e) => { try { window.__dshLiveCursor(JSON.stringify({ k, x: e.clientX, y: e.clientY })) } catch {} }
  window.addEventListener('mousemove', e => { const n = Date.now(); if (n - last > 60) { last = n; send('move', e) } }, true)
  window.addEventListener('mousedown', e => send('down', e), true)
  window.addEventListener('click', e => send('click', e), true)
})()`

interface CursorMessage { t: 'cursor', x: number, y: number, k: string }
interface TakeMessage { t: 'take', on: boolean }
interface MetaMessage { t: 'meta', w: number, h: number }
type ServerMessage = CursorMessage | TakeMessage | MetaMessage

/**
 * Activate the live browser: launch Chromium with a CDP port for the
 * browser-use attach provider, mirror its foreground page over WebSocket,
 * and forward viewer input while a viewer holds the takeover.
 * @param ctx - Host runtime context (webserver service required).
 * @returns disposer releasing every owned resource.
 */
export async function apply(ctx: any): Promise<() => Promise<void>> {
  const webServer = ctx.webServer
  if (webServer === undefined) throw new Error('browser-live: the webserver service is required')
  const connection = Reflect.get(ctx, 'connection') as
    { requestRejection?: (req: IncomingMessage) => number | undefined } | undefined
  registerDesktopTools(ctx)

  // --- Launch Chromium with a fixed CDP endpoint for the attach provider. ---
  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-live-'))
  const chrome = spawn(EXECUTABLE, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--window-size=1280,800', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' })
  const chromeGone = new Promise<void>(resolve => { chrome.once('exit', resolve) })

  let browser: Browser | undefined
  for (let i = 0; i < 60 && browser === undefined; i++) {
    await Promise.race([sleep(250), chromeGone.then(() => { throw new Error('browser-live: chromium exited during startup') })])
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}/`) } catch {}
  }
  if (browser === undefined) {
    chrome.kill('SIGKILL')
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    throw new Error(`browser-live: no CDP endpoint on 127.0.0.1:${DEBUG_PORT}`)
  }

  const context: BrowserContext = browser.contexts()[0] ?? await browser.newContext()
  if (context.pages().length === 0) await context.newPage()

  // --- Live hub: mirrored frames out, taken-over input in. ---
  const clients = new Set<WebSocket>()
  let taker: WebSocket | null = null
  let currentPage: Page | null = null
  let currentSession: CDPSession | null = null

  const send = (ws: WebSocket, message: ServerMessage): void => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)) }
  const broadcast = (message: ServerMessage): void => { for (const ws of clients) send(ws, message) }
  const broadcastFrame = (frame: Buffer): void => { for (const ws of clients) { if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true }) } }

  async function attach(page: Page): Promise<void> {
    if (currentPage === page) return
    await detach()
    currentPage = page
    const cdp = await context.newCDPSession(page)
    currentSession = cdp
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Runtime.addBinding', { name: '__dshLiveCursor' })
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CURSOR_INIT })
    await cdp.send('Runtime.evaluate', { expression: CURSOR_INIT }).catch(() => {})
    cdp.on('Page.screencastFrame', event => {
      broadcast({ t: 'meta', w: event.metadata.deviceWidth, h: event.metadata.deviceHeight })
      broadcastFrame(Buffer.from(event.data, 'base64'))
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
    })
    cdp.on('Runtime.bindingCalled', event => {
      if (event.name !== '__dshLiveCursor') return
      try {
        const parsed = JSON.parse(event.payload) as { k: string, x: number, y: number }
        broadcast({ t: 'cursor', x: parsed.x, y: parsed.y, k: parsed.k })
      } catch {}
    })
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800 })
    page.once('close', () => { void attachToFirstPage() })
  }

  async function detach(): Promise<void> {
    const session = currentSession
    currentSession = null
    currentPage = null
    if (session === null) return
    await session.send('Page.stopScreencast').catch(() => {})
    await session.detach().catch(() => {})
  }

  async function attachToFirstPage(): Promise<void> {
    if (!browser.isConnected()) return
    const pages = context.pages()
    if (pages.length === 0) { await detach(); return }
    await attach(pages[pages.length - 1]).catch(() => {})
  }
  context.on('page', page => { void attach(page).catch(() => {}) })
  await attachToFirstPage()

  // --- Takeover input dispatch through the CDP Input domain. ---
  const MOUSE_BUTTONS: Record<string, string> = { 0: 'left', 1: 'middle', 2: 'right' }
  const KEY_CODES: Record<string, { code: number, text?: string }> = {
    Enter: { code: 13, text: '\r' }, Backspace: { code: 8 }, Tab: { code: 9, text: '\t' },
    Escape: { code: 27 }, ArrowUp: { code: 38 }, ArrowDown: { code: 40 }, ArrowLeft: { code: 37 },
    ArrowRight: { code: 39 }, Delete: { code: 46 }, Home: { code: 36 }, End: { code: 35 },
  }

  async function dispatchInput(message: any): Promise<void> {
    const session = currentSession
    if (session === null) return
    if (message.t === 'input' && message.k === 'mouse') {
      const type = message.a === 'move' ? 'mouseMoved' : message.a === 'down' ? 'mousePressed' : 'mouseReleased'
      await session.send('Input.dispatchMouseEvent', {
        type, x: Number(message.x) || 0, y: Number(message.y) || 0,
        button: MOUSE_BUTTONS[message.button ?? 0] ?? 'left',
        clickCount: message.a === 'move' ? 0 : Math.max(1, Number(message.clicks) || 1),
      })
      return
    }
    if (message.t === 'wheel') {
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Number(message.x) || 0, y: Number(message.y) || 0,
        deltaX: Number(message.dx) || 0, deltaY: Number(message.dy) || 0,
      })
      return
    }
    if (message.t === 'key') {
      const key = String(message.key ?? '')
      const known = KEY_CODES[key]
      const printable = key.length === 1 ? key : undefined
      await session.send('Input.dispatchKeyEvent', {
        type: message.a === 'down' ? 'keyDown' : 'keyUp',
        key, code: String(message.code ?? ''),
        text: message.a === 'down' ? known?.text ?? printable : undefined,
        windowsVirtualKeyCode: known?.code ?? (printable !== undefined ? printable.toUpperCase().charCodeAt(0) : 0),
        nativeVirtualKeyCode: known?.code ?? 0,
      })
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 << 10 })
  wss.on('connection', ws => {
    clients.add(ws)
    // Screencast is damage-driven: a static page emits nothing, so serve one
    // immediate capture as the joining client's first frame.
    void (async () => {
      const session = currentSession
      if (session === null) return
      const shot = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }).catch(() => undefined)
      if (shot !== undefined && ws.readyState === ws.OPEN) ws.send(Buffer.from(shot.data, 'base64'), { binary: true })
    })()
    ws.on('close', () => { clients.delete(ws); if (taker === ws) { taker = null; broadcast({ t: 'take', on: false }) } })
    ws.on('message', raw => {
      let message: any
      try { message = JSON.parse(String(raw)) } catch { return }
      if (message.t === 'take') {
        if (message.on && taker !== null && taker !== ws) return
        taker = message.on ? ws : taker === ws ? null : taker
        broadcast({ t: 'take', on: taker !== null })
        return
      }
      if (taker !== null && taker !== ws) return
      void dispatchInput(message).catch(() => {})
    })
  })

  const reject = (req: IncomingMessage): boolean => {
    const status = connection?.requestRejection?.(req)
    return status !== undefined
  }

  const disposeUpgrade = webServer.registerUpgrade({
    path: WS_PATH,
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      log(`browser ws: authRejected=${reject(req)}`)
      if (reject(req)) { socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    },
  })

  // websockify-style bridge: noVNC speaks RFB inside WebSocket frames, so the
  // upgrade must complete a WS handshake, then relay frames to the VNC socket.
  const vncWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })
  const debugFile = process.env.BROWSER_LIVE_DEBUG_LOG
  const log = (message: string): void => {
    if (debugFile === undefined) return
    try { appendFileSync(debugFile, `${new Date().toISOString()} ${message}\n`) } catch {}
  }
  const disposeVncUpgrade = webServer.registerUpgrade({
    path: DESKTOP_WS_PATH,
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      if (reject(req)) { log('upgrade rejected by auth'); socket.destroy(); return }
      log('upgrade reached handler')
      vncWss.handleUpgrade(req, socket, head, ws => {
        log('ws handshake ok')
        // Cloudflare drops idle WebSocket tunnels; ping at protocol level to keep it alive.
        const keepalive = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping() }, 30000)
        ws.on('close', () => clearInterval(keepalive))
        const vnc = net.connect(VNC_PORT, '127.0.0.1')
        let opened = false
        vnc.on('connect', () => { opened = true; log('vnc connected') })
        vnc.on('data', chunk => { if (ws.readyState === ws.OPEN) ws.send(chunk) })
        vnc.on('error', error => { log(`vnc error ${error.message}`); ws.close() })
        ws.on('message', data => { if (opened) vnc.write(data as Buffer) })
        ws.on('close', () => { log('ws closed'); vnc.destroy() })
      })
    },
  })

  const disposeDebug = debugFile !== undefined ? webServer.register({
    kind: 'exact' as const,
    path: '/browser-live/debug-error',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (reject(req)) { res.statusCode = 401; res.end(); return }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => { log(`CLIENT ERROR: ${body.slice(0, 4000)}`); res.statusCode = 204; res.end() })
    },
  }) : () => {}

  const disposeHealth = webServer.register({
    kind: 'exact' as const,
    path: HEALTH_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (reject(req)) { res.statusCode = 401; res.end(); return }
      if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        pages: context.pages().length, clients: clients.size,
        taken: taker !== null, mirroring: currentSession !== null,
      }))
    },
  })

  // --- Teardown. ---
  return async () => {
    disposeUpgrade()
    disposeVncUpgrade()
    disposeDebug()
    disposeHealth()
    for (const ws of clients) ws.close(1001, 'plugin unloading')
    await new Promise<void>(resolve => { wss.close(() => resolve()) })
    await detach()
    await browser.close().catch(() => {})
    chrome.kill('SIGTERM')
    await Promise.race([chromeGone, sleep(2000).then(() => chrome.kill('SIGKILL'))])
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}
