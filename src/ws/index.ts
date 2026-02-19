import type { ServerWebSocket } from 'bun'
import { ZodError } from 'zod'
import PQueue from 'p-queue'
import type { streamResponse } from '../llm'
import { logger } from '../logger'
import type { MemoryService } from '../memory'
import type { Session } from '../session'
import type { SessionService } from '../session'
import { findStreamSocketHandler } from './maids'
import { clientMessage, send } from './schema'

function humanizeZodError(err: ZodError): string {
  return err.issues
    .map(i => {
      const path = i.path.length ? i.path.join('.') : 'root'
      return `${path}: ${i.message}`
    })
    .join('\n')
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
}

/** Resolve the maid handler for this connection, closing the socket if unknown. */
function withMaid(ws: ServerWebSocket<StreamSocketData>) {
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
      if (err instanceof SyntaxError) {
        send(ws, { type: "error", message: "invalid JSON" })
      } else if (err instanceof ZodError) {
        send(ws, { type: "error", message: humanizeZodError(err) })
      } else {
        send(ws, { type: "error", message: err instanceof Error ? err.message : "unknown error" })
      }
      return
    }

    const maid = withMaid(ws)
    if (!maid) return

    // abort and bye run immediately, outside the queue
    if (parsed.type === 'abort') {
      maid.onAbort(ws, parsed)
      return
    }

    if (parsed.type === 'bye') {
      maid.onBye(ws, parsed)
      return
    }

    // welcome and input are queued so they run sequentially per connection
    ws.data.q.add(async () => {
      try {
        if (parsed.type === 'welcome') {
          await maid.onWelcome(ws, parsed)
          return
        }

        await maid.onInput(ws, parsed)
      } catch (err) {
        logger.error({ route: parsed.type, error: err }, 'ws.route.error')
        send(ws, { type: "error", message: err instanceof Error ? err.message : "internal server error" })
      }
    })
  },

  close(ws: ServerWebSocket<StreamSocketData>) {
    ws.data.q.clear()
    const stream = ws.data.state.stream
    if (stream) {
      stream.abort()
      ws.data.state.stream = null
    }
  },

  error(ws: ServerWebSocket, error: Error) {
    logger.error({ error }, 'ws.error')
  },
}
