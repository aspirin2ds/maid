import { desc, eq } from 'drizzle-orm'

import { messages, sessions } from '../db/schema'
import { createMemoryService } from '../memory/service'
import { createSession, loadSession, type Session } from '../session'
import type { HandlerDeps } from '../types'
import type { ConversationRepository, PromptHistoryItem, PromptMessage, UserMemoryStore } from './core'

type ResumedChatContext = {
  session: Session
  history: PromptHistoryItem[]
  memories: string[]
}

type WarmWelcomeContext = {
  memories: string[]
  recentConversation: PromptMessage[]
}

type ChatServiceDeps = {
  userId: string
  sessionId?: number
  conversationRepository: ConversationRepository
  memoryStore: UserMemoryStore
}

export class ChatService {
  private deps: ChatServiceDeps
  private sessionPromise: Promise<Session> | null = null

  constructor(deps: ChatServiceDeps) {
    this.deps = deps
  }

  static fromHandlerDeps(deps: HandlerDeps): ChatService {
    const memory = deps.memory ?? createMemoryService(
      deps.userId,
      deps.database,
      deps.redisClient,
      deps.enqueueMemoryExtraction,
    )

    return new ChatService({
      userId: deps.userId,
      sessionId: deps.sessionId,
      conversationRepository: {
        loadSession(sessionId, userId) {
          return loadSession(sessionId, userId, deps.database, deps.redisClient)
        },
        createSession(userId) {
          return createSession(userId, deps.database, deps.redisClient)
        },
        async findLatestSessionId(userId) {
          const rows = await deps.database
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.userId, userId))
            .orderBy(desc(sessions.createdAt))
            .limit(1)

          return rows[0]?.id ?? null
        },
        listSessionMessages(sessionId, limit) {
          return deps.database
            .select({ role: messages.role, content: messages.content })
            .from(messages)
            .where(eq(messages.sessionId, sessionId))
            .orderBy(desc(messages.createdAt))
            .limit(limit)
        },
      },
      memoryStore: {
        async list() {
          const memoryRows = await memory.list()
          return memoryRows.map((memoryRow) => memoryRow.content)
        },
        enqueueExtraction() {
          return memory.enqueueExtraction()
        },
      },
    })
  }

  async tryResumeSession(): Promise<ResumedChatContext | null> {
    const { sessionId, userId, conversationRepository, memoryStore } = this.deps
    if (!sessionId) return null

    const session = await conversationRepository.loadSession(sessionId, userId)
    if (!session) return null

    this.sessionPromise = Promise.resolve(session)

    const [messageRows, memories] = await Promise.all([
      session.getMessages(),
      memoryStore.list(userId),
    ])

    return {
      session,
      history: messageRows
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({
          role: message.role as PromptHistoryItem['role'],
          content: message.content,
        })),
      memories,
    }
  }

  async loadWelcomeContext(): Promise<WarmWelcomeContext> {
    const { userId, conversationRepository, memoryStore } = this.deps
    const [memories, latestSessionId] = await Promise.all([
      memoryStore.list(userId),
      conversationRepository.findLatestSessionId(userId),
    ])

    let recentConversation: PromptMessage[] = []
    if (latestSessionId !== null) {
      const messageRows = await conversationRepository.listSessionMessages(latestSessionId, 20)
      recentConversation = messageRows.reverse()
    }

    return { memories, recentConversation }
  }

  async getOrCreateSession(): Promise<{ session: Session, isNew: boolean }> {
    const { userId, conversationRepository } = this.deps
    let isNew = !this.sessionPromise
    if (isNew) {
      this.sessionPromise = conversationRepository.createSession(userId)
    }

    try {
      return { session: await this.sessionPromise!, isNew }
    } catch (error) {
      this.sessionPromise = null
      if (isNew) {
        throw error
      }

      isNew = true
      this.sessionPromise = conversationRepository.createSession(userId)
      try {
        return { session: await this.sessionPromise, isNew }
      } catch (retryError) {
        this.sessionPromise = null
        throw retryError
      }
    }
  }

  async persistUserMessage(session: Session, content: string) {
    await session.addMessage('user', content)
  }

  async persistAssistantMessage(session: Session, content: string) {
    await session.addMessage('assistant', content)
  }

  async enqueueMemoryExtraction() {
    await this.deps.memoryStore.enqueueExtraction(this.deps.userId)
  }
}
