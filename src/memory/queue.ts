import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type Redis from 'ioredis'

import type * as schema from '../db/schema'
import { env } from '../env'
import { createBullMqService } from '../queue'
import { extractMemory } from './extraction'

type MemoryExtractionJob = {
  userId: string
}

type Database = NodePgDatabase<typeof schema>

export type MemoryExtractionQueue = {
  enqueue: (payload: MemoryExtractionJob) => Promise<void>
  close: () => Promise<void>
}

function isDuplicateJobError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('Job') && error.message.includes('already exists')
}

export function createMemoryExtractionQueue(redisClient: Redis, database: Database): MemoryExtractionQueue {
  const service = createBullMqService<MemoryExtractionJob, void, string>({
    queueName: env.MEMORY_QUEUE_NAME,
    connection: redisClient,
    closeConnectionOnClose: true,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: env.MEMORY_QUEUE_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: env.MEMORY_QUEUE_BACKOFF_DELAY_MS,
      },
    },
    worker: {
      processor: async (job) => {
        await extractMemory(database, job.data.userId)
      },
      options: {
        concurrency: env.MEMORY_QUEUE_WORKER_CONCURRENCY,
      },
    },
  })

  return {
    enqueue: async ({ userId }) => {
      const jobId = `memory-${userId}`

      try {
        await service.enqueue(env.MEMORY_QUEUE_JOB_NAME, { userId }, {
          jobId,
          delay: env.MEMORY_QUEUE_DEBOUNCE_DELAY_MS,
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
