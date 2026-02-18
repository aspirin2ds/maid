import {
  ensureSession,
  handleAbort,
  streamAndSendAssistantResponse,
} from '../helpers'
import type { RelatedMemory } from '../../memory'
import { send } from '../schema'
import type { StreamSocketHandler } from './types'

type HistoryMessage = {
  role: string
  content: string
}

type MemoryItem = {
  content: string
}

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

export const chatMaidHandler: StreamSocketHandler = {
  onWelcome: async (ws) => {
    const start = Date.now()
    const { memoryService } = ws.data
    const { session, created } = await ensureSession(ws)
    if (created) {
      send(ws, { type: "session_created", sessionId: session.id })
    }

    const [recentMessages, recentMemories] = await Promise.all([
      session.listRecentMessages(20, false),
      memoryService.listRecentUpdatedMemories(20),
    ])

    const input = buildWelcomeInput(recentMessages, recentMemories)
    send(ws, { type: "stream_start" })

    const assistantText = await streamAndSendAssistantResponse({
      ws,
      route: 'welcome',
      sessionId: session.id,
      input,
      start,
    })

    await session.saveMessage({ role: "assistant", content: assistantText })
    send(ws, { type: "stream_done", sessionId: session.id })

    memoryService.enqueueMemoryExtraction().catch(() => { })
  },

  onInput: async (ws, msg) => {
    const start = Date.now()
    const { memoryService } = ws.data
    const { session, created } = await ensureSession(ws)
    if (created) {
      send(ws, { type: "session_created", sessionId: session.id })
    }

    await session.saveMessage({ role: "user", content: msg.content })

    const [recentMessages, relatedMemories] = await Promise.all([
      session.listRecentMessages(20, true),
      memoryService.getRelatedMemories(msg.content, { threshold: 0 }),
    ])

    const input = buildChatInput(msg.content, recentMessages, relatedMemories)
    send(ws, { type: "stream_start" })
    const assistantText = await streamAndSendAssistantResponse({
      ws,
      route: 'input',
      sessionId: session.id,
      input,
      start,
    })

    await session.saveMessage({ role: "assistant", content: assistantText })
    send(ws, { type: "stream_done", sessionId: session.id })

    memoryService.enqueueMemoryExtraction().catch(() => { })
  },

  onAbort: (ws) => {
    handleAbort(ws)
  },

  onBye: (ws) => {
    handleAbort(ws)
    ws.close(1000, 'bye')
  },
}
