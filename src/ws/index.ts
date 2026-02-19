import type { ServerWebSocket } from 'bun'
import { ZodError } from 'zod'
import PQueue from 'p-queue'
import type { streamResponse } from '../llm'
import { logger } from '../logger'
import type { MemoryService } from '../memory'
import type { Session, SessionService } from '../session'
import { findStreamSocketHandler, type StreamSocketHandler } from './maids'
import { clientMessage, send } from './schema'

/** Abort the active LLM stream and reject its pending promise. */
function abortCurrentStream(ws: ServerWebSocket<StreamSocketData>): void {
  const { stream, rejectStream } = ws.data.state
  if (!stream) return

  stream.abort()
  ws.data.state.stream = null
  if (rejectStream) {
    ws.data.state.rejectStream = null
    rejectStream(new Error('stream aborted'))
  }
}

/** Mark connection as aborted, clear the queue, and abort the stream once idle. */
function handleAbort(ws: ServerWebSocket<StreamSocketData>): void {
  ws.data.state.aborted = true
  ws.data.q.clear()
  ws.data.q.onIdle().then(() => abortCurrentStream(ws)).catch((err) => {
    logger.error({ error: err }, 'ws.abort.error')
  })
}

function humanizeZodError(err: ZodError): string {
  return err.issues
    .map(i => {
      const path = i.path.length ? i.path.join('.') : 'root'
      return `${path}: ${i.message}`
    })
    .join('\n')
}

function formatParseError(err: unknown): string {
  if (err instanceof SyntaxError) return "invalid JSON"
  if (err instanceof ZodError) return humanizeZodError(err)
  if (err instanceof Error) return err.message
  return "unknown error"
}

export type StreamSocketData = {
  maidId: string
  sessionId?: number
  sessionService: SessionService
  memoryService: MemoryService

  q: PQueue
  state: StreamSocketState
}

type StreamSocketState = {
  session: Session | null // the session of this conversation
  stream: ReturnType<typeof streamResponse> | null // current openai stream
  aborted: boolean
  rejectStream: ((reason: Error) => void) | null
}

/** Resolve the maid handler for this connection, closing the socket if unknown. */
function withMaid(ws: ServerWebSocket<StreamSocketData>): StreamSocketHandler | null {
  const maid = findStreamSocketHandler(ws.data.maidId)
  if (maid) return maid

  send(ws, { type: "error", message: `unknown maidId: ${ws.data.maidId}` })
  ws.close(1008, 'unknown maid')
  return null
}

export const streamWebSocketHandlers = {
  // Placeholder: actual data is set at WebSocket upgrade time
  data: {} as StreamSocketData,

  open(ws: ServerWebSocket<StreamSocketData>) {
    withMaid(ws)
  },

  message(ws: ServerWebSocket<StreamSocketData>, message: string | BufferSource) {
    if (typeof message !== "string") return

    let parsed: ReturnType<typeof clientMessage.parse>
    try {
      parsed = clientMessage.parse(JSON.parse(message))
    } catch (err) {
      send(ws, { type: "error", message: formatParseError(err) })
      return
    }

    const maid = withMaid(ws)
    if (!maid) return

    // abort and bye are connection-level operations, handled here
    if (parsed.type === 'abort') {
      handleAbort(ws)
      return
    }

    if (parsed.type === 'bye') {
      handleAbort(ws)
      ws.close(1000, 'bye')
      return
    }

    // welcome and input are queued so they run sequentially per connection
    ws.data.q.add(async () => {
      switch (parsed.type) {
        case 'welcome': return maid.onWelcome(ws, parsed)
        case 'input': return maid.onInput(ws, parsed)
      }
    }).catch((err) => {
      if (ws.data.state.aborted) return
      logger.error({ route: parsed.type, error: err }, 'ws.queue.error')
      send(ws, { type: "error", message: err instanceof Error ? err.message : "internal server error" })
      if (ws.data.sessionId !== undefined && !ws.data.state.session) {
        ws.close(1008, 'session not found')
      }
    })
  },

  close(ws: ServerWebSocket<StreamSocketData>) {
    handleAbort(ws)
    abortCurrentStream(ws)
  },

  error(_ws: ServerWebSocket, error: Error) {
    logger.error({ error }, 'ws.error')
  },
}
