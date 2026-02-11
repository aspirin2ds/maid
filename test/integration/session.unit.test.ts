import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { GenericContainer, Wait } from 'testcontainers'
import Redis from 'ioredis'

import * as schema from '../../src/db/schema'
import { sessions, messages } from '../../src/db/schema'
import { createSession } from '../../src/session'

const USER_ID = 'user_session_test'
const OTHER_USER_ID = 'user_other'

let postgresContainer: Awaited<ReturnType<GenericContainer['start']>> | null = null
let redisContainer: Awaited<ReturnType<GenericContainer['start']>> | null = null
let database: ReturnType<typeof drizzle<typeof schema>>
let databaseClient: ReturnType<typeof postgres>
let redisClient: Redis

beforeAll(async () => {
  postgresContainer = await new GenericContainer('pgvector/pgvector:pg18')
    .withEnvironment({
      POSTGRES_DB: 'maid',
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 1))
    .start()

  const databaseUrl = `postgresql://postgres:postgres@${postgresContainer.getHost()}:${postgresContainer.getMappedPort(5432)}/maid`

  const startedAt = Date.now()
  const timeoutMs = 30_000
  let lastError: unknown = null

  while (Date.now() - startedAt < timeoutMs) {
    const client = postgres(databaseUrl)
    try {
      await client`CREATE EXTENSION IF NOT EXISTS vector`
      const migrationDb = drizzle(client)
      await migrate(migrationDb, { migrationsFolder: './drizzle' })
      await client.end({ timeout: 5 })
      break
    } catch (error) {
      lastError = error
      await client.end({ timeout: 5 })
      await Bun.sleep(500)
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Failed to setup database: ${String(lastError)}`)
      }
    }
  }

  databaseClient = postgres(databaseUrl)
  database = drizzle(databaseClient, { schema })

  redisContainer = await new GenericContainer('redis:7')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections', 1))
    .start()

  redisClient = new Redis({
    host: redisContainer.getHost(),
    port: redisContainer.getMappedPort(6379),
    lazyConnect: true,
  })
}, 120_000)

afterAll(async () => {
  redisClient?.disconnect()
  if (databaseClient) await databaseClient.end({ timeout: 5 })
  if (redisContainer) await redisContainer.stop()
  if (postgresContainer) await postgresContainer.stop()
})

afterEach(async () => {
  await database.delete(messages)
  await database.delete(sessions)
})

describe('createSession', () => {
  test('creates a session row in the database', async () => {
    const session = await createSession(USER_ID, database, redisClient)

    expect(session.id).toBeGreaterThan(0)
    expect(session.userId).toBe(USER_ID)
    expect(session.row.userId).toBe(USER_ID)
    expect(session.row.title).toBeNull()
  })

  test('creates a session with a title', async () => {
    const session = await createSession(USER_ID, database, redisClient, 'My Chat')

    expect(session.row.title).toBe('My Chat')
  })
})

describe('session.update', () => {
  test('updates the session title', async () => {
    const session = await createSession(USER_ID, database, redisClient)
    const updated = await session.update({ title: 'New Title' })

    expect(updated).toBeDefined()
    expect(updated!.title).toBe('New Title')
    expect(updated!.id).toBe(session.id)
  })

  test('updates the session metadata', async () => {
    const session = await createSession(USER_ID, database, redisClient)
    const updated = await session.update({ metadata: { theme: 'dark' } })

    expect(updated).toBeDefined()
    expect(updated!.metadata).toEqual({ theme: 'dark' })
  })

  test('sets updatedAt to a newer timestamp', async () => {
    const session = await createSession(USER_ID, database, redisClient)
    await Bun.sleep(10)
    const updated = await session.update({ title: 'Later' })

    expect(updated!.updatedAt.getTime()).toBeGreaterThan(session.row.createdAt.getTime())
  })
})

describe('session.delete', () => {
  test('removes the session from the database', async () => {
    const session = await createSession(USER_ID, database, redisClient)
    await session.delete()

    const rows = await database.select().from(sessions)
    expect(rows).toHaveLength(0)
  })

  test('cascades to messages', async () => {
    const session = await createSession(USER_ID, database, redisClient)
    await session.addMessage('user', 'hello')
    await session.delete()

    const rows = await database.select().from(messages)
    expect(rows).toHaveLength(0)
  })
})

describe('session.addMessage / getMessages', () => {
  test('adds and retrieves messages', async () => {
    const session = await createSession(USER_ID, database, redisClient)
    await session.addMessage('user', 'Hello')
    await session.addMessage('assistant', 'Hi there')

    const messageRows = await session.getMessages()
    expect(messageRows).toHaveLength(2)
    expect(messageRows[0].role).toBe('user')
    expect(messageRows[0].content).toBe('Hello')
    expect(messageRows[1].role).toBe('assistant')
    expect(messageRows[1].content).toBe('Hi there')
  })

  test('returns messages in chronological order', async () => {
    const session = await createSession(USER_ID, database, redisClient)
    await session.addMessage('user', 'first')
    await session.addMessage('assistant', 'second')
    await session.addMessage('user', 'third')

    const messageRows = await session.getMessages()
    expect(messageRows.map((m) => m.content)).toEqual(['first', 'second', 'third'])
  })

  test('stores metadata on messages', async () => {
    const session = await createSession(USER_ID, database, redisClient)
    const messageRow = await session.addMessage('user', 'hello', { source: 'web' })

    expect(messageRow.metadata).toEqual({ source: 'web' })
  })

  test('returns empty array for a deleted session', async () => {
    const session = await createSession(USER_ID, database, redisClient)
    await session.addMessage('user', 'hello')
    await session.delete()

    const messageRows = await session.getMessages()
    expect(messageRows).toHaveLength(0)
  })
})

describe('user isolation', () => {
  test('sessions are scoped to the creating user', async () => {
    const session1 = await createSession(USER_ID, database, redisClient)
    const session2 = await createSession(OTHER_USER_ID, database, redisClient)

    await session1.addMessage('user', 'from user 1')
    await session2.addMessage('user', 'from user 2')

    const msgs1 = await session1.getMessages()
    const msgs2 = await session2.getMessages()

    expect(msgs1).toHaveLength(1)
    expect(msgs1[0].content).toBe('from user 1')
    expect(msgs2).toHaveLength(1)
    expect(msgs2[0].content).toBe('from user 2')
  })
})
