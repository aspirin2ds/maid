import { drizzle } from 'drizzle-orm/node-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import Redis from 'ioredis'
import { Wait } from 'testcontainers'
import { Pool } from 'pg'

import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

import * as schema from '../../../src/db/schema'
import { createMemoryExtractionQueue, type MemoryExtractionQueue } from '../../../src/memory/queue'
import { runMigrations } from '../../../scripts/migrate'

type Database = NodePgDatabase<typeof schema>

export type E2eTestEnv = {
  postgresContainer: StartedPostgreSqlContainer
  redisContainer: StartedRedisContainer
  sqlClient: Pool
  redisClient: Redis
  db: Database
  memoryExtractionQueue: MemoryExtractionQueue
}

export async function setupE2eTestEnv(): Promise<E2eTestEnv> {
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true'

  const pgDb = 'maid_test_db'
  const pgUser = 'test'
  const pgPassword = 'test'

  const [postgresContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer('pgvector/pgvector:pg18')
      .withDatabase(pgDb)
      .withUsername(pgUser)
      .withPassword(pgPassword)
      .withWaitStrategy(Wait.forLogMessage(/ready to accept connections/, 2))
      .start(),
    new RedisContainer('redis:alpine').start(),
  ])

  const pgHost = postgresContainer.getHost()
  const pgPort = postgresContainer.getFirstMappedPort()
  const pgUri = `postgres://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${pgDb}`

  const sqlClient = new Pool({ connectionString: pgUri, max: 5 })
  await runMigrations(pgUri)

  const db: Database = drizzle(sqlClient, { schema })

  const redisClient = new Redis(redisContainer.getConnectionUrl(), {
    maxRetriesPerRequest: null,
  })

  const memoryExtractionQueue = createMemoryExtractionQueue(
    redisClient.duplicate({ maxRetriesPerRequest: null }),
    db,
  )

  return {
    postgresContainer,
    redisContainer,
    sqlClient,
    redisClient,
    db,
    memoryExtractionQueue,
  }
}

export async function teardownE2eTestEnv(env: E2eTestEnv | undefined): Promise<void> {
  if (!env) return

  await Promise.allSettled([
    env.memoryExtractionQueue?.close(),
    env.redisClient?.quit(),
    env.sqlClient?.end(),
    env.redisContainer?.stop(),
    env.postgresContainer?.stop(),
  ])
}
