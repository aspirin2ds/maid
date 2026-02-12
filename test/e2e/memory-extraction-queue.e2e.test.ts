import 'dotenv/config'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Queue } from 'bullmq'
import { eq } from 'drizzle-orm'
import Redis from 'ioredis'

import { memories, messages, sessions } from '../../src/db/schema'
import {
  setupMemoryExtractionTestEnv,
  teardownMemoryExtractionTestEnv,
  type MemoryExtractionTestEnv,
} from './helpers/testcontainers'

const TEST_USER_ID = 'testUserId'
const QUEUE_NAME = 'memory-extraction'
const JOB_ID = `memory-${TEST_USER_ID}`

let env: MemoryExtractionTestEnv | undefined
let inspectorRedisClient: Redis | undefined
let inspectorQueue: Queue | undefined

async function waitFor(
  check: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 250
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await Bun.sleep(intervalMs)
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`)
}

async function cleanData() {
  await env!.db.delete(memories).where(eq(memories.userId, TEST_USER_ID))
  await env!.db.delete(messages)
  await env!.db.delete(sessions)
}

async function seedMessages(messagesToSeed: { role: 'user' | 'assistant'; content: string }[]) {
  const [session] = await env!.db.insert(sessions).values({ userId: TEST_USER_ID }).returning({ id: sessions.id })

  for (const message of messagesToSeed) {
    await env!.db.insert(messages).values({
      sessionId: session.id,
      role: message.role,
      content: message.content,
    })
  }
}

async function appendMessages(sessionId: number, messagesToSeed: { role: 'user' | 'assistant'; content: string }[]) {
  for (const message of messagesToSeed) {
    await env!.db.insert(messages).values({
      sessionId,
      role: message.role,
      content: message.content,
    })
  }
}

async function seedMessagesInNewSession(messagesToSeed: { role: 'user' | 'assistant'; content: string }[]) {
  const [session] = await env!.db.insert(sessions).values({ userId: TEST_USER_ID }).returning({ id: sessions.id })
  await appendMessages(session.id, messagesToSeed)
  return session.id
}

async function getUserMessages() {
  return env!.db
    .select({ id: messages.id, extractedAt: messages.extractedAt })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(eq(sessions.userId, TEST_USER_ID))
}

async function getUserMemories() {
  return env!.db
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(eq(memories.userId, TEST_USER_ID))
}

describe('Memory extraction queue e2e', () => {
  beforeAll(async () => {
    env = await setupMemoryExtractionTestEnv()
    inspectorRedisClient = env.redisClient.duplicate({ maxRetriesPerRequest: null })
    inspectorQueue = new Queue(QUEUE_NAME, { connection: inspectorRedisClient })
  }, 120_000)

  beforeEach(async () => {
    await cleanData()
    await inspectorQueue!.obliterate({ force: true })
  })

  afterAll(async () => {
    await Promise.allSettled([
      inspectorQueue?.close(),
      inspectorRedisClient?.quit(),
    ])
    await teardownMemoryExtractionTestEnv(env)
  }, 120_000)

  test(
    'enqueues and executes extraction job, then stores memories and marks messages',
    async () => {
      await seedMessages([
        { role: 'user', content: 'My name is Alice.' },
        { role: 'assistant', content: 'Nice to meet you, Alice.' },
        { role: 'user', content: 'I live in Seattle and love hiking on weekends.' },
      ])

      await env!.extractionQueue.enqueueMemoryExtraction({ userId: TEST_USER_ID })

      const queuedJob = await inspectorQueue!.getJob(JOB_ID)
      expect(queuedJob).not.toBeNull()
      if (queuedJob) {
        const state = await queuedJob.getState()
        expect(['delayed', 'waiting', 'active']).toContain(state)
      }

      await waitFor(async () => {
        const rows = await getUserMessages()
        if (rows.length === 0) return false
        return rows.every((row) => row.extractedAt !== null)
      }, { timeoutMs: 120_000 })

      const extractedMessages = await getUserMessages()
      expect(extractedMessages.length).toBe(3)
      expect(extractedMessages.every((row) => row.extractedAt !== null)).toBeTrue()

      const memoryRows = await getUserMemories()
      expect(memoryRows.length).toBeGreaterThan(0)

      await waitFor(async () => {
        const job = await inspectorQueue!.getJob(JOB_ID)
        if (!job) return true
        const state = await job.getState()
        return state !== 'delayed' && state !== 'waiting' && state !== 'active'
      }, { timeoutMs: 30_000 })
    },
    180_000,
  )

  test(
    'deduplicates enqueues for the same user while a delayed job exists',
    async () => {
      await seedMessages([
        { role: 'user', content: 'I have a cat named Mochi.' },
        { role: 'assistant', content: 'Mochi is a cute name.' },
      ])

      await env!.extractionQueue.enqueueMemoryExtraction({ userId: TEST_USER_ID })
      await env!.extractionQueue.enqueueMemoryExtraction({ userId: TEST_USER_ID })

      const jobs = await inspectorQueue!.getJobs(['delayed', 'waiting', 'active'])
      const matchingJobs = jobs.filter((job) => String(job.id) === JOB_ID)
      expect(matchingJobs.length).toBe(1)

      await waitFor(async () => {
        const rows = await getUserMessages()
        if (rows.length === 0) return false
        return rows.every((row) => row.extractedAt !== null)
      }, { timeoutMs: 120_000 })

      const memoryRows = await getUserMemories()
      expect(memoryRows.length).toBeGreaterThan(0)
    },
    180_000,
  )

  test(
    'debounces rapid enqueues and processes messages added during the debounce window',
    async () => {
      const sessionId = await seedMessagesInNewSession([
        { role: 'user', content: 'I am learning Spanish.' },
      ])

      await env!.extractionQueue.enqueueMemoryExtraction({ userId: TEST_USER_ID })

      await Bun.sleep(500)
      await appendMessages(sessionId, [
        { role: 'assistant', content: 'Great goal.' },
        { role: 'user', content: 'I practice every morning before work.' },
      ])

      // Second enqueue should be deduped while the delayed job is still pending.
      await env!.extractionQueue.enqueueMemoryExtraction({ userId: TEST_USER_ID })

      const jobs = await inspectorQueue!.getJobs(['delayed', 'waiting', 'active'])
      const matchingJobs = jobs.filter((job) => String(job.id) === JOB_ID)
      expect(matchingJobs.length).toBe(1)

      await waitFor(async () => {
        const rows = await getUserMessages()
        if (rows.length === 0) return false
        return rows.length === 3 && rows.every((row) => row.extractedAt !== null)
      }, { timeoutMs: 120_000 })

      const extractedMessages = await getUserMessages()
      expect(extractedMessages.length).toBe(3)
      expect(extractedMessages.every((row) => row.extractedAt !== null)).toBeTrue()

      const memoryRows = await getUserMemories()
      expect(memoryRows.length).toBeGreaterThan(0)
    },
    180_000,
  )
})
