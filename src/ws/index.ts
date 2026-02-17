import type { ServerWebSocket } from 'bun'
import { ZodError } from 'zod'
import PQueue from 'p-queue'
import type { streamResponse } from '../llm'
import { logger } from '../logger'
import type { MemoryService } from '../memory'
import type { Session } from '../session'
import type { SessionService } from '../session'
import {
  buildChatInput,
  buildWelcomeInput,
  ensureSession,
  handleAbort,
  humanizeZodError,
  streamAndSendAssistantResponse,
} from './helpers'
import { clientMessage, createRouter, send } from './schema'

export type StreamSocketData = {
  maidId: string
  sessionId?: number
  sessionService: SessionService
  memoryService: MemoryService

  q: PQueue
  state: StreamSocketState
}

type StreamSocketState = {
  session: Session | null // the session of this coversation
  stream: ReturnType<typeof streamResponse> | null // current openai stream
}

const route = createRouter({
  "chat.welcome": async (ws) => {
    const start = Date.now()
    const { memoryService } = ws.data
    const { session, created } = await ensureSession(ws)
    if (created) {
      send(ws, { type: "chat.session_created", sessionId: session.id })
    }

    const [recentMessages, recentMemories] = await Promise.all([
      session.listRecentMessages(20, false),
      memoryService.listRecentUpdatedMemories(20),
    ])

    const input = buildWelcomeInput(recentMessages, recentMemories)
    const assistantText = await streamAndSendAssistantResponse({
      ws,
      route: 'chat.welcome',
      sessionId: session.id,
      input,
      start,
    })

    await session.saveMessage({ role: "assistant", content: assistantText })
    send(ws, { type: "chat.done", sessionId: session.id })

    memoryService.enqueueMemoryExtraction().catch(() => { })
  },

  "chat.input": async (ws, msg) => {
    const start = Date.now()
    const { memoryService } = ws.data
    const { session, created } = await ensureSession(ws)
    if (created) {
      send(ws, { type: "chat.session_created", sessionId: session.id })
    }

    // save user message
    await session.saveMessage({ role: "user", content: msg.content })

    // build context from recent messages and related memories
    const [recentMessages, relatedMemories] = await Promise.all([
      session.listRecentMessages(20, true),
      memoryService.getRelatedMemories(msg.content, { threshold: 0 }),
    ])

    const input = buildChatInput(msg.content, recentMessages, relatedMemories)
    const assistantText = await streamAndSendAssistantResponse({
      ws,
      route: 'chat.input',
      sessionId: session.id,
      input,
      start,
    })

    await session.saveMessage({ role: "assistant", content: assistantText })
    send(ws, { type: "chat.done", sessionId: session.id })

    // enqueue memory extraction in the background
    memoryService.enqueueMemoryExtraction().catch(() => { })
  },
})

export const streamWebSocketHandlers = {
  data: {} as StreamSocketData,

  open(ws: ServerWebSocket<StreamSocketData>) {
    // ws.data.q.add(async () => {
    // build a prompt by using recent messages and related memories
    // then use llm.generateText to generate a custom welcome message and send to client
    // })
  },

  message(ws: ServerWebSocket<StreamSocketData>, message: string | BufferSource) {
    if (typeof message !== "string") return

    // abort bypasses the queue so it can cancel an in-flight stream immediately
    let parsed: ReturnType<typeof clientMessage.parse>
    try {
      parsed = clientMessage.parse(JSON.parse(message))
    } catch (err) {
      if (err instanceof SyntaxError) {
        send(ws, { type: "chat.error", message: "invalid JSON" })
      } else if (err instanceof ZodError) {
        send(ws, { type: "chat.error", message: humanizeZodError(err) })
      } else {
        send(ws, { type: "chat.error", message: err instanceof Error ? err.message : "unknown error" })
      }
      return
    }

    if (parsed.type === "chat.abort") {
      handleAbort(ws)
      return
    }

    ws.data.q.add(async () => {
      try {
        await route(ws, parsed)
      } catch (err) {
        logger.error({ route: parsed.type, error: err }, 'ws.route.error')
        send(ws, { type: "chat.error", message: err instanceof Error ? err.message : "internal server error" })
      }
    })
  },

  close(ws: ServerWebSocket<StreamSocketData>) {
  },

  error(ws: ServerWebSocket, error: Error) {
  },
}

