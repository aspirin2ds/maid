import type { ServerWebSocket } from 'bun'
import type { ZodError } from 'zod'

import { streamResponse } from '../llm'
import { logger } from '../logger'
import type { RelatedMemory } from '../memory'
import type { Session } from '../session'
import type { StreamSocketData } from './index'
import { send } from './schema'

type HistoryMessage = {
  role: string
  content: string
}

type MemoryItem = {
  content: string
}

export function humanizeZodError(err: ZodError): string {
  return err.issues
    .map(i => {
      const path = i.path.length ? i.path.join('.') : 'root'
      return `${path}: ${i.message}`
    })
    .join('\n')
}

export function handleAbort(ws: ServerWebSocket<StreamSocketData>) {
  ws.data.q.clear()
  const { stream } = ws.data.state
  if (stream) {
    stream.abort()
    ws.data.state.stream = null
  }
  ws.data.q.onIdle().then(() => {
    const { stream } = ws.data.state
    if (stream) {
      stream.abort()
      ws.data.state.stream = null
    }
  })
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

export function buildWelcomeInput(recentMessages: HistoryMessage[], recentMemories: MemoryItem[]): string {
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

export function buildChatInput(
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
