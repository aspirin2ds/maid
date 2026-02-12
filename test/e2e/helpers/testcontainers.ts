import { drizzle } from 'drizzle-orm/node-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import Redis from 'ioredis'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Wait } from 'testcontainers'
import { Pool } from 'pg'

import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

import * as schema from '../../../src/db/schema'
import { createMemoryExtractionQueue, type MemoryExtractionQueue } from '../../../src/memory/queue'

type Database = NodePgDatabase<typeof schema>

export type MemoryExtractionTestEnv = {
  postgresContainer: StartedPostgreSqlContainer
  redisContainer: StartedRedisContainer
  sqlClient: Pool
  redisClient: Redis
  db: Database
  extractionQueue: MemoryExtractionQueue
}

async function applyMigrations(client: Pool) {
  await client.query('CREATE EXTENSION IF NOT EXISTS vector')

  const migrationPath = join(process.cwd(), 'drizzle', '0000_lush_lenny_balinger.sql')
  const migrationSql = readFileSync(migrationPath, 'utf8')

  const statements = migrationSql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean)

  for (const statement of statements) {
    await client.query(statement)
  }
}

export async function setupMemoryExtractionTestEnv(): Promise<MemoryExtractionTestEnv> {
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
  await applyMigrations(sqlClient)

  const db: Database = drizzle(sqlClient, { schema })

  const redisClient = new Redis(redisContainer.getConnectionUrl(), {
    maxRetriesPerRequest: null,
  })

  const extractionQueue = createMemoryExtractionQueue(
    redisClient.duplicate({ maxRetriesPerRequest: null }),
    db,
  )

  return {
    postgresContainer,
    redisContainer,
    sqlClient,
    redisClient,
    db,
    extractionQueue,
  }
}

export async function teardownMemoryExtractionTestEnv(env: MemoryExtractionTestEnv | undefined): Promise<void> {
  if (!env) return

  await Promise.allSettled([
    env.extractionQueue?.close(),
    env.redisClient?.quit(),
    env.sqlClient?.end(),
    env.redisContainer?.stop(),
    env.postgresContainer?.stop(),
  ])
}
