import type { Context } from 'hono'
import type Redis from 'ioredis'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import type * as schema from '../db/schema'

type WebSocketLike = {
  send: (message: string) => void
}

type AppEnv = {
  Variables: {
    userId: string
  }
}

function toTextPayload(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
  if (typeof data === 'string') {
    return data
  }

  if (data instanceof Blob) {
    return '[non-text message]'
  }

  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data)

  return new TextDecoder().decode(bytes)
}

type HandlerDeps = {
  db: PostgresJsDatabase<typeof schema>
  redis: Redis
}

export function getWebsocketHandler({ db, redis }: HandlerDeps) {
  const hasClients = Boolean(db) && Boolean(redis)

  return (c: Context<AppEnv>) => {
    const userId = c.get('userId')

    return {
      onOpen(_event: Event, ws: WebSocketLike) {
        if (!hasClients) {
          console.error('WebSocket /stream missing database or redis client')
        }
        ws.send(JSON.stringify({ type: 'connected' }))
      },
      onMessage(event: MessageEvent, ws: WebSocketLike) {
        ws.send(
          JSON.stringify({
            type: 'echo',
            data: toTextPayload(event.data),
          })
        )
      },
      onClose() {
        console.log(`WebSocket /stream connection closed for user ${userId}`)
      },
      onError(event: Event) {
        console.error(`WebSocket /stream error for user ${userId}`, event)
      },
    }
  }
}
