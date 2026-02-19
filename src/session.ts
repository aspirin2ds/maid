import { and, desc, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type Redis from 'ioredis'

import * as schema from './db/schema'

type Database = NodePgDatabase<typeof schema>
type MessageRow = typeof schema.messages.$inferSelect
type MessageMetadata = Record<string, unknown>

type SaveMessageInput = {
  role: MessageRow['role']
  content: string
  metadata?: MessageMetadata
}

export type CreateSessionServiceOptions = {
  database: Database
  redisClient: Redis
  userId: string
}

export type Session = {
  id: number
  saveMessage: (input: SaveMessageInput) => Promise<MessageRow>
  listRecentMessages: (limit?: number, sameSession?: boolean) => Promise<MessageRow[]>
}

export type SessionService = {
  ensure: (sessionId?: number) => Promise<Session>
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: number, userId: string) {
    super(`Session ${sessionId} not found for user ${userId}`)
    this.name = 'SessionNotFoundError'
  }
}

export function createSessionService({ database, redisClient: _redisClient, userId }: CreateSessionServiceOptions): SessionService {
  const getOwnedSession = async (sessionId: number) => {
    const [session] = await database
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)))
      .limit(1)

    return session ?? null
  }

  const ensureSessionId = async (sessionId?: number) => {
    if (sessionId !== undefined) {
      const owned = await getOwnedSession(sessionId)
      if (!owned) {
        throw new SessionNotFoundError(sessionId, userId)
      }

      return sessionId
    }

    const [created] = await database
      .insert(schema.sessions)
      .values({
        userId,
        title: null,
        metadata: {},
      })
      .returning({ id: schema.sessions.id })

    return created.id
  }

  return {
    ensure: async (sessionId) => {
      const resolvedSessionId = await ensureSessionId(sessionId)

      return {
        id: resolvedSessionId,

        saveMessage: async (input) => {
          const [created] = await database
            .insert(schema.messages)
            .values({
              sessionId: resolvedSessionId,
              role: input.role,
              content: input.content,
              metadata: input.metadata ?? {},
            })
            .returning()

          return created
        },

        listRecentMessages: async (limit = 20, sameSession = false) => {
          if (sameSession) {
            return database
              .select()
              .from(schema.messages)
              .where(eq(schema.messages.sessionId, resolvedSessionId))
              .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
              .limit(limit)
          }

          return database
            .select({
              id: schema.messages.id,
              sessionId: schema.messages.sessionId,
              role: schema.messages.role,
              content: schema.messages.content,
              metadata: schema.messages.metadata,
              extractedAt: schema.messages.extractedAt,
              createdAt: schema.messages.createdAt,
              updatedAt: schema.messages.updatedAt,
            })
            .from(schema.messages)
            .innerJoin(schema.sessions, eq(schema.sessions.id, schema.messages.sessionId))
            .where(eq(schema.sessions.userId, userId))
            .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
            .limit(limit)
        },
      }
    },
  }
}
