import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import Redis from 'ioredis'
import { GenericContainer, Wait } from 'testcontainers'

const extractionCalls: string[] = []

mock.module('../../src/memory/extraction', () => ({
  extractMemory: async (_database: unknown, userId: string) => {
    extractionCalls.push(userId)
    return {
      factsExtracted: 0,
      memoriesAdded: 0,
      memoriesUpdated: 0,
      memoriesDeleted: 0,
      memoriesUnchanged: 0,
    }
  },
}))

import { createMemoryExtractionQueue } from '../../src/memory/queue'

let redisContainer: Awaited<ReturnType<GenericContainer['start']>> | null = null
let redisClient: Redis | null = null

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 100,
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return
    await Bun.sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`)
}

describe('memory queue debounce', () => {
  beforeAll(async () => {
    redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start()

    redisClient = new Redis({
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(6379),
      lazyConnect: true,
    })
  }, 120_000)

  afterAll(async () => {
    if (redisClient) {
      redisClient.disconnect()
      redisClient = null
    }

    if (redisContainer) {
      await redisContainer.stop()
      redisContainer = null
    }
  })

  beforeEach(() => {
    extractionCalls.length = 0
  })

  test(
    'debounces duplicate extraction jobs for the same user',
    async () => {
      if (!redisClient) throw new Error('Redis client was not initialized')

      const queue = createMemoryExtractionQueue(redisClient, {} as any)
      const userId = 'debounce-user'

      try {
        await Promise.all([
          queue.enqueueMemoryExtraction({ userId }),
          queue.enqueueMemoryExtraction({ userId }),
          queue.enqueueMemoryExtraction({ userId }),
          queue.enqueueMemoryExtraction({ userId }),
        ])

        await waitForCondition(() => extractionCalls.length === 1)
        expect(extractionCalls).toEqual([userId])
      } finally {
        await queue.close()
      }
    },
    120_000,
  )
})
