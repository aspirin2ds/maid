import { drizzle } from 'drizzle-orm/node-postgres'
import Redis from 'ioredis'
import { Pool } from 'pg'

import { env } from './env'
import { createMemoryService } from './memory'
import { createMemoryExtractionQueue } from './memory/queue'
import { createSessionService } from './session'
import { streamWebSocketHandlers } from './ws'

import * as schema from './db/schema'
import z from 'zod'
import PQueue from 'p-queue'
const databaseClient = new Pool({ connectionString: env.DATABASE_URL })
const database = drizzle(databaseClient, { schema })

const redisClient = new Redis(env.REDIS_URL, { lazyConnect: true })
const memoryExtractionQueue = createMemoryExtractionQueue(redisClient.duplicate({ maxRetriesPerRequest: null }), database)

let isShuttingDown = false
let closePromise: Promise<void> | null = null

function createUserServices(userId: string) {
  const sessionService = createSessionService({
    database,
    redisClient,
    userId,
  })

  const memoryService = createMemoryService({
    database,
    userId,
    enqueueMemory: memoryExtractionQueue.enqueue,
  })

  return {
    sessionService,
    memoryService,
  }
}

const wsRequestQuery = z.object({
  token: z.string().min(1),
  maidId: z.string().min(1),
  sessionId: z.coerce.number().int().optional(),
})

type WsRequest = z.infer<typeof wsRequestQuery>

function parseWsRequest(url: URL): WsRequest | Response {
  const token = url.searchParams.get('token') ?? url.searchParams.get('authToken')
  const parsedQuery = wsRequestQuery.safeParse({
    token: token ?? undefined,
    maidId: url.searchParams.get('maidId') ?? undefined,
    sessionId: url.searchParams.get('sessionId') ?? undefined,
  })

  if (!parsedQuery.success) {
    return Response.json(
      { message: parsedQuery.error.issues.map((issue) => issue.message).join('; ') },
      { status: 400 },
    )
  }

  return parsedQuery.data
}

async function getAuthUserId(token: string): Promise<string | Response> {
  let authResp: Response
  try {
    authResp = await fetch(new URL('/api/auth/get-session', env.BETTER_AUTH_URL), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        origin: env.AUTH_ORIGIN,
      },
    })
  } catch (error) {
    console.error('Better Auth get-session request failed', error)
    return Response.json({ message: 'Better Auth unavailable' }, { status: 500 })
  }

  if (!authResp.ok) {
    if (authResp.status === 401 || authResp.status === 403) {
      return Response.json({ message: 'unauthorized' }, { status: 401 })
    }
    console.error('Better Auth get-session failed', authResp.status)
    return Response.json({ message: 'Better Auth unavailable' }, { status: 500 })
  }

  let authSess: any
  try {
    authSess = await authResp.json()
  } catch (error) {
    console.error('Better Auth get-session returned invalid JSON', error)
    return Response.json({ message: 'Better Auth unavailable' }, { status: 500 })
  }

  if (!authSess?.user?.id) {
    return Response.json({ message: 'unauthorized' }, { status: 401 })
  }

  return authSess.user.id
}

const server = Bun.serve({
  port: env.PORT,
  websocket: streamWebSocketHandlers,
  fetch: async (request, appServer) => {
    const url = new URL(request.url)

    if (url.pathname === '/' && request.method === "GET") {
      return new Response('Hello, Maid!')
    }

    if (url.pathname === '/ws' && request.method === 'GET') {
      const wsRequest = parseWsRequest(url)
      if (wsRequest instanceof Response) return wsRequest

      const { token, maidId, sessionId } = wsRequest

      const userId = await getAuthUserId(token)
      if (userId instanceof Response) return userId

      const { sessionService, memoryService } = createUserServices(userId)

      try {
        const upgraded = appServer.upgrade(request, {
          data: {
            maidId: maidId,
            sessionId: sessionId,
            sessionService,
            memoryService,

            q: new PQueue({ concurrency: 1 }),
            state: {
              session: null,
              stream: null,
              aborted: false,
            }
          },
        })

        if (upgraded) return
        return Response.json({ message: 'WebSocket upgrade failed' }, { status: 400 })
      } catch (error) {
        console.error('WebSocket upgrade failed with exception', error)
        return Response.json({ message: 'WebSocket upgrade failed' }, { status: 500 })
      }
    }
    return Response.json({ message: 'not found' }, { status: 404 })
  },
})

function logStartupInfo() {
  console.log('[startup] maid server started')
  console.log(`[startup] pid=${process.pid}`)
  console.log(`[startup] port=${env.PORT}`)
  console.log(`[startup] http=http://localhost:${env.PORT}/`)
  console.log(`[startup] ws=ws://localhost:${env.PORT}/ws`)
  console.log(`[startup] database=${env.DATABASE_URL}`)
  console.log(`[startup] redis=${env.REDIS_URL}`)
  console.log(`[startup] better_auth=${env.BETTER_AUTH_URL}`)
}

logStartupInfo()

async function closeResources() {
  if (closePromise) return closePromise

  closePromise = (async () => {
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
  })()

  return closePromise
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
    await server.stop()
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
  server,
  close: closeResources,
}
