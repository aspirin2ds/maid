import 'dotenv/config'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { GenericContainer, Wait } from 'testcontainers'

type AuthRequest = Request & {
  headers: Headers
}

const AUTH_TOKEN = 'test-token'

let postgresContainer: Awaited<ReturnType<GenericContainer['start']>> | null = null
let redisContainer: Awaited<ReturnType<GenericContainer['start']>> | null = null
let authServer: ReturnType<typeof Bun.serve> | null = null
let appServer: ReturnType<typeof Bun.serve> | null = null
let openSocket: WebSocket | null = null

async function runMigrations(databaseUrl: string) {
  const startedAt = Date.now()
  const timeoutMs = 10_000
  let lastError: unknown = null

  while (Date.now() - startedAt < timeoutMs) {
    const migrationClient = postgres(databaseUrl)

    try {
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

describe('WebSocket route with real dependencies', () => {
  beforeAll(async () => {
    postgresContainer = await new GenericContainer('postgres:16-alpine')
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

    const appModule = await import('../src/index')
    appServer = Bun.serve({
      port: 0,
      fetch: appModule.default.fetch,
      websocket: appModule.default.websocket,
    })
  })

  afterAll(async () => {
    if (openSocket && openSocket.readyState === WebSocket.OPEN) {
      openSocket.close(1000, 'test complete')
    }

    appServer?.stop(true)
    authServer?.stop(true)

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
      const ws = new WebSocket(wsUrl)
      openSocket = ws

      await waitForOpen(ws)

      const connected = await waitForMessage(ws)
      expect(connected).toEqual({ type: 'connected', maid: 'chat' })
    },
    120_000
  )

  test(
    'sends a message and receives streamed response',
    async () => {
      if (!appServer) {
        throw new Error('App server was not started')
      }

      const wsUrl = `ws://127.0.0.1:${appServer.port}/stream/chat?token=${AUTH_TOKEN}`
      const ws = new WebSocket(wsUrl)
      openSocket = ws

      await waitForOpen(ws)
      await waitForMessage(ws) // consume connected message

      ws.send('say hello')
      const messages = await waitForMessages(ws, (msg) => msg.type === 'text.done')

      const deltas = messages.filter((m) => m.type === 'text.delta')
      expect(deltas.length).toBeGreaterThan(0)
      for (const delta of deltas) {
        expect(typeof delta.data).toBe('string')
      }
      expect(messages[messages.length - 1]).toEqual({ type: 'text.done' })
    },
    120_000
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
