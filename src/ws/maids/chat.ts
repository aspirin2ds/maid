import type { ServerWebSocket } from 'bun'

import {
  ensureSession,
  handleAbort,
  streamAndSendAssistantResponse,
} from '../stream'
import type { RelatedMemory } from '../../memory'
import type { Session } from '../../session'
import type { StreamSocketData } from '../index'
import { send } from '../schema'
import type { StreamSocketHandler } from './index'

type HistoryMessage = {
  role: string
  content: string
}

type MemoryItem = {
  content: string
}

// -- Prompt builders ----------------------------------------------------------

function buildWelcomeInput(recentMessages: HistoryMessage[], recentMemories: MemoryItem[]): string {
  const parts: string[] = [
    'You are a friendly assistant. Generate a concise welcome message for the user.',
    'Use known context when available, but do not invent personal details.',
  ]

  if (recentMemories.length > 0) {
    parts.push(
      '',
      '<memories>',
      ...recentMemories.map((m) => `- ${m.content}`),
      '</memories>',
    )
  }

  if (recentMessages.length > 0) {
    const history = recentMessages
      .slice(0, 10)
      .reverse()
      .map((m) => `[${m.role}]: ${m.content}`)
    parts.push(
      '',
      '<history>',
      ...history,
      '</history>',
    )
  }

  parts.push(
    '',
    "Write the welcome naturally as the assistant's first message.",
  )

  return parts.join('\n')
}

function buildChatInput(
  content: string,
  recentMessages: HistoryMessage[],
  relatedMemories: RelatedMemory[],
): string {
  const parts: string[] = []

  if (relatedMemories.length > 0) {
    parts.push(
      '<memories>',
      ...relatedMemories.map((m) => `- ${m.content}`),
      '</memories>',
      '',
    )
  }

  if (recentMessages.length > 1) {
    const history = recentMessages
      .slice(1) // exclude the message we just saved (desc order)
      .reverse()
      .map((m) => `[${m.role}]: ${m.content}`)
    parts.push(
      '<history>',
      ...history,
      '</history>',
      '',
    )
  }

  parts.push(`[user]: ${content}`)
  return parts.join('\n')
}

// -- Shared stream lifecycle --------------------------------------------------

/**
 * Common flow for welcome and input handlers:
 * ensure session → save user message (if any) → build prompt → stream LLM
 * response → save assistant message → notify client done.
 */
async function respondWithStream(options: {
  ws: ServerWebSocket<StreamSocketData>
  route: string
  buildInput: (session: Session) => Promise<string>
  saveUserMessage?: Parameters<Session['saveMessage']>[0]
}) {
  const start = Date.now()
  const { session, created } = await ensureSession(options.ws)
  if (created) {
    send(options.ws, { type: "session_created", sessionId: session.id })
  }

  if (options.saveUserMessage) {
    await session.saveMessage(options.saveUserMessage)
  }

  const input = await options.buildInput(session)
  send(options.ws, { type: "stream_start" })

  const assistantText = await streamAndSendAssistantResponse({
    ws: options.ws,
    route: options.route,
    sessionId: session.id,
    input,
    start,
  })

  await session.saveMessage({ role: "assistant", content: assistantText })
  send(options.ws, { type: "stream_done", sessionId: session.id })

  options.ws.data.memoryService.enqueueMemoryExtraction().catch(() => {})
}

export const chatMaidHandler: StreamSocketHandler = {
  onWelcome: async (ws) => {
    await respondWithStream({
      ws,
      route: 'welcome',
      buildInput: async (session) => {
        const [recentMessages, recentMemories] = await Promise.all([
          session.listRecentMessages(20, false),
          ws.data.memoryService.listRecentUpdatedMemories(20),
        ])
        return buildWelcomeInput(recentMessages, recentMemories)
      },
    })
  },

  onInput: async (ws, msg) => {
    await respondWithStream({
      ws,
      route: 'input',
      saveUserMessage: { role: "user", content: msg.content },
      buildInput: async (session) => {
        const [recentMessages, relatedMemories] = await Promise.all([
          session.listRecentMessages(20, true),
          ws.data.memoryService.getRelatedMemories(msg.content, { threshold: 0 }),
        ])
        return buildChatInput(msg.content, recentMessages, relatedMemories)
      },
    })
  },

  onAbort: (ws) => {
    handleAbort(ws)
  },

  onBye: (ws) => {
    handleAbort(ws)
    ws.close(1000, 'bye')
  },
}
