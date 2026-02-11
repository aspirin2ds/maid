import 'dotenv/config'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { GenericContainer, Wait } from 'testcontainers'

import * as schema from '../../src/db/schema'
import { memories, messages, sessions } from '../../src/db/schema'

type AuthRequest = Request & {
  headers: Headers
}

const AUTH_TOKEN = 'test-token'
const USER_ID = 'user_test'

let postgresContainer: Awaited<ReturnType<GenericContainer['start']>> | null = null
let redisContainer: Awaited<ReturnType<GenericContainer['start']>> | null = null
let authServer: ReturnType<typeof Bun.serve> | null = null
let appServer: ReturnType<typeof Bun.serve> | null = null
const openSockets: WebSocket[] = []
let appClose: (() => Promise<void>) | null = null
let dbClient: ReturnType<typeof postgres> | null = null
let db: ReturnType<typeof drizzle<typeof schema>> | null = null

async function runMigrations(databaseUrl: string) {
  const startedAt = Date.now()
  const timeoutMs = 10_000
  let lastError: unknown = null

  while (Date.now() - startedAt < timeoutMs) {
    const migrationClient = postgres(databaseUrl)

    try {
      await migrationClient`CREATE EXTENSION IF NOT EXISTS vector`
      const migrationDb = drizzle(migrationClient)
      await migrate(migrationDb, { migrationsFolder: './drizzle' })
      await migrationClient.end({ timeout: 5 })
      return
    } catch (error) {
      lastError = error
      await migrationClient.end({ timeout: 5 })
      await Bun.sleep(150)
    }
  }

  throw new Error(`Failed to run migrations against test database: ${String(lastError)}`)
}

function parseJsonMessage(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
  if (typeof data === 'string') {
    return JSON.parse(data) as Record<string, unknown>
  }

  if (data instanceof Blob) {
    throw new Error('Expected text websocket payload, got blob')
  }

  let bytes: Uint8Array

  if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  } else {
    bytes = new Uint8Array(data)
  }

  const text = new TextDecoder().decode(bytes)
  return JSON.parse(text) as Record<string, unknown>
}

function waitForMessage(ws: WebSocket, timeoutMs = 8_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('error', onError)
    }

    const onMessage = (event: MessageEvent) => {
      try {
        const parsed = parseJsonMessage(event.data)
        cleanup()
        resolve(parsed)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }

    const onError = () => {
      cleanup()
      reject(new Error('WebSocket emitted an error event'))
    }

    ws.addEventListener('message', onMessage)
    ws.addEventListener('error', onError)
  })
}

function waitForMessages(
  ws: WebSocket,
  until: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = []

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for messages after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('error', onError)
    }

    const onMessage = (event: MessageEvent) => {
      try {
        const parsed = parseJsonMessage(event.data)
        messages.push(parsed)
        if (until(parsed)) {
          cleanup()
          resolve(messages)
        }
      } catch (error) {
        cleanup()
        reject(error)
      }
    }

    const onError = () => {
      cleanup()
      reject(new Error('WebSocket emitted an error event'))
    }

    ws.addEventListener('message', onMessage)
    ws.addEventListener('error', onError)
  })
}

