import 'dotenv/config'

import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import Redis from 'ioredis'

import { env } from './env'
import { getWebsocketHandler } from './maid'
import type { AppEnv, BetterAuthSessionResponse } from './types'

import * as schema from './db/schema'
const dbClient = postgres(env.DATABASE_URL)
const db = drizzle(dbClient, { schema })

const redis = new Redis(env.REDIS_URL, { lazyConnect: true })

const app = new Hono<AppEnv>()

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
  '/stream',
  requireSession,
  upgradeWebSocket(getWebsocketHandler({ db, redis }))
)

app.get('/', (c) => c.text('Hello, Maid!'))

app.get('/db/health', async (c) => {
  const result = await db.execute<{ ok: number }>(sql`select 1 as ok`)
  const ok = result[0]?.ok === 1

  return c.json({ ok })
})

app.get('/redis/health', async (c) => c.json({ ok: (await redis.ping()) === 'PONG' }))

export default {
  port: env.PORT,
  fetch: app.fetch,
  websocket,
}
