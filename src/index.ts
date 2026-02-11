import 'dotenv/config'

import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import Redis from 'ioredis'

import { env } from './env'
import { getMaid } from './maid'
import { createMemoryExtractionQueue } from './memory/queue'
import type { AppEnv, BetterAuthSessionResponse } from './types'

import * as schema from './db/schema'
const dbClient = postgres(env.DATABASE_URL)
const db = drizzle(dbClient, { schema })

const redis = new Redis(env.REDIS_URL, { lazyConnect: true })
const memoryExtractionQueue = createMemoryExtractionQueue(redis, db)

const app = new Hono<AppEnv>()
let isShuttingDown = false

const unauthorized = (c: Context<AppEnv>) => {
  c.header('WWW-Authenticate', 'Bearer')
  return c.json({ error: 'Unauthorized' }, 401)
}

const authUnavailable = (c: Context<AppEnv>) => {
  return c.json({ error: 'Auth service unavailable' }, 503)
}

function getAuthorizationHeader(c: Context<AppEnv>) {
  const header = c.req.header('authorization')
  if (header?.startsWith('Bearer ')) {
    return header
  }

  // Browsers cannot set custom websocket headers, so allow token via query for /stream.
  const token = c.req.query('token')
  if (!token) {
    return null
  }

  return token.startsWith('Bearer ') ? token : `Bearer ${token}`
}

const requireSession = createMiddleware(async (c, next) => {
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

  const data = (await response.json()) as BetterAuthSessionResponse | null

  if (!data?.user?.id) {
    return unauthorized(c)
  }

  c.set('userId', data.user.id)
  await next()
})

app.get(
  '/stream/:maid',
  requireSession,
  async (c, next) => {
    const sessionId = c.req.query('sessionId')
    const userId = c.get('userId')
    const maid = getMaid(c.req.param('maid'), {
      userId,
      sessionId: sessionId ? Number(sessionId) : undefined,
      db,
      redis,
      enqueueMemoryExtraction: memoryExtractionQueue.enqueueMemoryExtraction,
    })
    if (!maid) {
      return c.json({ error: 'Maid not found' }, 404)
    }
    return upgradeWebSocket(() => maid)(c, next)
  },
)

app.get('/', (c) => c.text('Hello, Maid!'))

app.get('/db/health', async (c) => {
  const result = await db.execute<{ ok: number }>(sql`select 1 as ok`)
  const ok = result[0]?.ok === 1

  return c.json({ ok })
})

app.get('/redis/health', async (c) => c.json({ ok: (await redis.ping()) === 'PONG' }))

async function closeResources() {
  const results = await Promise.allSettled([
    memoryExtractionQueue.close(),
    redis.quit(),
    dbClient.end({ timeout: 5 }),
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
  }, 10_000)
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
