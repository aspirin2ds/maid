import type { Redis } from 'ioredis'
import {
  Queue,
  QueueEvents,
  Worker,
  type JobsOptions,
  type Processor,
  type QueueOptions,
  type WorkerOptions,
} from 'bullmq'

type QueueWorkerOptions<DataType, ResultType, NameType extends string> = {
  processor: Processor<DataType, ResultType, NameType>
  options?: Omit<WorkerOptions, 'connection'>
}

export type CreateBullMqServiceOptions<DataType, ResultType, NameType extends string> = {
  queueName: NameType
  connection: Redis
  closeConnectionOnClose?: boolean
  defaultJobOptions?: JobsOptions
  queueOptions?: Omit<QueueOptions, 'connection' | 'defaultJobOptions'>
  worker?: QueueWorkerOptions<DataType, ResultType, NameType>
  enableQueueEvents?: boolean
}

export type BullMqService<DataType, ResultType, NameType extends string> = {
  queue: Queue<DataType, ResultType, NameType>
  worker: Worker<DataType, ResultType, NameType> | null
  queueEvents: QueueEvents | null
  enqueue: (...args: Parameters<Queue<DataType, ResultType, NameType>['add']>) => ReturnType<Queue<DataType, ResultType, NameType>['add']>
  close: () => Promise<void>
}

export function createBullMqService<DataType = unknown, ResultType = unknown, NameType extends string = string>(
  options: CreateBullMqServiceOptions<DataType, ResultType, NameType>,
): BullMqService<DataType, ResultType, NameType> {
  const queue = new Queue<DataType, ResultType, NameType>(options.queueName, {
    connection: options.connection,
    defaultJobOptions: options.defaultJobOptions,
    ...options.queueOptions,
  })

  const worker = options.worker
    ? new Worker<DataType, ResultType, NameType>(
      options.queueName,
      options.worker.processor,
      {
        connection: options.connection,
        ...options.worker.options,
      },
    )
    : null

  const queueEvents = options.enableQueueEvents
    ? new QueueEvents(options.queueName, { connection: options.connection })
    : null

  return {
    queue,
    worker,
    queueEvents,
    enqueue: (...args) => queue.add(...args),
    close: async () => {
      const closers: Array<Promise<unknown>> = [queue.close()]

      if (worker) {
        closers.push(worker.close())
      }

      if (queueEvents) {
        closers.push(queueEvents.close())
      }

      if (options.closeConnectionOnClose) {
        closers.push(
          options.connection.quit().catch((error: unknown) => {
            // ioredis throws if quit/disconnect already happened elsewhere.
            if (error instanceof Error && error.message.includes('Connection is closed')) {
              return
            }

            throw error
          }),
        )
      }

      const results = await Promise.allSettled(closers)
      const failed = results.filter((result) => result.status === 'rejected')

      if (failed.length > 0) {
        throw new Error(`Failed to close BullMQ resources (${failed.length})`)
      }
    },
  }
}
