import { mock } from 'bun:test'

import { createStreamSocketData, streamWebSocketHandlers } from '../../../src/ws/index'
import { createSessionService } from '../../../src/session'
import { createMemoryService } from '../../../src/memory'
import type { ServerMessage } from '../../../src/ws/schema'
import type { E2eTestEnv } from './testcontainers'

const USER_ID = 'e2e-test-user'
const CONNECTION_KEY_TTL_MS = 60_000

type ConnectionKeyData = {
  userId: string
  sessionId?: number
  expiresAt: number
}

export type WsServer = {
  url: string
  port: number
  close: () => void
}

export function startServer(env: E2eTestEnv): WsServer {
  const connectionKeys = new Map<string, ConnectionKeyData>()

  const createConnectionKey = (userId: string, sessionId?: number): string => {
    const key = Bun.randomUUIDv7()
    connectionKeys.set(key, {
      userId,
      sessionId,
      expiresAt: Date.now() + CONNECTION_KEY_TTL_MS,
    })
    return key
  }

  const consumeConnectionKey = (key: string): { userId: string, sessionId?: number } | null => {
    const found = connectionKeys.get(key)
    if (!found) return null
    connectionKeys.delete(key)
    if (found.expiresAt <= Date.now()) return null
    return {
      userId: found.userId,
      sessionId: found.sessionId,
    }
  }

  const getBearerToken = (request: Request): string | null => {
    const raw = request.headers.get('authorization')
    if (!raw) return null
    const [scheme, token] = raw.split(' ', 2)
    if (!scheme || !token) return null
    if (scheme.toLowerCase() !== 'bearer') return null
    return token
  }

  const server = Bun.serve({
    port: 0,
    websocket: streamWebSocketHandlers,
    async fetch(request, appServer) {
      const url = new URL(request.url)

      if (url.pathname === '/ws/connection-key' && request.method === 'GET') {
        const token = getBearerToken(request)
        if (!token) {
          return Response.json({ message: 'missing bearer token' }, { status: 401 })
        }

        const parsedSessionId = url.searchParams.get('sessionId')
        const sessionId = parsedSessionId ? Number(parsedSessionId) : undefined
        if (parsedSessionId && (!Number.isInteger(sessionId) || sessionId! <= 0)) {
          return Response.json({ message: 'Invalid input: expected number, received NaN' }, { status: 400 })
        }

        const userId = token
        if (sessionId !== undefined) {
          const sessionService = createSessionService({
            database: env.db,
            redisClient: env.redisClient,
            userId,
          })

          try {
            await sessionService.ensure(sessionId)
          } catch {
            return Response.json({ message: 'session not found' }, { status: 404 })
          }
        }

        const key = createConnectionKey(userId, sessionId)
        return Response.json({ connectionKey: key }, { status: 201 })
      }

      if (url.pathname !== '/ws' || request.method !== 'GET') {
        return new Response('not found', { status: 404 })
      }

      const maidId = url.searchParams.get('maidId')
      if (!maidId) {
        return Response.json({ message: 'maidId required' }, { status: 400 })
      }

      const connectionKey = url.searchParams.get('connectionKey')
      if (!connectionKey) {
        return Response.json({ message: 'connectionKey required' }, { status: 401 })
      }

      const resolved = consumeConnectionKey(connectionKey)
      if (!resolved) {
        return Response.json({ message: 'invalid or expired connection key' }, { status: 401 })
      }

      const userId = resolved.userId ?? USER_ID
      const sessionId = resolved.sessionId

      const sessionService = createSessionService({
        database: env.db,
        redisClient: env.redisClient,
        userId,
      })

      const memoryService = createMemoryService({
        database: env.db,
        userId,
        enqueueMemory: mock(async () => {}),
      })

      const upgraded = appServer.upgrade(request, {
        data: createStreamSocketData({
          maidId,
          sessionId,
          sessionService,
          memoryService,
        }),
      })

      if (upgraded) return
      return Response.json({ message: 'WebSocket upgrade failed' }, { status: 400 })
    },
  })
  const port = server.port ?? 0

  return {
    url: `ws://localhost:${port}/ws`,
    port,
    close: () => server.stop(true),
  }
}

// -- WsClient -----------------------------------------------------------------

export class WsClient {
  messages: ServerMessage[] = []
  private ws: WebSocket | null = null
  private closed: { code: number; reason: string } | null = null
  private pending: Array<{
    type: string
    resolve: (msg: ServerMessage) => void
    reject: (err: Error) => void
  }> = []
  private closePending: Array<{
    resolve: (ev: { code: number; reason: string }) => void
    reject: (err: Error) => void
  }> = []

  async connect(url: string, params: Record<string, string>): Promise<void> {
    const target = new URL(url)
    for (const [k, v] of Object.entries(params)) {
      target.searchParams.set(k, v)
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(target.toString())

      ws.addEventListener('open', () => {
        this.ws = ws
        resolve()
      })

      ws.addEventListener('error', () => {
        reject(new Error('WebSocket connection error'))
      })

      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMessage
        this.messages.push(msg)

        for (let i = this.pending.length - 1; i >= 0; i--) {
          if (this.pending[i].type === msg.type) {
            const w = this.pending.splice(i, 1)[0]
            w.resolve(msg)
          }
        }
      })

      ws.addEventListener('close', (ev) => {
        this.closed = { code: ev.code, reason: ev.reason }
        for (const w of this.closePending) w.resolve(this.closed)
        this.closePending = []
      })
    })
  }

  send(msg: Record<string, unknown>): void {
    this.ws!.send(JSON.stringify(msg))
  }

  sendRaw(data: string): void {
    this.ws!.send(data)
  }

  waitFor(type: string, timeoutMs = 30_000): Promise<ServerMessage> {
    const existing = this.messages.find(m => m.type === type)
    if (existing) return Promise.resolve(existing)

    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for "${type}" (got: ${this.messages.map(m => m.type).join(', ')})`))
      }, timeoutMs)

      this.pending.push({
        type,
        resolve: (msg) => { clearTimeout(timer); resolve(msg) },
        reject,
      })
    })
  }

  waitClose(timeoutMs = 30_000): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for close'))
      }, timeoutMs)

      this.closePending.push({
        resolve: (ev) => { clearTimeout(timer); resolve(ev) },
        reject,
      })
    })
  }

  waitDone(timeoutMs = 30_000): Promise<ServerMessage> {
    return this.waitFor('stream_done', timeoutMs)
  }

  close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close()
    }
  }
}

export async function issueConnectionKey(server: WsServer, token: string, sessionId?: string): Promise<string> {
  const url = new URL(`http://localhost:${server.port}/ws/connection-key`)
  if (sessionId) url.searchParams.set('sessionId', sessionId)

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to issue connection key: ${response.status}`)
  }

  const body = await response.json() as { connectionKey?: string }
  if (!body.connectionKey) {
    throw new Error('Connection key missing in response')
  }

  return body.connectionKey
}
