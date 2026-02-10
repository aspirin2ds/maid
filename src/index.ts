import 'dotenv/config'

import { Hono } from 'hono'
import { sql } from 'drizzle-orm'

import { env } from './env'

import { createDb } from './db/client'
import { createRedis } from './redis/client'

const { db } = createDb(env.DATABASE_URL)
const redis = createRedis(env.REDIS_URL)

const app = new Hono()

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
}
