import { eq, and } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type Redis from 'ioredis'

import * as schema from './db/schema'
import { sessions, messages } from './db/schema'

type SessionRow = typeof sessions.$inferSelect
type MessageRow = typeof messages.$inferSelect
type MessageRole = (typeof schema.messageRoleEnum.enumValues)[number]
type Db = PostgresJsDatabase<typeof schema>

export type Session = {
  id: number
  userId: string
  row: SessionRow
  update(data: { title?: string; metadata?: Record<string, unknown> }): Promise<SessionRow | undefined>
  delete(): Promise<void>
  addMessage(role: MessageRole, content: string, metadata?: Record<string, unknown>): Promise<MessageRow>
  getMessages(): Promise<MessageRow[]>
}

function buildSession(row: SessionRow, userId: string, db: Db): Session {
  const sessionId = row.id

  return {
    id: sessionId,
    userId,
    row,

    async update(data) {
      const [updated] = await db
        .update(sessions)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
        .returning()
      return updated
    },

    async delete() {
      await db
        .delete(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    },

    async addMessage(role, content, metadata?) {
      const [message] = await db
        .insert(messages)
        .values({ sessionId, role, content, metadata })
        .returning()
      return message
    },

    async getMessages() {
      return db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(messages.createdAt)
    },
  }
}

export async function loadSession(
  sessionId: number,
  userId: string,
  db: Db,
  _redis: Redis,
): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .limit(1)

  if (!row) return null

  return buildSession(row, userId, db)
}

export async function createSession(
  userId: string,
  db: Db,
  redis: Redis,
  title?: string,
): Promise<Session> {
  const [row] = await db
    .insert(sessions)
    .values({ userId, title })
    .returning()

  return buildSession(row, userId, db)
}
