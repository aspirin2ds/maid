import type { ServerWebSocket } from 'bun'

import { streamResponse } from '../llm'
import { logger } from '../logger'
import type { Session } from '../session'
import type { StreamSocketData } from './index'
import { send } from './schema'

/** Lazily create or retrieve the session attached to this WebSocket connection. */
export async function ensureSession(ws: ServerWebSocket<StreamSocketData>): Promise<{
  session: Session
  created: boolean
}> {
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
  route: string
  sessionId: number
  input: string
  start: number
}): Promise<string> {
  const { ws, route, sessionId, input, start } = options
  const stream = streamResponse(input)
  ws.data.state.stream = stream

  // Prevent unhandled rejection: the OpenAI SDK emits an 'abort' event
  // with Promise.reject() when no abort listener is registered.
  stream.on('abort', () => {})

  let streamedText = ''
  let firstTokenLogged = false
  stream.on('response.output_text.delta', (event) => {
    if (!firstTokenLogged) {
      firstTokenLogged = true
      logger.info({ route, maidId: ws.data.maidId, sessionId, firstTokenMs: Date.now() - start }, 'ws.chat.first_token')
    }
    streamedText += event.delta
    send(ws, { type: 'stream_text_delta', delta: event.delta })
  })

  await new Promise<void>((resolve, reject) => {
    stream.on('response.completed', () => resolve())
    stream.on('error', reject)
  }).finally(() => {
    ws.data.state.stream = null
  })

  return streamedText.trim()
}
