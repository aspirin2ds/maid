import type { WSEvents } from 'hono/ws'
import { createChatMaid } from './chat'

export interface Maid extends WSEvents { }

const maids: Record<string, Maid> = {
  chat: createChatMaid(),
}

export function getMaid(maidId: string): Maid | undefined {
  return maids[maidId]
}
