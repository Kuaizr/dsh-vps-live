/** Client half: right-Sidebar tabs mirroring the agent's browser and the desktop. */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as noVncRfb from '@novnc/novnc/lib/rfb.js'

// noVNC's lib/rfb.js is a Babel transpilation (exports.default = class); the
// bundler's CJS interop nests it one level deeper, so unwrap defensively.
const RFB: any = (noVncRfb as any).default?.default ?? (noVncRfb as any).default ?? noVncRfb

const PLUGIN_ID = '@aether/dsh-browser-live'
const DESKTOP_ID = '@aether/dsh-browser-live/desktop'

/** Services required to register the tab types and their bodies. */
export const inject = ['slots', 'sidebarRightTabs']

const IDLE_STYLE = { border: '1px solid #d0d0d0', borderRadius: 6 } as const

/**
 * Activate the Browser Live and Desktop Live tabs in the right Sidebar.
 * @param ctx - Client runtime context.
 * @returns disposer withdrawing the tab types and bodies.
 */
export function apply(ctx: any): () => void {
  try {
    return applyInner(ctx)
  } catch (error) {
    void fetch('/browser-live/debug-error', { method: 'POST', body: `apply threw: ${String(error)}\n${(error as any)?.stack ?? ''}` })
    throw error
  }
}

function applyInner(ctx: any): () => void {
  const disposeType = ctx.sidebarRightTabs.register({
    id: PLUGIN_ID,
    kind: 'browserLive',
    priority: 'extension',
    title: () => 'Browser Live',
    guide: [{
      id: 'browser-live',
      order: 90,
      title: () => 'Browser Live',
      description: () => '实时查看 agent 正在操作的浏览器画面，并可接管控制',
    }],
  })
  const disposeDesktopType = ctx.sidebarRightTabs.register({
    id: DESKTOP_ID,
    kind: 'desktopLive',
    priority: 'extension',
    title: () => 'Desktop Live',
    guide: [{
      id: 'desktop-live',
      order: 91,
      title: () => 'Desktop Live',
      description: () => '实时查看并操作 agent 的完整虚拟桌面（VNC）',
    }],
  })
  const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PLUGIN_ID,
  }, LiveTab))
  const disposeDesktopBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: DESKTOP_ID,
  }, DesktopTab))
  return () => {
    try { disposeBody?.() } catch {}
    try { disposeDesktopBody?.() } catch {}
    try { disposeType?.() } catch {}
    try { disposeDesktopType?.() } catch {}
  }
}

interface CursorState { x: number, y: number, k: string }

