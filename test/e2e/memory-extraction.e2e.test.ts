import 'dotenv/config'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { GenericContainer, Wait } from 'testcontainers'

import * as schema from '../../src/db/schema'
import { memories, messages, sessions } from '../../src/db/schema'
import { extractMemory } from '../../src/memory/extraction'

const USER_ID = 'user_test'

let postgresContainer: Awaited<ReturnType<GenericContainer['start']>> | null = null
let db: ReturnType<typeof drizzle<typeof schema>> | null = null
let dbClient: ReturnType<typeof postgres> | null = null

async function setupPostgres() {
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

  // Enable pgvector extension + run migrations with retry (container may still be starting)
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
}

async function seedSession(db: ReturnType<typeof drizzle<typeof schema>>): Promise<number> {
  const [session] = await db.insert(sessions).values({ userId: USER_ID }).returning({ id: sessions.id })
  return session.id
}

async function seedMessages(
  db: ReturnType<typeof drizzle<typeof schema>>,
  sessionId: number,
  msgs: { role: 'user' | 'assistant'; content: string }[],
) {
  for (const msg of msgs) {
    await db.insert(messages).values({
      sessionId,
      role: msg.role,
      content: msg.content,
    })
  }
}

async function getAllMemories(db: ReturnType<typeof drizzle<typeof schema>>) {
  return db.select({ id: memories.id, content: memories.content }).from(memories).where(eq(memories.userId, USER_ID))
}

async function getUnextractedCount(db: ReturnType<typeof drizzle<typeof schema>>) {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(eq(sessions.userId, USER_ID))
  return Number(rows[0].count)
}

async function cleanTables(db: ReturnType<typeof drizzle<typeof schema>>) {
  await db.delete(memories).where(eq(memories.userId, USER_ID))
  await db.delete(messages)
  await db.delete(sessions)
}

describe('Memory extraction e2e', () => {
  beforeAll(async () => {
    await setupPostgres()
  }, 120_000)

  afterAll(async () => {
    if (dbClient) await dbClient.end({ timeout: 5 })
    if (postgresContainer) {
      await postgresContainer.stop()
      postgresContainer = null
    }
  })

  beforeEach(async () => {
    await cleanTables(db!)
  })

  test(
    'extracts facts from messages and adds new memories',
    async () => {
      const sessionId = await seedSession(db!)
      await seedMessages(db!, sessionId, [
        { role: 'user', content: 'Hi, my name is Alice and I work as a data scientist.' },
        { role: 'assistant', content: 'Nice to meet you, Alice! Data science is a great field.' },
        { role: 'user', content: 'I love hiking and my favorite food is sushi.' },
        { role: 'assistant', content: 'Hiking and sushi are wonderful choices!' },
      ])

      const result = await extractMemory(db!, USER_ID)

      expect(result.factsExtracted).toBeGreaterThan(0)
      expect(result.memoriesAdded).toBeGreaterThan(0)

      const mems = await getAllMemories(db!)
      expect(mems.length).toBeGreaterThan(0)

      const allContent = mems.map((m) => m.content.toLowerCase()).join(' ')
      expect(allContent).toContain('alice')
    },
    120_000,
  )

  test(
    'marks messages as extracted and skips them on re-run',
    async () => {
      const sessionId = await seedSession(db!)
      await seedMessages(db!, sessionId, [
        { role: 'user', content: 'My favorite color is blue.' },
        { role: 'assistant', content: 'Blue is a nice color!' },
      ])

      const first = await extractMemory(db!, USER_ID)
      expect(first.factsExtracted).toBeGreaterThan(0)
      expect(first.memoriesAdded).toBeGreaterThan(0)

      // Second run should find no unextracted messages
      const second = await extractMemory(db!, USER_ID)
      expect(second.factsExtracted).toBe(0)
      expect(second.memoriesAdded).toBe(0)

      // Memories from first run should still exist
      const mems = await getAllMemories(db!)
      expect(mems.length).toBeGreaterThan(0)
    },
    120_000,
  )

  test(
    'updates existing memories when new info arrives',
    async () => {
      const sessionId = await seedSession(db!)

      // First: establish a preference
      await seedMessages(db!, sessionId, [
        { role: 'user', content: 'I like playing tennis on weekends.' },
        { role: 'assistant', content: 'Tennis is fun!' },
      ])
      await extractMemory(db!, USER_ID)
      const memsBefore = await getAllMemories(db!)
      expect(memsBefore.length).toBeGreaterThan(0)

      // Second: add more detail about the same topic
      await seedMessages(db!, sessionId, [
        { role: 'user', content: 'Actually, I now play tennis with my friends every Saturday morning at the park.' },
        { role: 'assistant', content: 'That sounds like a great routine!' },
      ])
      const result = await extractMemory(db!, USER_ID)

      // Should have processed the new messages
      expect(result.factsExtracted).toBeGreaterThan(0)

      // Should have either updated or added memories
      expect(result.memoriesUpdated + result.memoriesAdded).toBeGreaterThan(0)

      const memsAfter = await getAllMemories(db!)
      const allContent = memsAfter.map((m) => m.content.toLowerCase()).join(' ')
      expect(allContent).toContain('saturday')
    },
    120_000,
  )

  test(
    'handles contradicting information',
    async () => {
      const sessionId = await seedSession(db!)

      // First: establish a fact
      await seedMessages(db!, sessionId, [
        { role: 'user', content: 'I am a vegetarian and I never eat meat.' },
        { role: 'assistant', content: 'Got it, you are vegetarian.' },
      ])
      await extractMemory(db!, USER_ID)
      const memsBefore = await getAllMemories(db!)
      expect(memsBefore.length).toBeGreaterThan(0)

      // Second: contradict it
      await seedMessages(db!, sessionId, [
        { role: 'user', content: 'I stopped being vegetarian. I eat chicken and beef now.' },
        { role: 'assistant', content: 'Understood, your diet has changed.' },
      ])
      const result = await extractMemory(db!, USER_ID)
      expect(result.factsExtracted).toBeGreaterThan(0)

      // Should have updated or deleted the old memory and/or added new ones
      expect(result.memoriesUpdated + result.memoriesDeleted + result.memoriesAdded).toBeGreaterThan(0)

      const memsAfter = await getAllMemories(db!)
      const allContent = memsAfter.map((m) => m.content.toLowerCase()).join(' ')
      // The new diet info should be reflected — LLM may phrase it in various ways
      expect(allContent).toMatch(/chicken|beef|meat|no longer vegetarian|stopped being vegetarian|diet|eat/)
    },
    120_000,
  )

  test(
    'returns empty result when no messages exist',
    async () => {
      const result = await extractMemory(db!, USER_ID)
      expect(result.factsExtracted).toBe(0)
      expect(result.memoriesAdded).toBe(0)
      expect(result.memoriesUpdated).toBe(0)
      expect(result.memoriesDeleted).toBe(0)
    },
    120_000,
  )

  test(
    'returns empty facts for trivial messages',
    async () => {
      const sessionId = await seedSession(db!)
      await seedMessages(db!, sessionId, [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help you?' },
      ])

      const result = await extractMemory(db!, USER_ID)
      // Trivial greetings should extract zero or very few facts
      expect(result.memoriesAdded).toBeLessThanOrEqual(1)
    },
    120_000,
  )
})
