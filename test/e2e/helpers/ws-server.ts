import { mock } from 'bun:test'

import { createStreamSocketData, streamWebSocketHandlers } from '../../../src/ws/index'
import { createSessionService } from '../../../src/session'
import { createMemoryService } from '../../../src/memory'
import type { ServerMessage } from '../../../src/ws/schema'
import type { E2eTestEnv } from './testcontainers'

const USER_ID = 'e2e-test-user'

export type WsServer = {
  url: string
  port: number
  close: () => void
}

export function startServer(env: E2eTestEnv): WsServer {
  const server = Bun.serve({
    port: 0,
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

      const userId = url.searchParams.get('userId') ?? USER_ID
      const sessionId = url.searchParams.get('sessionId')
        ? Number(url.searchParams.get('sessionId'))
        : undefined

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
