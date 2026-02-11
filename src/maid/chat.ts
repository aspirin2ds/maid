import { desc, eq } from 'drizzle-orm'
import type { WSContext, WSEvents } from 'hono/ws'
import { z } from 'zod'

import { messages, sessions } from '../db/schema'
import { streamResponse, generateText } from '../llm'
import { logger } from '../logger'
import { createMemoryService, type MemoryService } from '../memory/service'
import { createSession, loadSession } from '../session'
import type { Session } from '../session'
import type { HandlerDeps } from '../types'

const wsMessageSchema = z.object({
  e: z.enum(['input', 'abort']),
  msg: z.string().optional(),
})

type IncomingEvent = z.infer<typeof wsMessageSchema>
type HistoryRole = 'user' | 'assistant'
type HistoryItem = { role: HistoryRole, content: string }
type ContextMessage = { role: string, content: string }

export class ChatMaid implements WSEvents {
  private deps: HandlerDeps
  // Session is lazily created on first user input and reused for the WS lifetime.
  private sessionPromise: Promise<Session> | null = null
  // Tracks the active streaming response so abort/cleanup can cancel it.
  private currentStream: ReturnType<typeof streamResponse> | null = null
  // In-memory conversation for prompt construction during this socket session.
  private history: HistoryItem[] = []
  private contextMemories: string[] = []
  private contextMessages: ContextMessage[] = []
  private memory: MemoryService | null = null
  // Serializes inputs so overlapping messages do not race session/message writes.
  private processingPromise: Promise<void> = Promise.resolve()

  constructor(deps: HandlerDeps) {
    this.deps = deps
  }

  async onOpen(_event: Event, ws: WSContext) {
    try {
      this.getMemoryService()

      // If client reconnects with a session id, restore that conversation first.
      if (await this.tryResumeSession(ws)) {
        return
      }

      // Otherwise build warm-start context for a fresh welcome message.
      await this.loadContext()

      const prompt = this.buildWelcomePrompt()
      const welcomeText = await generateText(prompt)

      this.send(ws, { type: 'welcome', message: welcomeText })

      logger.info({
        userId: this.deps.userId,
        memoryCount: this.contextMemories.length,
        messageCount: this.contextMessages.length,
      }, 'chat.opened')
    } catch (error) {
      logger.error({ error, userId: this.deps.userId }, 'chat.open.failed')
      this.send(ws, {
        type: 'welcome',
        message: 'Hello! How can I help you today?',
      })
    }
  }

  async onMessage(event: MessageEvent, ws: WSContext) {
    try {
      const incoming = this.parseIncomingEvent(event)
      if (!incoming) {
        this.send(ws, { type: 'error', message: 'Invalid message format' })
        return
      }

      if (incoming.e === 'abort') {
        this.handleAbort(ws)
        return
      }

      const input = incoming.msg?.trim()
      if (!input) {
        this.send(ws, { type: 'error', message: 'Empty input' })
        return
      }

      // Queue work to keep a single ordered write/stream pipeline per socket.
      await this.enqueueInput(input, ws)
    } catch (error) {
      logger.error({ error }, 'chat.message.failed')
      this.send(ws, { type: 'error', message: 'Failed to process message' })
    }
  }

  onClose() {
    this.cleanup()
    logger.info({ userId: this.deps.userId }, 'chat.closed')
  }

  onError() {
    this.cleanup()
    logger.error({ userId: this.deps.userId }, 'chat.error')
  }

  // --- Message helpers ---

  private send(ws: WSContext, payload: Record<string, unknown>) {
    ws.send(JSON.stringify(payload))
  }

