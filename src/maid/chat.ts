import type { Maid } from './index'
import { streamResponse } from '../llm'

export function createChatMaid(): Maid {
  return {
    onOpen(_event, ws) {
      ws.send(JSON.stringify({ type: 'connected', maid: 'chat' }))
    },
    async onMessage(event, ws) {
      const text = typeof event.data === 'string' ? event.data : ''
      const stream = await streamResponse(text)
      for await (const chunk of stream) {
        if (chunk.type === 'response.output_text.delta') {
          ws.send(JSON.stringify({ type: 'text.delta', data: chunk.delta }))
        }
      }
      ws.send(JSON.stringify({ type: 'text.done' }))
    },
    onClose() {},
    onError() {},
  }
}
