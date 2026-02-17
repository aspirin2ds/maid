import type { ServerWebSocket } from 'bun'
import { ZodError } from 'zod'
import PQueue from 'p-queue'

import { streamResponse } from '../llm'
import type { MemoryService } from '../memory'
import type { Session } from '../session'
import type { SessionService } from '../session'
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

function humanizeZodError(err: ZodError): string {
  return err.issues
    .map(i => {
      const path = i.path.length ? i.path.join(".") : "root"
      return `${path}: ${i.message}`
    })
    .join("\n")
}

function handleAbort(ws: ServerWebSocket<StreamSocketData>) {
  const { stream } = ws.data.state
  if (stream) {
    stream.abort()
    ws.data.state.stream = null
  }
  ws.data.q.clear()
}

const route = createRouter({
  "chat.input": async (ws, msg) => {
    const { sessionService, memoryService } = ws.data

    // ensure session exists (create if needed)
    if (!ws.data.state.session) {
      ws.data.state.session = await sessionService.ensure(ws.data.sessionId)
    }
    const session = ws.data.state.session

    // save user message
    await session.saveMessage({ role: "user", content: msg.content })

    // build context from recent messages and related memories
    const [recentMessages, relatedMemories] = await Promise.all([
      session.listRecentMessages(20, true),
      memoryService.getRelatedMemories(msg.content),
    ])

    const parts: string[] = []

    if (relatedMemories.length > 0) {
      parts.push(
        "<memories>",
        ...relatedMemories.map(m => `- ${m.content}`),
        "</memories>",
        "",
      )
    }

    if (recentMessages.length > 1) {
      const history = recentMessages
        .slice(1) // exclude the message we just saved (it's at index 0, desc order)
        .reverse()
        .map(m => `[${m.role}]: ${m.content}`)
      parts.push(
        "<history>",
        ...history,
        "</history>",
        "",
      )
    }

    parts.push(`[user]: ${msg.content}`)

    const input = parts.join("\n")

    // stream LLM response
    const stream = streamResponse(input)
    ws.data.state.stream = stream

    let streamedText = ""
    stream.on("response.output_text.delta", (event) => {
      streamedText += event.delta
      send(ws, { type: "chat.delta", delta: event.delta })
    })

    let response
    try {
      response = await stream.finalResponse()
    } finally {
      ws.data.state.stream = null
    }

    await session.saveMessage({ role: "assistant", content: streamedText.trim() })
    send(ws, { type: "chat.done", sessionId: session.id })

    // enqueue memory extraction in the background
    memoryService.enqueueMemoryExtraction().catch(() => { })
  },
})

export const streamWebSocketHandlers = {
  data: {} as StreamSocketData,

  open(ws: ServerWebSocket<StreamSocketData>) {
    ws.data.q.add(async () => {
      // build a prompt by using recent messages and related memories
      // then use llm.generateText to generate a custom welcome message and send to client
    })
  },

  message(ws: ServerWebSocket<StreamSocketData>, message: string | BufferSource) {
    if (typeof message !== "string") return

    // abort bypasses the queue so it can cancel an in-flight stream immediately
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

    if (parsed.type === "chat.abort") {
      handleAbort(ws)
      return
    }

    ws.data.q.add(async () => {
      try {
        await route(ws, parsed)
      } catch (err) {
        console.error("WebSocket route error", err)
        send(ws, { type: "error", message: "internal server error" })
      }
    })
  },

  close(ws: ServerWebSocket<StreamSocketData>) {
  },

  error(ws: ServerWebSocket, error: Error) {
  },
}
