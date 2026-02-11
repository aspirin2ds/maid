import type { WSEvents } from 'hono/ws'
import type { HandlerDeps } from '../types'
import type { Session } from '../session'
import { createSession } from '../session'
import { streamResponse } from '../llm'

export class ChatMaid implements WSEvents {
  private sessionPromise: Promise<Session> | null = null
  private deps: HandlerDeps

  constructor(deps: HandlerDeps) {
    this.deps = deps
  }

  onOpen(_event: Event, ws: any) {
    ws.send(JSON.stringify({ type: 'connected', maid: 'chat' }))
  }

  async onMessage(event: MessageEvent, ws: any) {
    const text = typeof event.data === 'string' ? event.data : ''
    const stream = streamResponse(text)
    for await (const chunk of stream) {
      if (chunk.type === 'response.output_text.delta') {
        ws.send(JSON.stringify({ type: 'text.delta', data: chunk.delta }))
      }
    }
    ws.send(JSON.stringify({ type: 'text.done' }))

    const isNew = !this.sessionPromise
    const session = await (this.sessionPromise ??= createSession(this.deps.userId, this.deps.db, this.deps.redis))
    if (isNew) {
      ws.send(JSON.stringify({ type: 'session.created', sessionId: session.id }))
    }
  }

  onClose() { }
  onError() { }
}
