import type { ServerWebSocket } from 'bun'

import { streamResponse } from '../llm'
import { logger } from '../logger'
import type { Session } from '../session'
import type { StreamSocketData } from './index'
import { send } from './schema'

export type EnsureSessionResult = {
  session: Session
  created: boolean
}

/** Lazily create or retrieve the session attached to this WebSocket connection. */
export async function ensureSession(ws: ServerWebSocket<StreamSocketData>): Promise<EnsureSessionResult> {
  if (ws.data.state.session) {
    return { session: ws.data.state.session, created: false }
  }

  const created = ws.data.sessionId === undefined
  ws.data.state.session = await ws.data.sessionService.ensure(ws.data.sessionId)
  return { session: ws.data.state.session, created }
}

/** Stream an LLM response, forwarding text deltas to the client as they arrive. */
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
    send(options.ws, { type: 'stream_text_delta', delta: event.delta })
  })

  await new Promise<void>((resolve, reject) => {
    stream.on('response.completed', () => resolve())
    stream.on('error', (err) => reject(err))
  })
  options.ws.data.state.stream = null

  return streamedText.trim()
}
