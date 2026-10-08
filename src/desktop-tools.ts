/** Agent-side desktop control tools over xdotool on the virtual display. @module */
import { execFile } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'

const DISPLAY = process.env.BROWSER_LIVE_DISPLAY ?? ':99'
const SCREEN = { w: 1600, h: 900 }

/** Run one xdotool invocation against the virtual display. */
function xdo(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('xdotool', args, { env: { ...process.env, DISPLAY } }, (error, stdout, stderr) => {
      if (error !== undefined) reject(new Error(`xdotool ${args[0]} failed: ${stderr !== '' ? stderr : error.message}`))
      else resolve(stdout)
    })
  })
}

const BUTTONS: Record<string, number> = { left: 1, middle: 2, right: 3 }

/**
 * Register the desktop control tool and its system-prompt section.
 * @param ctx - Host runtime context with tools and systemPrompt services.
 */
export function registerDesktopTools(ctx: any): void {
  if (ctx.tools === undefined) return
  ctx.tools.register(defineTool({
    name: 'desktop',
    description: 'Operate the agent virtual desktop (1600x900, OpenBox). The user watches this desktop live; prefer visible, deliberate actions. Right-click on the desktop background opens the applications menu (xterm terminal, PCManFM file manager).',
    parameters: {
      action: { type: 'string', required: true, description: 'One of: click, doubleClick, rightClick, move, drag, type, key, scroll.' },
      x: { type: 'number', description: 'Target X coordinate in pixels (0-1600). Required by click/doubleClick/rightClick/move/drag.' },
      y: { type: 'number', description: 'Target Y coordinate in pixels (0-900). Required by click/doubleClick/rightClick/move/drag.' },
      x2: { type: 'number', description: 'Drag end X. Required by drag.' },
      y2: { type: 'number', description: 'Drag end Y. Required by drag.' },
      text: { type: 'string', description: 'Text to type. Required by type.' },
      key: { type: 'string', description: 'Key combo in xdotool syntax, e.g. Return, ctrl+s, alt+F4, super. Required by key.' },
      direction: { type: 'string', description: 'Scroll direction: up or down. Required by scroll.' },
      amount: { type: 'number', description: 'Scroll click count (default 3).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          detail: { type: 'string' },
        },
      },
      render(_args, value): { type: 'text', text: string }[] {
        const v = value as { ok: boolean, action: string, detail?: string }
        return [{ type: 'text', text: `desktop ${v.action}: ${v.ok ? 'done' : 'failed'}${v.detail !== undefined ? ` — ${v.detail}` : ''}` }]
      },
    },
    timeoutMs: 15_000,
    async execute(args) {
      const a = args as Record<string, any>
      const clamp = (n: any, max: number): number => Math.max(0, Math.min(Math.round(Number(n) || 0), max))
      const x = clamp(a.x, SCREEN.w)
      const y = clamp(a.y, SCREEN.h)
      switch (String(a.action)) {
        case 'move':
          await xdo(['mousemove', String(x), String(y)])
          break
        case 'click':
        case 'doubleClick':
        case 'rightClick': {
          const button = a.action === 'rightClick' ? 3 : BUTTONS[String(a.button ?? 'left')] ?? 1
          const repeat = a.action === 'doubleClick' ? ['--repeat', '2', '--delay', '120'] : []
          await xdo(['mousemove', String(x), String(y), 'click', ...repeat, String(button)])
          break
        }
        case 'drag': {
          const x2 = clamp(a.x2, SCREEN.w)
          const y2 = clamp(a.y2, SCREEN.h)
          await xdo(['mousemove', String(x), String(y), 'mousedown', '1', 'mousemove', String(x2), String(y2), 'mouseup', '1'])
          break
        }
        case 'type': {
          const text = String(a.text ?? '')
          if (text === '') throw new Error('desktop type: text is required')
          await xdo(['type', '--delay', '25', '--', text])
          break
        }
        case 'key': {
          const key = String(a.key ?? '')
          if (key === '') throw new Error('desktop key: key is required')
          await xdo(['key', '--', key])
          break
        }
        case 'scroll': {
          const button = String(a.direction ?? 'down') === 'up' ? 4 : 5
          const amount = Math.max(1, Math.min(Math.round(Number(a.amount) || 3), 15))
          await xdo(['mousemove', String(x), String(y)])
          for (let i = 0; i < amount; i++) await xdo(['click', String(button)])
          break
        }
        default:
          throw new Error(`desktop: unknown action "${String(a.action)}"`)
      }
      return { ok: true, action: String(a.action), ...(a.action === 'type' ? { detail: `typed ${String(a.text ?? '').length} chars` } : {}) }
    },
  }))
  ctx.systemPrompt?.section({
    name: 'tool:desktop',
    order: ctx.systemPrompt.getSectionOrder?.('TOOL_WEB_FETCH') ?? 0,
    text: () => 'The desktop tool drives a real virtual desktop (1600x900, OpenBox) the user watches live. Right-click the background for the applications menu (xterm, PCManFM). Coordinates are pixels from the top-left. After opening a terminal you can type commands into it; prefer deliberate, visible actions and move the pointer before clicking.',
  })
}
