import 'dotenv/config'

import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import Redis from 'ioredis'

import { env } from './env'
import * as schema from './db/schema'

const dbClient = postgres(env.DATABASE_URL)
const db = drizzle(dbClient, { schema })
const redis = new Redis(env.REDIS_URL, { lazyConnect: true })

type BetterAuthSessionResponse = {
  session: {
    id: string
    [key: string]: unknown
  }
  user: {
    id: string
    [key: string]: unknown
  }
}

const app = new Hono<{
  Variables: {
    session: BetterAuthSessionResponse['session']
    user: BetterAuthSessionResponse['user']
  }
}>()

function getAuthorizationHeader(c: any) {
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
    c.header('WWW-Authenticate', 'Bearer')
    return c.json({ error: 'Unauthorized' }, 401)
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
      c.header('WWW-Authenticate', 'Bearer')
      return c.json({ error: 'Unauthorized' }, 401)
    }

    console.error('Better Auth get-session failed', response.status)
    return c.json({ error: 'Auth service unavailable' }, 503)
  }

  const data = (await response.json()) as BetterAuthSessionResponse | null

  if (!data?.session || !data?.user) {
    c.header('WWW-Authenticate', 'Bearer')
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('session', data.session)
  c.set('user', data.user)
  await next()
})

app.get(
  '/stream',
  requireSession,
  upgradeWebSocket(() => {
    return {
      onOpen(_event, ws) {
        ws.send(JSON.stringify({ type: 'connected' }))
      },
      onMessage(event, ws) {
        ws.send(
          JSON.stringify({
            type: 'echo',
            data: typeof event.data === 'string' ? event.data : '[non-text message]',
          })
        )
      },
      onClose() {
        console.log('WebSocket /stream connection closed')
      },
      onError(event) {
        console.error('WebSocket /stream error', event)
      },
    }
  })
)

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/db/health', async (c) => {
  const result = await db.execute<{ ok: number }>(sql`select 1 as ok`)
  const ok = result[0]?.ok === 1

  return c.json({ ok })
})

app.get('/redis/health', async (c) => {
  const pong = await redis.ping()

  return c.json({ ok: pong === 'PONG' })
})

export default {
  port: env.PORT,
  fetch: app.fetch,
  websocket,
}
