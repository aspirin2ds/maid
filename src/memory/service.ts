import { and, desc, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type Redis from 'ioredis'

import * as schema from '../db/schema'
import { memories, toSqlVector } from '../db/schema'
import type { ExtractionResult } from './extraction'
import { extractMemory } from './extraction'
import type { MemoryExtractionEnqueuer } from './queue'

type Db = PostgresJsDatabase<typeof schema>
type MemoryRow = typeof memories.$inferSelect

export type MemoryCreateData = {
  content: string
  embedding?: number[]
  metadata?: Record<string, unknown>
}

export type MemoryUpdateData = {
  content?: string
  embedding?: number[] | null
  metadata?: Record<string, unknown>
}

export type Memory = {
  id: number
  userId: string
  row: MemoryRow
  update(data: MemoryUpdateData): Promise<MemoryRow | undefined>
  delete(): Promise<void>
}

export type MemoryService = {
  userId: string
  create(data: MemoryCreateData): Promise<Memory>
  load(memoryId: number): Promise<Memory | null>
  list(): Promise<MemoryRow[]>
  extractNow(): Promise<ExtractionResult>
  enqueueExtraction(): Promise<void>
}

function buildMemory(row: MemoryRow, userId: string, db: Db): Memory {
  const memoryId = row.id

  return {
    id: memoryId,
    userId,
    row,

    async update(data) {
      const changes: Partial<typeof memories.$inferInsert> = {
        updatedAt: new Date(),
      }

      if (data.content !== undefined) changes.content = data.content
      if (data.metadata !== undefined) changes.metadata = data.metadata
      if (data.embedding !== undefined) {
        changes.embedding = (data.embedding === null ? null : toSqlVector(data.embedding)) as any
      }

      const [updated] = await db
        .update(memories)
        .set(changes)
        .where(and(eq(memories.id, memoryId), eq(memories.userId, userId)))
        .returning()

      return updated
    },

    async delete() {
      await db
        .delete(memories)
        .where(and(eq(memories.id, memoryId), eq(memories.userId, userId)))
    },
  }
}

export async function loadMemory(
  memoryId: number,
  userId: string,
  db: Db,
  _redis: Redis,
): Promise<Memory | null> {
  const [row] = await db
    .select()
    .from(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.userId, userId)))
    .limit(1)

  if (!row) return null

  return buildMemory(row, userId, db)
}

export async function createMemory(
  userId: string,
  db: Db,
  _redis: Redis,
  data: MemoryCreateData,
): Promise<Memory> {
  const [row] = await db
    .insert(memories)
    .values({
      userId,
      content: data.content,
      embedding: data.embedding ? toSqlVector(data.embedding) : null,
      metadata: data.metadata,
    })
    .returning()

  return buildMemory(row, userId, db)
}

export function createMemoryService(
  userId: string,
  db: Db,
  redis: Redis,
  enqueueMemoryExtraction?: MemoryExtractionEnqueuer,
): MemoryService {
  return {
    userId,
    create(data) {
      return createMemory(userId, db, redis, data)
    },
    load(memoryId) {
      return loadMemory(memoryId, userId, db, redis)
    },
    list() {
      return db
        .select()
        .from(memories)
        .where(eq(memories.userId, userId))
        .orderBy(desc(memories.createdAt))
    },
    extractNow() {
      return extractMemory(db, userId)
    },
    async enqueueExtraction() {
      if (!enqueueMemoryExtraction) return
      await enqueueMemoryExtraction({ userId })
    },
  }
}
