import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { sql } from 'drizzle-orm'
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers'

import { createDb } from '../src/db/client'
import { createRedis } from '../src/redis/client'

describe('real environment connections', () => {
  let postgresContainer: StartedTestContainer
  let redisContainer: StartedTestContainer
  let db: ReturnType<typeof createDb>['db']
  let closeDb: ReturnType<typeof createDb>['close']
  let redis: ReturnType<typeof createRedis>

  beforeAll(async () => {
    postgresContainer = await new GenericContainer('pgvector/pgvector:pg18')
      .withEnvironment({
        POSTGRES_DB: 'maid_test',
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'postgres',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forListeningPorts())
      .start()

    redisContainer = await new GenericContainer('redis:alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forListeningPorts())
      .start()

    const databaseUrl = `postgres://postgres:postgres@${postgresContainer.getHost()}:${postgresContainer.getMappedPort(5432)}/maid_test`
    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`

    const dbClient = createDb(databaseUrl)
    db = dbClient.db
    closeDb = dbClient.close
    redis = createRedis(redisUrl)
  }, 60_000)

  afterAll(async () => {
    if (redis) {
      redis.disconnect()
    }

    if (closeDb) {
      await closeDb()
    }

    if (redisContainer) {
      await redisContainer.stop()
    }

    if (postgresContainer) {
      await postgresContainer.stop()
    }
  }, 30_000)

  it('connects to postgres', async () => {
    const result = await db.execute<{ ok: number }>(sql`select 1 as ok`)

    expect(result[0]?.ok).toBe(1)
  })

  it('connects to redis', async () => {
    const pong = await redis.ping()

    expect(pong).toBe('PONG')
  })
})
