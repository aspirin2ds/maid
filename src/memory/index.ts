import { and, asc, cosineDistance, desc, eq, lte } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import type * as schema from '../db/schema'
import { memories } from '../db/schema'
import { generateEmbeddings } from '../llm'

export * from './extraction'
export * from './queue'
export * from './prompts'

type Database = NodePgDatabase<typeof schema>

type EnqueueMemoryExtraction = (payload: { userId: string }) => Promise<void>

export type GetRelatedMemoriesOptions = {
  limit?: number
  threshold?: number
}

export type RelatedMemory = {
  id: number
  content: string
  metadata: typeof memories.$inferSelect['metadata']
  similarity: number
}

export type MemoryService = {
  getRelatedMemories: (query: string, options?: GetRelatedMemoriesOptions) => Promise<RelatedMemory[]>
  listRecentUpdatedMemories: (limit?: number) => Promise<Array<typeof memories.$inferSelect>>
  enqueueMemoryExtraction: () => Promise<void>
}

export type CreateMemoryServiceOptions = {
  database: Database
  enqueueMemoryExtraction: EnqueueMemoryExtraction
  userId: string
}

const DEFAULT_LIMIT = 5
const DEFAULT_THRESHOLD = 0.7

function toSimilarity(distance: number) {
  return 1 - distance
}

export function createMemoryService({
  database,
  enqueueMemoryExtraction,
  userId,
}: CreateMemoryServiceOptions): MemoryService {
  return {
    getRelatedMemories: async (query, options = {}) => {
      const [embedding] = await generateEmbeddings(query)
      const limit = options.limit ?? DEFAULT_LIMIT
      const threshold = options.threshold ?? DEFAULT_THRESHOLD
      const maxDistance = 1 - threshold
      const distance = cosineDistance(memories.embedding, embedding)

      const rows = await database
        .select({
          id: memories.id,
          content: memories.content,
          metadata: memories.metadata,
          distance,
        })
        .from(memories)
        .where(and(eq(memories.userId, userId), lte(distance, maxDistance)))
        .orderBy(asc(distance))
        .limit(limit)

      return rows.map((row) => ({
        id: row.id,
        content: row.content,
        metadata: row.metadata,
        similarity: toSimilarity(Number(row.distance)),
      }))
    },

    enqueueMemoryExtraction: async () => {
      await enqueueMemoryExtraction({ userId })
    },

    listRecentUpdatedMemories: async (limit = DEFAULT_LIMIT) => {
      return database
        .select()
        .from(memories)
        .where(eq(memories.userId, userId))
        .orderBy(desc(memories.updatedAt), desc(memories.id))
        .limit(limit)
    },
  }
}
