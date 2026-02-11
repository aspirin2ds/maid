import { describe, expect, test } from 'bun:test'

import type { Session } from '../../src/session'
import type { ConversationRepository, UserMemoryStore } from '../../src/maid/core'
import { ChatService } from '../../src/maid/service'

function createSession(id: number): Session {
  return {
    id,
    userId: 'u1',
    row: {} as any,
    async update() { return undefined },
    async delete() { },
    async addMessage() { return {} as any },
    async getMessages() { return [] },
  }
}

describe('ChatService ports', () => {
  test('loads welcome context via repository and memory store ports', async () => {
    const repository: ConversationRepository = {
      async loadSession() { return null },
      async createSession() { return createSession(1) },
      async findLatestSessionId() { return 12 },
      async listSessionMessages() {
        return [
          { role: 'assistant', content: 'latest' },
          { role: 'user', content: 'older' },
        ]
      },
    }

    const memoryStore: UserMemoryStore = {
      async list() { return ['prefers tea'] },
      async enqueueExtraction() { },
    }

    const service = new ChatService({
      userId: 'u1',
      conversationRepository: repository,
      memoryStore,
    })

    const context = await service.loadWelcomeContext()
    expect(context.memories).toEqual(['prefers tea'])
    expect(context.recentConversation).toEqual([
      { role: 'user', content: 'older' },
      { role: 'assistant', content: 'latest' },
    ])
  })

  test('enqueues memory extraction through the memory store port', async () => {
    const calls: string[] = []

    const repository: ConversationRepository = {
      async loadSession() { return null },
      async createSession() { return createSession(1) },
      async findLatestSessionId() { return null },
      async listSessionMessages() { return [] },
    }

    const memoryStore: UserMemoryStore = {
      async list() { return [] },
      async enqueueExtraction(userId) { calls.push(userId) },
    }

    const service = new ChatService({
      userId: 'u1',
      conversationRepository: repository,
      memoryStore,
    })

    await service.enqueueMemoryExtraction()
    expect(calls).toEqual(['u1'])
  })
})
