import { chatMaidHandler } from './chat'
import type { StreamSocketHandler } from './types'

const streamSocketHandlersByMaidId: Record<string, StreamSocketHandler> = {
  cli: chatMaidHandler,
  chat: chatMaidHandler,
}

export function findStreamSocketHandler(maidId: string): StreamSocketHandler | null {
  return streamSocketHandlersByMaidId[maidId] ?? null
}

