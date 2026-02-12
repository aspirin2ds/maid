import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { websocket } from 'hono/bun'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import Redis from 'ioredis'
import { Pool } from 'pg'

import { env } from './env'
import type { AppEnv, BetterAuthSessionResponse } from './types'
import { createMemoryService } from './memory'
import { createMemoryExtractionQueue } from './memory/queue'
import { createSessionService } from './session'
import { streamWebSocket } from './ws'

import * as schema from './db/schema'
const databaseClient = new Pool({ connectionString: env.DATABASE_URL })
const database = drizzle(databaseClient, { schema })

const redisClient = new Redis(env.REDIS_URL, { lazyConnect: true })
const memoryExtractionQueue = createMemoryExtractionQueue(redisClient.duplicate({ maxRetriesPerRequest: null }), database)

const app = new Hono<AppEnv>()
let isShuttingDown = false

const unauthorized = (context: Context<AppEnv>) => {
  context.header('WWW-Authenticate', 'Bearer')
  return context.json({ error: 'Unauthorized' }, 401)
}

const authUnavailable = (context: Context<AppEnv>) => {
  return context.json({ error: 'Auth service unavailable' }, 503)
}

function getAuthorizationHeader(context: Context<AppEnv>) {
  const header = context.req.header('authorization')
  if (header?.startsWith('Bearer ')) {
    return header
  }

  // Browsers cannot set custom websocket headers, so allow token via query for /stream.
  const token = context.req.query('token')
  if (!token) {
    return null
  }

  return token.startsWith('Bearer ') ? token : `Bearer ${token}`
}

const requireAuth = createMiddleware(async (c, next) => {
  const authorization = getAuthorizationHeader(c)

  if (!authorization?.startsWith('Bearer ')) {
    return unauthorized(c)
  }

  const response = await fetch(new URL('/api/auth/get-session', env.BETTER_AUTH_URL), {
    method: 'GET',
    headers: {
      authorization,
      accept: 'application/json',
      origin: env.AUTH_ORIGIN,
    },
  })

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return unauthorized(c)
    }

    console.error('Better Auth get-session failed', response.status)
    return authUnavailable(c)
  }

  const sessionData = (await response.json()) as BetterAuthSessionResponse | null

  if (!sessionData?.user?.id) {
    return unauthorized(c)
  }

  c.set('userId', sessionData.user.id)
  await next()
})

const withUserServices = createMiddleware(async (c, next) => {
  const userId = c.get('userId')

  c.set('sessionService', createSessionService({
    database,
    redisClient,
    userId,
  }))

  c.set('memoryService', createMemoryService({
    database,
    userId,
    enqueueMemory: memoryExtractionQueue.enqueue,
  }))

  await next()
})

app.get('/stream/:maid', requireAuth, withUserServices, streamWebSocket)

app.get('/', (c) => c.text('Hello, Maid!'))

app.get('/db/health', async (context) => {
  const result = await database.execute<{ ok: number }>(sql`select 1 as ok`)
  const ok = result.rows[0]?.ok === 1

  return context.json({ ok })
})

app.get('/redis/health', async (context) => context.json({ ok: (await redisClient.ping()) === 'PONG' }))

async function closeResources() {
  const results = await Promise.allSettled([
    memoryExtractionQueue.close(),
    redisClient.quit(),
    databaseClient.end(),
  ])

  const rejected = results.filter((result) => result.status === 'rejected')
  if (rejected.length > 0) {
    console.error('[shutdown] failed to close all resources', rejected)
    throw new Error('Failed to close all resources')
  }
}

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`[shutdown] received ${signal}, closing resources...`)
  const timeout = setTimeout(() => {
    console.error('[shutdown] timed out, forcing exit')
    process.exit(1)
  }, env.APP_SHUTDOWN_TIMEOUT_MS)
  timeout.unref?.()

  try {
    await closeResources()
  } catch {
    clearTimeout(timeout)
    process.exit(1)
  }

  clearTimeout(timeout)
  console.log('[shutdown] completed')
  process.exit(0)
}

process.once('SIGINT', () => {
  void gracefulShutdown('SIGINT')
})

process.once('SIGTERM', () => {
  void gracefulShutdown('SIGTERM')
})

export default {
  port: env.PORT,
  fetch: app.fetch,
  websocket,
  close: closeResources,
}
