import { describe, expect, test } from 'bun:test'

import type { MemoryService } from '../../src/memory/service'
import type { SessionService } from '../../src/session-service'
import { ChatService } from '../../src/maid/service'

function createSessionRow(id: number, userId = 'u1') {
  const now = new Date()
  return {
    id,
    userId,
    title: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  }
}

describe('ChatService service deps', () => {
  test('loads welcome context via session and memory services', async () => {
    const sessionService: SessionService = {
      userId: 'u1',
      async load() { return null },
      async create() { return createSessionRow(1, 'u1') },
      async update() { return undefined },
      async delete() { },
      async findLatestSessionId() { return 12 },
      async listMessages() {
        return [
          { role: 'assistant', content: 'latest' },
          { role: 'user', content: 'older' },
        ]
      },
      async getMessages() { return [] as any },
      async addMessage() { return {} as any },
    }

    const memoryService: MemoryService = {
      userId: 'u1',
      async create() { throw new Error('not used') },
      async load() { return null },
      async list() { return [{ content: 'prefers tea' }] as any },
      async extractNow() {
        return {
          factsExtracted: 0,
          memoriesAdded: 0,
          memoriesUpdated: 0,
          memoriesDeleted: 0,
          memoriesUnchanged: 0,
        }
      },
      async enqueueExtraction() { },
    }

    const service = new ChatService({
      sessionService,
      memoryService,
    })

    const context = await service.loadWelcomeContext()
    expect(context.memories).toEqual(['prefers tea'])
    expect(context.recentConversation).toEqual([
      { role: 'user', content: 'older' },
      { role: 'assistant', content: 'latest' },
    ])
  })

  test('enqueues memory extraction through memory service', async () => {
    let calls = 0

    const sessionService: SessionService = {
      userId: 'u1',
      async load() { return null },
      async create() { return createSessionRow(1, 'u1') },
      async update() { return undefined },
      async delete() { },
      async findLatestSessionId() { return null },
      async listMessages() { return [] },
      async getMessages() { return [] as any },
      async addMessage() { return {} as any },
    }

    const memoryService: MemoryService = {
      userId: 'u1',
      async create() { throw new Error('not used') },
      async load() { return null },
      async list() { return [] },
      async extractNow() {
        return {
          factsExtracted: 0,
          memoriesAdded: 0,
          memoriesUpdated: 0,
          memoriesDeleted: 0,
          memoriesUnchanged: 0,
        }
      },
      async enqueueExtraction() {
        calls += 1
      },
    }

    const service = new ChatService({
      sessionService,
      memoryService,
    })

    await service.enqueueMemoryExtraction()
    expect(calls).toBe(1)
  })
})
