import { describe, expect, mock, test } from 'bun:test'

const generateEmbeddingsMock = mock(async (_input: string | string[]) => [[0.1, 0.2, 0.3]])
const generateTextMock = mock(async (_prompt: string) => '')
const structuredResponseMock = mock(async (_prompt: string, _schema: unknown) => ({}))
const streamResponseMock = mock(() => ({}))

mock.module('../../src/llm', () => ({
  generateEmbeddings: generateEmbeddingsMock,
  generateText: generateTextMock,
  structuredResponse: structuredResponseMock,
  streamResponse: streamResponseMock,
  openai: {},
  ollama: {},
}))

const { createMemoryService } = await import('../../src/memory/index')

type MockDbOptions = {
  selectResults?: unknown[]
}

function createMockDatabase(options: MockDbOptions = {}) {
  const selectResults = [...(options.selectResults ?? [])]
  const selectCallMeta: Array<{ limitValue: number | null }> = []

  const database = {
    select: mock(() => {
      const result = (selectResults.shift() ?? []) as unknown
      const meta = { limitValue: null as number | null }
      selectCallMeta.push(meta)

      const builder: any = {
        from: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: (value: number) => {
          meta.limitValue = value
          return builder
        },
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
          return Promise.resolve(result).then(onFulfilled, onRejected)
        },
      }

      return builder
    }),
  }

  return {
    database: database as any,
    selectCallMeta,
  }
}

describe('memory service unit', () => {
  test('getRelatedMemories performs semantic query and maps similarity', async () => {
    const { database, selectCallMeta } = createMockDatabase({
      selectResults: [[
        { id: 1, content: 'likes hiking', metadata: {}, distance: 0.2 },
        { id: 2, content: 'lives in seattle', metadata: {}, distance: 0.4 },
      ]],
    })

    const enqueueMemoryExtraction = mock(async (_payload: { userId: string }) => {})
    const service = createMemoryService({
      database,
      enqueueMemoryExtraction,
      userId: 'u1',
    })

    const out = await service.getRelatedMemories('hiking', { limit: 2, threshold: 0.6 })

    expect(generateEmbeddingsMock).toHaveBeenCalledWith('hiking')
    expect(selectCallMeta[0].limitValue).toBe(2)
    expect(out).toEqual([
      { id: 1, content: 'likes hiking', metadata: {}, similarity: 0.8 },
      { id: 2, content: 'lives in seattle', metadata: {}, similarity: 0.6 },
    ])
  })

  test('listRecentUpdatedMemories uses default limit', async () => {
    const rows = [
      { id: 9, userId: 'u1', content: 'x', metadata: {}, embedding: null, createdAt: new Date(), updatedAt: new Date() },
    ]

    const { database, selectCallMeta } = createMockDatabase({
      selectResults: [rows],
    })

    const enqueueMemoryExtraction = mock(async (_payload: { userId: string }) => {})
    const service = createMemoryService({
      database,
      enqueueMemoryExtraction,
      userId: 'u1',
    })

    const out = await service.listRecentUpdatedMemories()

    expect(out).toEqual(rows)
    expect(selectCallMeta[0].limitValue).toBe(5)
  })

  test('enqueueMemoryExtraction enqueues with scoped userId', async () => {
    const { database } = createMockDatabase()
    const enqueueMemoryExtraction = mock(async (_payload: { userId: string }) => {})

    const service = createMemoryService({
      database,
      enqueueMemoryExtraction,
      userId: 'u1',
    })

    await service.enqueueMemoryExtraction()

    expect(enqueueMemoryExtraction).toHaveBeenCalledWith({ userId: 'u1' })
  })
})