function LiveTab(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const frameRef = useRef<{ w: number, h: number }>({ w: 1280, h: 800 })
  const [status, setStatus] = useState<'connecting' | 'live' | 'closed'>('connecting')
  const [taken, setTaken] = useState(false)
  const [mine, setMine] = useState(false)
  const [cursor, setCursor] = useState<CursorState | null>(null)
  const [ripple, setRipple] = useState<CursorState | null>(null)
  const [meta, setMeta] = useState<string>('')

  useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined

    const connect = (): void => {
      if (disposed) return
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${proto}://${window.location.host}/browser-live/ws`)
      socket.binaryType = 'arraybuffer'
      socketRef.current = socket
      socket.onopen = () => setStatus('live')
      socket.onclose = () => { setStatus('closed'); if (!disposed) retry = setTimeout(connect, 3000) }
      socket.onmessage = event => {
        if (event.data instanceof ArrayBuffer) {
          const canvas = canvasRef.current
          if (canvas === null) return
          const blob = new Blob([event.data], { type: 'image/jpeg' })
          void createImageBitmap(blob).then(bitmap => {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
            canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
            bitmap.close()
          }).catch(() => {})
          return
        }
        try {
          const message = JSON.parse(String(event.data))
          if (message.t === 'cursor') {
            setCursor({ x: message.x, y: message.y, k: message.k })
            if (message.k === 'click' || message.k === 'down') setRipple({ x: message.x, y: message.y, k: message.k })
          } else if (message.t === 'take') {
            setTaken(message.on)
            if (!message.on) setMine(false)
          } else if (message.t === 'meta') {
            frameRef.current = { w: message.w, h: message.h }
          }
        } catch {}
      }
    }
    connect()
    return () => {
      disposed = true
      if (retry !== undefined) clearTimeout(retry)
      socket?.close()
      socketRef.current = null
    }
  }, [])

  useEffect(() => {
    if (ripple === null) return
    const timer = setTimeout(() => setRipple(null), 450)
    return () => clearTimeout(timer)
  }, [ripple])

  const toFrame = useCallback((event: React.PointerEvent | React.MouseEvent): { x: number, y: number } => {
    const canvas = canvasRef.current
    const rect = (canvas ?? event.currentTarget).getBoundingClientRect()
    return {
      x: (event.clientX - rect.left) * frameRef.current.w / Math.max(rect.width, 1),
      y: (event.clientY - rect.top) * frameRef.current.h / Math.max(rect.height, 1),
    }
  }, [])

  const send = useCallback((message: Record<string, unknown>): void => {
    socketRef.current?.send(JSON.stringify(message))
  }, [])

  const toggleTake = useCallback(() => {
    if (mine) { send({ t: 'take', on: false }); setMine(false); return }
    send({ t: 'take', on: true }); setMine(true)
  }, [mine, send])

  const pointer = useCallback((action: 'move' | 'down' | 'up') => (event: React.PointerEvent): void => {
    if (!mine || event.buttons === 0 && action !== 'move') { if (!mine) return }
    if (!mine) return
    const { x, y } = toFrame(event)
    send({ t: 'input', k: 'mouse', a: action, x, y, button: event.button, clicks: event.detail })
  }, [mine, send, toFrame])

  const onWheel = useCallback((event: React.WheelEvent): void => {
    if (!mine) return
    const { x, y } = toFrame(event)
    send({ t: 'wheel', x, y, dx: event.deltaX, dy: event.deltaY })
    event.preventDefault()
  }, [mine, send, toFrame])

  const onKeyDown = useCallback((event: React.KeyboardEvent): void => {
    if (!mine) return
    if (event.key.length === 1 || ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Home', 'End'].includes(event.key)) {
      send({ t: 'key', a: 'down', key: event.key, code: event.code })
      event.preventDefault()
    }
  }, [mine, send])

  const onKeyUp = useCallback((event: React.KeyboardEvent): void => {
    if (!mine) return
    send({ t: 'key', a: 'up', key: event.key, code: event.code })
  }, [mine, send])

  const canvas = canvasRef.current
  const cursorStyle = canvas === null || cursor === null ? { display: 'none' } : {
    position: 'absolute' as const,
    left: `${cursor.x / frameRef.current.w * 100}%`,
    top: `${cursor.y / frameRef.current.h * 100}%`,
    transform: 'translate(-2px, -2px)',
    pointerEvents: 'none' as const,
    transition: 'left 80ms linear, top 80ms linear',
  }
  const rippleStyle = canvas === null || ripple === null ? { display: 'none' } : {
    position: 'absolute' as const,
    left: `${ripple.x / frameRef.current.w * 100}%`,
    top: `${ripple.y / frameRef.current.h * 100}%`,
    width: 28, height: 28, marginLeft: -14, marginTop: -14,
    borderRadius: '50%', border: '2px solid rgba(66,133,244,0.9)',
    background: 'rgba(66,133,244,0.25)',
    pointerEvents: 'none' as const,
    animation: 'dsh-live-ripple 450ms ease-out forwards',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8, padding: 8, boxSizing: 'border-box' }}>
      <style>{'@keyframes dsh-live-ripple { from { transform: scale(0.4); opacity: 1 } to { transform: scale(1.6); opacity: 0 } }'}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: status === 'live' ? '#34a853' : status === 'connecting' ? '#f9ab00' : '#ea4335',
        }} />
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {status === 'live' ? `实时${taken ? ' · 被接管' : ''}` : status === 'connecting' ? '连接中…' : '已断开，重连中…'}
          {meta !== '' ? ` · ${frameRef.current.w}×${frameRef.current.h}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={toggleTake}
          disabled={status !== 'live' || taken && !mine}
          style={{
            padding: '4px 12px', borderRadius: 6, border: '1px solid #888',
            background: mine ? '#1a73e8' : 'transparent', color: mine ? '#fff' : 'inherit',
            cursor: status !== 'live' || taken && !mine ? 'not-allowed' : 'pointer',
          }}
        >
          {mine ? '释放控制' : '接管'}
        </button>
      </div>
      <div
        style={{
          position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden',
          cursor: mine ? 'none' : 'default', ...IDLE_STYLE,
        }}
        tabIndex={mine ? 0 : -1}
        onPointerMove={pointer('move')}
        onPointerDown={pointer('down')}
        onPointerUp={pointer('up')}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
        <svg style={cursorStyle} width="18" height="18" viewBox="0 0 24 24">
          <path d="M4 2 L4 20 L9 15 L12.5 22 L15.5 20.5 L12 14 L19 14 Z"
            fill={mine ? '#1a73e8' : '#ea4335'} stroke="#fff" strokeWidth="1.5" />
        </svg>
        <div style={rippleStyle} />
        {status !== 'live' && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.05)', fontSize: 13, opacity: 0.7 }}>
            等待浏览器画面…
          </div>
        )}
      </div>
    </div>
  )
}

function DesktopTab(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<any>(null)
  const [status, setStatus] = useState<'connecting' | 'live' | 'closed'>('connecting')

  useEffect(() => {
    let disposed = false
    let rfb: any = null
    let retry: ReturnType<typeof setTimeout> | undefined
    const start = (): void => {
      if (disposed || containerRef.current === null) return
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const url = `${proto}://${window.location.host}/desktop-live/ws`
      try {
        rfb = new RFB(containerRef.current, url, {
          shared: true,
          onconnect: () => setStatus('live'),
          ondisconnect: (e: any) => { console.error('browser-live desktop rfb disconnect:', e?.detail ?? e); reconnect() },
        })
        rfb.scaleViewport = true
        rfb.background = '#111111'
        rfbRef.current = rfb
        // noVNC 1.5 also emits DOM events; listen to both for the status pill.
        rfb.addEventListener?.('connect', () => setStatus('live'))
        rfb.addEventListener?.('disconnect', () => reconnect())
      } catch (error) {
        console.error('browser-live desktop RFB failed to start:', error)
        setStatus('closed')
      }
    }
    const timer = setTimeout(start, 300)
    const reconnect = (): void => {
      if (disposed) return
      setStatus('closed')
      if (retry === undefined) retry = setTimeout(() => { retry = undefined; if (!disposed) start() }, 3000)
    }
    return () => {
      disposed = true
      clearTimeout(timer)
      if (retry !== undefined) clearTimeout(retry)
      try { rfb?.disconnect() } catch {}
      rfbRef.current = null
    }
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8, padding: 8, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: status === 'live' ? '#34a853' : status === 'connecting' ? '#f9ab00' : '#ea4335' }} />
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {status === 'live' ? '桌面实时 · 直接点击/拖拽/打字即操作' : status === 'connecting' ? '连接中…' : '已断开，重连中…'}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => { try { rfbRef.current?.sendCtrlAltDel() } catch {} }}
          disabled={status !== 'live'}
          style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #888', background: 'transparent', cursor: status !== 'live' ? 'not-allowed' : 'pointer' }}
        >
          Ctrl+Alt+Del
        </button>
      </div>
      <div ref={containerRef} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', ...IDLE_STYLE }} />
    </div>
  )
}
