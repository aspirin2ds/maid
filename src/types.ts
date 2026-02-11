import type Redis from 'ioredis'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import type * as schema from './db/schema'

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
  db: PostgresJsDatabase<typeof schema>
  redis: Redis
}
