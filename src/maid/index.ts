import type { WSEvents } from 'hono/ws'
import type { HandlerDeps } from '../types'
import { ChatMaid } from './chat'

type Maid = WSEvents

const factories: Record<string, (deps: HandlerDeps) => Maid> = {
  chat: (deps) => new ChatMaid(deps),
}

export function getMaid(maidId: string, deps: HandlerDeps): Maid | undefined {
  return factories[maidId]?.(deps)
}
