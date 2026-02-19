import { mock } from 'bun:test'
import PQueue from 'p-queue'

import { streamWebSocketHandlers, type StreamSocketData } from '../../../src/ws/index'
import { createSessionService } from '../../../src/session'
import { createMemoryService } from '../../../src/memory'
import type { ServerMessage } from '../../../src/ws/schema'
import type { E2eTestEnv } from './testcontainers'

// -- Test server factory ------------------------------------------------------

const TEST_USER_ID = 'e2e-test-user'

export type TestServer = {
  url: string
  port: number
  close: () => void
}

export function createTestServer(env: E2eTestEnv): TestServer {
  const server = Bun.serve({
    port: 0, // random available port
    websocket: streamWebSocketHandlers,
    fetch(request, appServer) {
      const url = new URL(request.url)

      if (url.pathname !== '/ws' || request.method !== 'GET') {
        return new Response('not found', { status: 404 })
      }

      const maidId = url.searchParams.get('maidId')
      if (!maidId) {
        return Response.json({ message: 'maidId required' }, { status: 400 })
      }

      const userId = url.searchParams.get('userId') ?? TEST_USER_ID
      const sessionIdParam = url.searchParams.get('sessionId')
      const sessionId = sessionIdParam ? Number(sessionIdParam) : undefined

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
        data: {
          maidId,
          sessionId,
          sessionService,
          memoryService,
          q: new PQueue({ concurrency: 1 }),
          state: {
            session: null,
            stream: null,
            aborted: false,
          },
        } satisfies StreamSocketData,
      })

      if (upgraded) return
      return Response.json({ message: 'WebSocket upgrade failed' }, { status: 400 })
    },
  })

  return {
    url: `ws://localhost:${server.port}/ws`,
    port: server.port,
    close: () => server.stop(true),
  }
}

// -- WsClient helper ----------------------------------------------------------

export class WsClient {
  messages: ServerMessage[] = []
  private ws: WebSocket | null = null
  private closeEvent: { code: number; reason: string } | null = null
  private messageWaiters: Array<{
    type: string
    resolve: (msg: ServerMessage) => void
    reject: (err: Error) => void
  }> = []
  private closeWaiters: Array<{
    resolve: (ev: { code: number; reason: string }) => void
    reject: (err: Error) => void
  }> = []

  async connect(baseUrl: string, params: Record<string, string>): Promise<void> {
    const url = new URL(baseUrl)
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url.toString())

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

        // Resolve any pending waiters
        for (let i = this.messageWaiters.length - 1; i >= 0; i--) {
          if (this.messageWaiters[i].type === msg.type) {
            const waiter = this.messageWaiters.splice(i, 1)[0]
            waiter.resolve(msg)
          }
        }
      })

      ws.addEventListener('close', (ev) => {
        this.closeEvent = { code: ev.code, reason: ev.reason }
        for (const w of this.closeWaiters) {
          w.resolve(this.closeEvent)
        }
        this.closeWaiters = []
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
    // Check if we already have a matching message
    const existing = this.messages.find(m => m.type === type)
    if (existing) return Promise.resolve(existing)

    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for message type "${type}" (got: ${this.messages.map(m => m.type).join(', ')})`))
      }, timeoutMs)

      this.messageWaiters.push({
        type,
        resolve: (msg) => {
          clearTimeout(timer)
          resolve(msg)
        },
        reject,
      })
    })
  }

  waitForClose(timeoutMs = 30_000): Promise<{ code: number; reason: string }> {
    if (this.closeEvent) return Promise.resolve(this.closeEvent)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for close'))
      }, timeoutMs)

      this.closeWaiters.push({
        resolve: (ev) => {
          clearTimeout(timer)
          resolve(ev)
        },
        reject,
      })
    })
  }

  /** Wait until we have at least `count` messages of the given type. */
  async waitForCount(type: string, count: number, timeoutMs = 30_000): Promise<ServerMessage[]> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const matching = this.messages.filter(m => m.type === type)
      if (matching.length >= count) return matching
      await new Promise(r => setTimeout(r, 50))
    }
    const matching = this.messages.filter(m => m.type === type)
    if (matching.length >= count) return matching
    throw new Error(`Timed out waiting for ${count} "${type}" messages (got ${matching.length})`)
  }

  /** Wait for the full stream sequence: stream_start, delta(s), stream_done */
  async waitForStreamComplete(timeoutMs = 30_000): Promise<void> {
    await this.waitFor('stream_done', timeoutMs)
  }

  close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close()
    }
  }
}
