import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type Redis from 'ioredis'

import type * as schema from '../db/schema'
import { createBullMqService } from '../queue'
import { extractMemory } from './extraction'

const MEMORY_EXTRACTION_QUEUE = 'memory-extraction'
const MEMORY_EXTRACTION_JOB = 'memory.extract'
const DEBOUNCE_DELAY_MS = 3_000

type MemoryExtractionJob = {
  userId: string
}

type Database = NodePgDatabase<typeof schema>

export type MemoryExtractionQueue = {
  enqueueMemoryExtraction: (payload: MemoryExtractionJob) => Promise<void>
  close: () => Promise<void>
}

function isDuplicateJobError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('Job') && error.message.includes('already exists')
}

export function createMemoryExtractionQueue(redisClient: Redis, database: Database): MemoryExtractionQueue {
  const service = createBullMqService<MemoryExtractionJob, void, string>({
    queueName: MEMORY_EXTRACTION_QUEUE,
    connection: redisClient,
    closeConnectionOnClose: true,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1_000,
      },
    },
    worker: {
      processor: async (job) => {
        await extractMemory(database, job.data.userId)
      },
      options: {
        concurrency: 1,
      },
    },
  })

  return {
    enqueueMemoryExtraction: async ({ userId }) => {
      const jobId = `memory-${userId}`

      try {
        await service.enqueue(MEMORY_EXTRACTION_JOB, { userId }, {
          jobId,
          delay: DEBOUNCE_DELAY_MS,
        })
      } catch (error) {
        if (isDuplicateJobError(error)) return
        throw error
      }
    },
    close: async () => {
      await service.close()
    },
  }
}