function waitForOpen(ws: WebSocket, timeoutMs = 8_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for WebSocket open after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
    }

    const onOpen = () => {
      cleanup()
      resolve()
    }

    const onError = () => {
      cleanup()
      reject(new Error('Failed to open websocket connection'))
    }

    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
  })
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs = 45_000,
  intervalMs = 200,
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return
    await Bun.sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`)
}

function trackSocket(ws: WebSocket) {
  openSockets.push(ws)
  return ws
}

async function closeSocket(ws: WebSocket, timeoutMs = 5_000) {
  if (ws.readyState === WebSocket.CLOSED) return

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener('close', onClose)
      resolve()
    }, timeoutMs)

    const onClose = () => {
      clearTimeout(timeout)
      resolve()
    }

    ws.addEventListener('close', onClose, { once: true })
    ws.close(1000, 'test socket close')
  })
}

describe('WebSocket route with real dependencies', () => {
  beforeAll(async () => {
    postgresContainer = await new GenericContainer('pgvector/pgvector:pg18')
      .withEnvironment({
        POSTGRES_DB: 'maid',
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'postgres',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 1))
      .start()

    redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start()

    authServer = Bun.serve({
      port: 0,
      fetch(request: AuthRequest) {
        const url = new URL(request.url)
        if (url.pathname !== '/api/auth/get-session') {
          return new Response('Not found', { status: 404 })
        }

        const authorization = request.headers.get('authorization')
        if (authorization !== `Bearer ${AUTH_TOKEN}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }

        return Response.json({
          session: { id: 'session_test' },
          user: { id: 'user_test' },
        })
      },
    })

    process.env.DATABASE_URL = `postgresql://postgres:postgres@${postgresContainer.getHost()}:${postgresContainer.getMappedPort(5432)}/maid`
    process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
    process.env.BETTER_AUTH_URL = `http://127.0.0.1:${authServer.port}`
    process.env.AUTH_ORIGIN = `http://127.0.0.1:${authServer.port}`
    process.env.PORT = '0'
    await runMigrations(process.env.DATABASE_URL)
    dbClient = postgres(process.env.DATABASE_URL)
    db = drizzle(dbClient, { schema })

    const appModule = await import('../../src/index')
    appClose = typeof appModule.default.close === 'function' ? appModule.default.close : null
    appServer = Bun.serve({
      port: 0,
      fetch: appModule.default.fetch,
      websocket: appModule.default.websocket,
    })
  }, 120_000)

  afterAll(async () => {
    for (const ws of openSockets) {
      await closeSocket(ws)
    }

    appServer?.stop(true)
    if (appClose) {
      await appClose()
      appClose = null
    }
    authServer?.stop(true)
    if (dbClient) {
      await dbClient.end({ timeout: 5 })
      dbClient = null
    }

    if (redisContainer) {
      await redisContainer.stop()
      redisContainer = null
    }

    if (postgresContainer) {
      await postgresContainer.stop()
      postgresContainer = null
    }
  })

  test(
    'connects to /stream/chat and receives connected message',
    async () => {
      if (!appServer) {
        throw new Error('App server was not started')
      }

      const wsUrl = `ws://127.0.0.1:${appServer.port}/stream/chat?token=${AUTH_TOKEN}`
      const ws = trackSocket(new WebSocket(wsUrl))

      await waitForOpen(ws)

      const welcome = await waitForMessage(ws)
      expect(welcome.type).toBe('welcome')
      expect(typeof welcome.message).toBe('string')
    },
    120_000
  )

  test(
    'supports multi-turn conversation, session resume, and background memory extraction',
    async () => {
      if (!appServer || !db) {
        throw new Error('App server was not started')
      }
      const testDb = db

      await testDb.delete(memories).where(eq(memories.userId, USER_ID))
      await testDb.delete(messages)
      await testDb.delete(sessions).where(eq(sessions.userId, USER_ID))

      const wsUrl = `ws://127.0.0.1:${appServer.port}/stream/chat?token=${AUTH_TOKEN}`
      const ws = trackSocket(new WebSocket(wsUrl))

      await waitForOpen(ws)
      const welcome = await waitForMessage(ws)
      expect(welcome.type).toBe('welcome')

      ws.send(JSON.stringify({ e: 'input', msg: 'My name is Alex. I like ramen and I run every morning.' }))
      const firstTurn = await waitForMessages(ws, (msg) => msg.type === 'text.done')

      const created = firstTurn.find((m) => m.type === 'session.created')
      expect(created).toBeDefined()
      const sessionId = Number(created?.sessionId)
      expect(Number.isFinite(sessionId)).toBe(true)

      const deltas = firstTurn.filter((m) => m.type === 'text.delta')
      expect(deltas.length).toBeGreaterThan(0)
      expect(firstTurn[firstTurn.length - 1]).toEqual({ type: 'text.done' })

      ws.send(JSON.stringify({ e: 'input', msg: 'Plan a high-protein dinner idea and keep my preferences in mind.' }))
      const secondTurn = await waitForMessages(ws, (msg) => msg.type === 'text.done')
      expect(secondTurn.some((m) => m.type === 'session.created')).toBe(false)

      await closeSocket(ws)

      await waitForCondition(async () => {
        const sessionRows = await testDb.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, USER_ID))
        return sessionRows.length === 1
      })

      const resumedWsUrl = `ws://127.0.0.1:${appServer.port}/stream/chat?token=${AUTH_TOKEN}&sessionId=${sessionId}`
      const resumedWs = trackSocket(new WebSocket(resumedWsUrl))
      await waitForOpen(resumedWs)
      const resumed = await waitForMessage(resumedWs)
      expect(resumed.type).toBe('session.resumed')
      expect(resumed.sessionId).toBe(sessionId)

      resumedWs.send(JSON.stringify({ e: 'input', msg: 'What exercise schedule did I mention?' }))
      const resumedTurn = await waitForMessages(resumedWs, (msg) => msg.type === 'text.done')
      expect(resumedTurn.filter((m) => m.type === 'text.delta').length).toBeGreaterThan(0)

      await waitForCondition(async () => {
        const persistedMessages = await testDb
          .select({
            role: messages.role,
            content: messages.content,
          })
          .from(messages)
          .where(eq(messages.sessionId, sessionId))

        return persistedMessages.length >= 6
      })

      await waitForCondition(async () => {
        const persistedMessages = await testDb
          .select({ extractedAt: messages.extractedAt })
          .from(messages)
          .where(eq(messages.sessionId, sessionId))
        if (persistedMessages.length < 6) return false
        if (!persistedMessages.every((row) => row.extractedAt !== null)) return false

        const memoryRows = await testDb
          .select({ content: memories.content })
          .from(memories)
          .where(eq(memories.userId, USER_ID))
        return memoryRows.length > 0
      })

      const sessionMessages = await testDb
        .select({
          role: messages.role,
          content: messages.content,
          extractedAt: messages.extractedAt,
        })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(messages.createdAt)
      expect(sessionMessages.length).toBeGreaterThanOrEqual(6)
      expect(sessionMessages.every((row) => row.extractedAt !== null)).toBe(true)
      expect(sessionMessages.map((row) => row.role).filter((r) => r === 'user').length).toBe(3)
      expect(sessionMessages.map((row) => row.role).filter((r) => r === 'assistant').length).toBe(3)

      const memoryRows = await testDb
        .select({ content: memories.content })
        .from(memories)
        .where(eq(memories.userId, USER_ID))
      expect(memoryRows.length).toBeGreaterThan(0)

      await closeSocket(resumedWs)
    },
    180_000
  )

  test(
    'returns 404 for unknown maid',
    async () => {
      if (!appServer) {
        throw new Error('App server was not started')
      }

      const response = await fetch(
        `http://127.0.0.1:${appServer.port}/stream/unknown?token=${AUTH_TOKEN}`,
        { headers: { connection: 'upgrade', upgrade: 'websocket' } },
      )
      expect(response.status).toBe(404)
    },
    120_000
  )
})
