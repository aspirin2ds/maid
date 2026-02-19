import type { ServerWebSocket } from 'bun'
import { ZodError } from 'zod'
import PQueue from 'p-queue'
import type { streamResponse } from '../llm'
import { logger } from '../logger'
import type { MemoryService } from '../memory'
import type { Session, SessionService } from '../session'
import { SessionNotFoundError } from '../session'
import { findStreamSocketHandler, type StreamSocketHandler } from './maids'
import { clientMessage, send } from './schema'
import { StreamAbortedError } from './stream'

/** Abort the active LLM stream. The stream emits an error event which rejects the pending promise. */
function abortCurrentStream(ws: ServerWebSocket<StreamSocketData>): boolean {
  const { stream } = ws.data.state
  if (!stream) return false

  stream.abort()
  ws.data.state.stream = null
  return true
}

/** Clear pending tasks and abort only the active stream for this connection. */
function cancelInFlightWork(ws: ServerWebSocket<StreamSocketData>): void {
  ws.data.q.clear()
  abortCurrentStream(ws)
}

/** Connection is closing; stop all current and queued work. */
function closeConnectionWork(ws: ServerWebSocket<StreamSocketData>): void {
  ws.data.state.closing = true
  cancelInFlightWork(ws)
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
  session: Session | null
  stream: ReturnType<typeof streamResponse> | null
  closing: boolean
}

type CreateStreamSocketDataOptions = {
  maidId: string
  sessionId?: number
  sessionService: SessionService
  memoryService: MemoryService
}

export function createStreamSocketData(options: CreateStreamSocketDataOptions): StreamSocketData {
  return {
    maidId: options.maidId,
    sessionId: options.sessionId,
    sessionService: options.sessionService,
    memoryService: options.memoryService,
    q: new PQueue({ concurrency: 1 }),
    state: {
      session: null,
      stream: null,
      closing: false,
    },
  }
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
      cancelInFlightWork(ws)
      return
    }

    if (parsed.type === 'bye') {
      closeConnectionWork(ws)
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
      if (err instanceof StreamAbortedError || ws.data.state.closing) return
      logger.error({ route: parsed.type, error: err }, 'ws.queue.error')
      send(ws, { type: "error", message: err instanceof Error ? err.message : "internal server error" })
      if (err instanceof SessionNotFoundError) {
        ws.close(1008, 'session not found')
      }
    })
  },

  close(ws: ServerWebSocket<StreamSocketData>) {
    closeConnectionWork(ws)
  },

  error(_ws: ServerWebSocket, error: Error) {
    logger.error({ error }, 'ws.error')
  },
}
