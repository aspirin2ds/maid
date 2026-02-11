import { Queue, QueueEvents, Worker, type JobsOptions } from 'bullmq'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import Redis from 'ioredis'

import type * as schema from '../db/schema'
import { logger } from '../logger'
import { extractMemory } from './extraction'

const MEMORY_EXTRACTION_QUEUE = 'm'
const MEMORY_EXTRACTION_JOB = 'x'
const MEMORY_EXTRACTION_DEBOUNCE_MS = 3_000

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 1_000,
  },
  removeOnComplete: true,
  removeOnFail: 500,
}

type Db = PostgresJsDatabase<typeof schema>

export type MemoryExtractionJobData = {
  userId: string
}

export type MemoryExtractionEnqueuer = (data: MemoryExtractionJobData) => Promise<void>

export type MemoryExtractionQueue = {
  enqueueMemoryExtraction: MemoryExtractionEnqueuer
  close: () => Promise<void>
}

export function createMemoryExtractionQueue(redis: Redis, db: Db): MemoryExtractionQueue {
  // Producer should fail fast if Redis is unavailable.
  const producerConnection = redis.duplicate({
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  })

  // Workers should keep waiting and reconnecting as needed.
  const workerConnection = redis.duplicate({
    maxRetriesPerRequest: null,
  })
  const eventsConnection = redis.duplicate({
    maxRetriesPerRequest: null,
  })

  const queue = new Queue<MemoryExtractionJobData>(MEMORY_EXTRACTION_QUEUE, {
    connection: producerConnection,
  })

  const worker = new Worker<MemoryExtractionJobData>(
    MEMORY_EXTRACTION_QUEUE,
    async (job) => {
      const { userId } = job.data
      const result = await extractMemory(db, userId)

      logger.info({
        userId,
        jobId: job.id,
        ...result,
      }, 'memory.extraction.job.completed')

      return result
    },
    {
      connection: workerConnection,
      concurrency: 1,
    },
  )

  const queueEvents = new QueueEvents(MEMORY_EXTRACTION_QUEUE, {
    connection: eventsConnection,
  })

  queueEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, failedReason }, 'memory.extraction.job.failed')
  })
  queueEvents.on('deduplicated', ({ jobId, deduplicatedJobId, deduplicationId }) => {
    logger.info({ jobId, deduplicatedJobId, deduplicationId }, 'memory.extraction.job.deduplicated')
  })
  worker.on('error', (error) => {
    logger.error({ error }, 'memory.extraction.worker.error')
  })

  return {
    async enqueueMemoryExtraction(data: MemoryExtractionJobData) {
      const deduplicationId = `memory:${data.userId}`
      await queue.add(MEMORY_EXTRACTION_JOB, data, {
        ...DEFAULT_JOB_OPTIONS,
        delay: MEMORY_EXTRACTION_DEBOUNCE_MS,
        deduplication: {
          id: deduplicationId,
          ttl: MEMORY_EXTRACTION_DEBOUNCE_MS,
          extend: true,
          replace: true,
        },
      })
    },
    async close() {
      await Promise.all([
        worker.close(),
        queueEvents.close(),
        queue.close(),
      ])
      await Promise.all([
        producerConnection.quit(),
        workerConnection.quit(),
        eventsConnection.quit(),
      ])
    },
  }
}
