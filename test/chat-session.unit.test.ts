import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { GenericContainer, Wait } from 'testcontainers'
import Redis from 'ioredis'

import * as schema from '../src/db/schema'
import { sessions } from '../src/db/schema'
import { ChatMaid } from '../src/maid/chat'

// Mock streamResponse to avoid real LLM calls
mock.module('../src/llm', () => ({
  streamResponse: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'hi' }
    },
  }),
}))

const USER_ID = 'user_chat_test'

let postgresContainer: Awaited<ReturnType<GenericContainer['start']>> | null = null
let redisContainer: Awaited<ReturnType<GenericContainer['start']>> | null = null
let db: ReturnType<typeof drizzle<typeof schema>>
let dbClient: ReturnType<typeof postgres>
let redis: Redis

function createMockWs() {
  const sent: string[] = []
  return {
    send: (data: string) => { sent.push(data) },
    sent,
    close() {},
    raw: undefined,
    url: null,
    readyState: 1,
  }
}

function parseMessages(ws: ReturnType<typeof createMockWs>) {
  return ws.sent.map((s) => JSON.parse(s))
}

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

  dbClient = postgres(databaseUrl)
  db = drizzle(dbClient, { schema })

  redisContainer = await new GenericContainer('redis:7')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections', 1))
    .start()

  redis = new Redis({
    host: redisContainer.getHost(),
    port: redisContainer.getMappedPort(6379),
    lazyConnect: true,
  })
}, 120_000)

afterAll(async () => {
  redis?.disconnect()
  if (dbClient) await dbClient.end({ timeout: 5 })
  if (redisContainer) await redisContainer.stop()
  if (postgresContainer) await postgresContainer.stop()
})

afterEach(async () => {
  await db.delete(sessions)
})

describe('chat maid session concurrency', () => {
  test('creates exactly one session for a single message', async () => {
    const maid = new ChatMaid({ userId: USER_ID, db, redis })
    const ws = createMockWs()

    await maid.onMessage!(new MessageEvent('message', { data: 'hello' }), ws as any)

    const rows = await db.select().from(sessions)
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(USER_ID)

    const msgs = parseMessages(ws)
    expect(msgs.some((m: any) => m.type === 'session.created')).toBe(true)
  })

  test('creates exactly one session across sequential messages', async () => {
    const maid = new ChatMaid({ userId: USER_ID, db, redis })
    const ws = createMockWs()

    await maid.onMessage!(new MessageEvent('message', { data: 'first' }), ws as any)
    await maid.onMessage!(new MessageEvent('message', { data: 'second' }), ws as any)
    await maid.onMessage!(new MessageEvent('message', { data: 'third' }), ws as any)

    const rows = await db.select().from(sessions)
    expect(rows).toHaveLength(1)

    const created = parseMessages(ws).filter((m: any) => m.type === 'session.created')
    expect(created).toHaveLength(1)
  })

  test('creates exactly one session across concurrent messages', async () => {
    const maid = new ChatMaid({ userId: USER_ID, db, redis })
    const ws = createMockWs()

    await Promise.all([
      maid.onMessage!(new MessageEvent('message', { data: 'a' }), ws as any),
      maid.onMessage!(new MessageEvent('message', { data: 'b' }), ws as any),
      maid.onMessage!(new MessageEvent('message', { data: 'c' }), ws as any),
    ])

    const rows = await db.select().from(sessions)
    expect(rows).toHaveLength(1)

    const created = parseMessages(ws).filter((m: any) => m.type === 'session.created')
    expect(created).toHaveLength(1)
  })

  test('concurrent messages all resolve to the same session id', async () => {
    const maid = new ChatMaid({ userId: USER_ID, db, redis })
    const ws = createMockWs()

    await Promise.all([
      maid.onMessage!(new MessageEvent('message', { data: 'a' }), ws as any),
      maid.onMessage!(new MessageEvent('message', { data: 'b' }), ws as any),
    ])

    const created = parseMessages(ws).filter((m: any) => m.type === 'session.created')
    expect(created).toHaveLength(1)

    const rows = await db.select().from(sessions)
    expect(rows).toHaveLength(1)
    expect(created[0].sessionId).toBe(rows[0].id)
  })

  test('separate maid instances create separate sessions', async () => {
    const maid1 = new ChatMaid({ userId: USER_ID, db, redis })
    const maid2 = new ChatMaid({ userId: USER_ID, db, redis })
    const ws1 = createMockWs()
    const ws2 = createMockWs()

    await Promise.all([
      maid1.onMessage!(new MessageEvent('message', { data: 'hello' }), ws1 as any),
      maid2.onMessage!(new MessageEvent('message', { data: 'hello' }), ws2 as any),
    ])

    const rows = await db.select().from(sessions)
    expect(rows).toHaveLength(2)

    const id1 = parseMessages(ws1).find((m: any) => m.type === 'session.created')!.sessionId
    const id2 = parseMessages(ws2).find((m: any) => m.type === 'session.created')!.sessionId
    expect(id1).not.toBe(id2)
  })
})
