import type { MemoryService } from './memory'
import type { SessionService } from './session'

export type AppEnv = {
  Variables: {
    userId: string
    sessionService: SessionService
    memoryService: MemoryService
  }
}

export type BetterAuthSessionResponse = {
  user: {
    id: string
  }
}
