import type { ServerWebSocket } from 'bun'
import type { ZodError } from 'zod'

import { streamResponse } from '../llm'
import { logger } from '../logger'
import type { Session } from '../session'
import type { StreamSocketData } from './index'
import { send } from './schema'

export function humanizeZodError(err: ZodError): string {
  return err.issues
    .map(i => {
      const path = i.path.length ? i.path.join('.') : 'root'
      return `${path}: ${i.message}`
    })
    .join('\n')
}

function abortStreamIfQueueIdle(ws: ServerWebSocket<StreamSocketData>) {
  if (ws.data.q.size > 0 || ws.data.q.pending > 0) return

  const { stream } = ws.data.state
  if (!stream) return

  stream.abort()
  ws.data.state.stream = null
}

export function handleAbort(ws: ServerWebSocket<StreamSocketData>) {
  ws.data.q.clear()
  ws.data.q.onIdle().then(() => abortStreamIfQueueIdle(ws))
}

export type EnsureSessionResult = {
  session: Session
  created: boolean
}

export async function ensureSession(ws: ServerWebSocket<StreamSocketData>): Promise<EnsureSessionResult> {
  if (ws.data.state.session) {
    return { session: ws.data.state.session, created: false }
  }

  const created = ws.data.sessionId === undefined
  ws.data.state.session = await ws.data.sessionService.ensure(ws.data.sessionId)
  return { session: ws.data.state.session, created }
}

export async function streamAndSendAssistantResponse(options: {
  ws: ServerWebSocket<StreamSocketData>
  route: string,
  sessionId: number
  input: string
  start: number
}): Promise<string> {
  const stream = streamResponse(options.input)
  options.ws.data.state.stream = stream

  let streamedText = ''
  let firstTokenLogged = false
  stream.on('response.output_text.delta', (event) => {
    if (!firstTokenLogged) {
      firstTokenLogged = true
      logger.info({
        route: options.route,
        maidId: options.ws.data.maidId,
        sessionId: options.sessionId,
        firstTokenMs: Date.now() - options.start,
      }, 'ws.chat.first_token')
    }
    streamedText += event.delta
    send(options.ws, { type: 'chat.delta', delta: event.delta })
  })

  await new Promise<void>((resolve, reject) => {
    stream.on('response.completed', () => resolve())
    stream.on('error', (err) => reject(err))
  })
  options.ws.data.state.stream = null

  return streamedText.trim()
}
