import type { WSContext, WSEvents } from 'hono/ws'
import { z } from 'zod'

import {
  ChatUserMessageInputSchema,
  buildInstructions,
  buildWelcomePrompt,
  type ChatUserMessageInput,
  type PromptHistoryItem,
  type PromptMessage,
} from './core'
import { ChatService } from './service'
import { streamResponse, generateText } from '../llm'
import { logger } from '../logger'
import type { Session } from '../session'
import type { HandlerDeps } from '../types'

const wsMessageSchema = z.object({
  e: z.enum(['input', 'abort']),
  msg: z.string().optional(),
})

type IncomingEvent = z.infer<typeof wsMessageSchema>
export class ChatMaid implements WSEvents {
  private deps: HandlerDeps
  private chatService: ChatService
  // Tracks the active streaming response so abort/cleanup can cancel it.
  private currentStream: ReturnType<typeof streamResponse> | null = null
  // In-memory conversation for prompt construction during this socket session.
  private history: PromptHistoryItem[] = []
  private contextMemories: string[] = []
  private contextMessages: PromptMessage[] = []
  // Serializes inputs so overlapping messages do not race session/message writes.
  private processingPromise: Promise<void> = Promise.resolve()

  constructor(deps: HandlerDeps) {
    this.deps = deps
    this.chatService = ChatService.fromHandlerDeps(deps)
  }

  async onOpen(_event: Event, ws: WSContext) {
    try {
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

      const input = this.parseUserMessageInput(incoming.msg)
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

  private parseUserMessageInput(rawMessage: unknown): ChatUserMessageInput | null {
    const parsed = ChatUserMessageInputSchema.safeParse({ message: rawMessage ?? '' })
    if (!parsed.success) {
      logger.warn({ error: parsed.error.message, rawMessage }, 'chat.message.invalid_input')
      return null
    }
    return parsed.data
  }

  // --- Session loading ---

  private async tryResumeSession(ws: WSContext): Promise<boolean> {
    const resumed = await this.chatService.tryResumeSession()
    if (!resumed) {
      if (this.deps.sessionId) {
        logger.warn({ userId: this.deps.userId, sessionId: this.deps.sessionId }, 'chat.resume.not_found')
      }
      return false
    }

    this.history = resumed.history
    this.contextMemories = resumed.memories

    this.send(ws, { type: 'session.resumed', sessionId: resumed.session.id })
    logger.info({
      userId: this.deps.userId,
      sessionId: resumed.session.id,
      messageCount: resumed.history.length,
    }, 'chat.resumed')
    return true
  }

  // --- Context loading ---

  private async loadContext() {
    const context = await this.chatService.loadWelcomeContext()
    this.contextMemories = context.memories
    this.contextMessages = context.recentConversation
  }

  // --- Prompt builders ---

  private buildWelcomePrompt(): string {
    return buildWelcomePrompt({
      memories: this.contextMemories,
      recentConversation: this.contextMessages,
    })
  }

  private buildInstructions(input: ChatUserMessageInput): string {
    return buildInstructions({
      memories: this.contextMemories,
      recentConversation: this.contextMessages,
      history: this.history,
      input,
    })
  }

  // --- Input queue ---

  private enqueueInput(input: ChatUserMessageInput, ws: WSContext): Promise<void> {
    // Keep the queue alive even if a previous task failed.
    this.processingPromise = this.processingPromise
      .catch(error => {
        logger.error({ error, userId: this.deps.userId }, 'chat.queue.recovered')
      })
      .then(() => this.processOne(input, ws))

    return this.processingPromise
  }

  private async processOne(input: ChatUserMessageInput, ws: WSContext) {
    // Ensure persistence target exists before streaming any assistant output.
    const { session, isNew } = await this.chatService.getOrCreateSession()

    if (isNew) {
      this.send(ws, { type: 'session.created', sessionId: session.id })
    }

    await this.chatService.persistUserMessage(session, input.message)
    this.history.push({ role: 'user', content: input.message })
    await this.streamAndSend(input, ws, session)
  }

  // --- Streaming ---

  private async streamAndSend(input: ChatUserMessageInput, ws: WSContext, session: Session) {
    const instructions = this.buildInstructions(input)
    let assistantText = ''

    try {
      const stream = streamResponse(input.message, instructions)
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

      await this.chatService.persistAssistantMessage(session, assistantText)
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
      await this.chatService.enqueueMemoryExtraction()
    } catch (error) {
      logger.error({ error, userId: this.deps.userId }, 'chat.memory_extraction.enqueue_failed')
    }
  }
}
