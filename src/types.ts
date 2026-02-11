import type Redis from 'ioredis'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import type * as schema from './db/schema'
import type { MemoryExtractionEnqueuer } from './memory/queue'
import type { MemoryService } from './memory/service'

export type AppEnv = {
  Variables: {
    userId: string
  }
}

export type BetterAuthSessionResponse = {
  user: {
    id: string
  }
}

export type HandlerDeps = {
  userId: string
  sessionId?: number
  database: PostgresJsDatabase<typeof schema>
  redisClient: Redis
  memory?: MemoryService
  enqueueMemoryExtraction?: MemoryExtractionEnqueuer
}