  private parseIncomingEvent(event: MessageEvent): IncomingEvent | null {
    const raw = typeof event.data === 'string' ? event.data : ''

    try {
      const parsed = wsMessageSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        logger.warn({ error: parsed.error.message, raw }, 'chat.message.invalid')
        return null
      }
      return parsed.data
    } catch (error) {
      logger.warn({ error, raw }, 'chat.message.invalid_json')
      return null
    }
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'APIUserAbortError'
  }

  private appendSection(parts: string[], title: string, body: string) {
    if (!body) return
    parts.push(`# ${title}\n${body}`)
  }

  private formatConversation(items: Array<{ role: string, content: string }>): string {
    return items.map(item => `${item.role}: ${item.content}`).join('\n')
  }

  private formatMemoryBullets(items: string[]): string {
    return items.map(item => `- ${item}`).join('\n')
  }

  private getMemoryService(): MemoryService {
    if (this.memory) return this.memory
    if (this.deps.memory) {
      this.memory = this.deps.memory
      return this.memory
    }

    this.memory = createMemoryService(
      this.deps.userId,
      this.deps.database,
      this.deps.redisClient,
      this.deps.enqueueMemoryExtraction,
    )
    return this.memory
  }

  // --- Session loading ---

  private async tryResumeSession(ws: WSContext): Promise<Session | null> {
    const { sessionId, userId, database, redisClient } = this.deps
    if (!sessionId) return null

    const session = await loadSession(sessionId, userId, database, redisClient)
    if (!session) {
      logger.warn({ userId, sessionId }, 'chat.resume.not_found')
      return null
    }

    this.sessionPromise = Promise.resolve(session)

    const [messageRows, memoryRows] = await Promise.all([
      session.getMessages(),
      this.getMemoryService().list(),
    ])

    this.history = messageRows
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role as HistoryRole, content: message.content }))
    this.contextMemories = memoryRows.map((memoryRow) => memoryRow.content)

    this.send(ws, { type: 'session.resumed', sessionId: session.id })
    logger.info({ userId, sessionId: session.id, messageCount: messageRows.length }, 'chat.resumed')
    return session
  }

  // --- Context loading ---

  private async loadContext() {
    const { database, userId } = this.deps

    const [memoryRows, recentSessions] = await Promise.all([
      this.getMemoryService().list(),
      database.select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(desc(sessions.createdAt))
        .limit(1),
    ])

    this.contextMemories = memoryRows.map((memoryRow) => memoryRow.content)

    if (recentSessions.length > 0) {
      // Keep latest message order for prompts, but limit payload size.
      const messageRows = await database
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.sessionId, recentSessions[0].id))
        .orderBy(desc(messages.createdAt))
        .limit(20)

      this.contextMessages = messageRows.reverse()
    }
  }

  // --- Prompt builders ---

  private buildWelcomePrompt(): string {
    const sections: string[] = [
      'You are a friendly AI assistant. Generate a brief, warm welcome message for the user.',
    ]

    this.appendSection(sections, 'User memories', this.formatMemoryBullets(this.contextMemories))
    this.appendSection(sections, 'Recent conversation', this.formatConversation(this.contextMessages))
    sections.push('Welcome message:')
    return sections.join('\n\n')
  }

  private buildInstructions(): string {
    const sections: string[] = []
    this.appendSection(sections, 'User Memories', this.contextMemories.join('\n'))
    this.appendSection(sections, 'Previous Conversation', this.formatConversation(this.contextMessages))
    this.appendSection(sections, 'Current Conversation', this.formatConversation(this.history))
    return sections.join('\n\n')
  }

  // --- Input queue ---

  private enqueueInput(input: string, ws: WSContext): Promise<void> {
    // Keep the queue alive even if a previous task failed.
    this.processingPromise = this.processingPromise
      .catch(error => {
        logger.error({ error, userId: this.deps.userId }, 'chat.queue.recovered')
      })
      .then(() => this.processOne(input, ws))

    return this.processingPromise
  }

  private async processOne(input: string, ws: WSContext) {
    this.history.push({ role: 'user', content: input })

    // Ensure persistence target exists before streaming any assistant output.
    const { session, isNew } = await this.getOrCreateSession()

    if (isNew) {
      this.send(ws, { type: 'session.created', sessionId: session.id })
    }

    await session.addMessage('user', input)
    await this.streamAndSend(input, ws, session)
  }

  private async getOrCreateSession(): Promise<{ session: Session, isNew: boolean }> {
    let isNew = !this.sessionPromise
    if (isNew) {
      this.sessionPromise = createSession(this.deps.userId, this.deps.database, this.deps.redisClient)
    }

    try {
      return { session: await this.sessionPromise!, isNew }
    } catch (error) {
      // A cached rejected promise can poison future attempts; clear and retry once.
      this.sessionPromise = null
      if (isNew) {
        throw error
      }

      isNew = true
      this.sessionPromise = createSession(this.deps.userId, this.deps.database, this.deps.redisClient)
      try {
        return { session: await this.sessionPromise, isNew }
      } catch (retryError) {
        this.sessionPromise = null
        throw retryError
      }
    }
  }

  // --- Streaming ---

  private async streamAndSend(input: string, ws: WSContext, session: Session) {
    const instructions = this.buildInstructions()
    let assistantText = ''

    try {
      const stream = streamResponse(input, instructions)
      this.currentStream = stream

      for await (const chunk of stream) {
        if (chunk.type === 'response.output_text.delta') {
          assistantText += chunk.delta
          this.send(ws, { type: 'text.delta', data: chunk.delta })
        }
      }

      this.send(ws, { type: 'text.done' })
      // Persist only the final assembled assistant message.
      this.history.push({ role: 'assistant', content: assistantText })
      this.currentStream = null

      await session.addMessage('assistant', assistantText)
      await this.enqueueMemoryExtraction()
    } catch (error) {
      this.currentStream = null
      if (this.isAbortError(error)) return

      logger.error({ error, userId: this.deps.userId }, 'chat.stream.failed')
      this.send(ws, { type: 'error', message: 'Failed to generate response' })
    }
  }

  // --- Abort & cleanup ---

  private handleAbort(ws: WSContext) {
    this.currentStream?.abort()
    logger.info({ userId: this.deps.userId }, 'chat.abort')
    this.send(ws, { type: 'aborted' })
    ws.close(1000, 'Aborted by user')
  }

  private cleanup() {
    this.currentStream?.abort()
    this.currentStream = null
    this.history = []
  }

  private async enqueueMemoryExtraction() {
    try {
      await this.getMemoryService().enqueueExtraction()
    } catch (error) {
      logger.error({ error, userId: this.deps.userId }, 'chat.memory_extraction.enqueue_failed')
    }
  }
}
