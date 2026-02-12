import { describe, expect, mock, test } from 'bun:test'

import { createSessionService } from '../../src/session'

type MockDbOptions = {
  selectResults?: unknown[]
  insertResults?: unknown[]
}

function createMockDatabase(options: MockDbOptions = {}) {
  const selectResults = [...(options.selectResults ?? [])]
  const insertResults = [...(options.insertResults ?? [])]

  const selectCallMeta: Array<{ innerJoinCalled: boolean; limitValue: number | null }> = []
  const insertValues: unknown[] = []

  const database = {
    select: mock(() => {
      const result = (selectResults.shift() ?? []) as unknown
      const meta = { innerJoinCalled: false, limitValue: null as number | null }
      selectCallMeta.push(meta)

      const builder: any = {
        from: () => builder,
        where: () => builder,
        orderBy: () => builder,
        innerJoin: () => {
          meta.innerJoinCalled = true
          return builder
        },
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

    insert: mock(() => {
      const result = (insertResults.shift() ?? []) as unknown

      return {
        values: (value: unknown) => {
          insertValues.push(value)
          return {
            returning: () => Promise.resolve(result),
          }
        },
      }
    }),
  }

  return {
    database: database as any,
    selectCallMeta,
    insertValues,
  }
}

describe('session service unit', () => {
  test('create() without sessionId creates a session and saveMessage writes to that session', async () => {
    const { database, insertValues } = createMockDatabase({
      insertResults: [
        [{ id: 42 }],
        [{ id: 11, sessionId: 42, role: 'user', content: 'hello', metadata: {} }],
      ],
    })

    const service = createSessionService({
      database,
      redisClient: {} as any,
      userId: 'u1',
    })

    const session = await service.create()
    expect(session.id).toBe(42)

    await session.saveMessage({ role: 'user', content: 'hello' })

    expect(insertValues[0]).toEqual({ userId: 'u1', title: null, metadata: {} })
    expect(insertValues[1]).toEqual({ sessionId: 42, role: 'user', content: 'hello', metadata: {} })
  })

  test('create(sessionId) throws when session is not owned by user', async () => {
    const { database } = createMockDatabase({
      selectResults: [[]],
    })

    const service = createSessionService({
      database,
      redisClient: {} as any,
      userId: 'u1',
    })

    await expect(service.create(999)).rejects.toThrow('Session 999 not found for user u1')
  })

  test('listRecentMessages defaults to cross-session query (sameSession=false)', async () => {
    const rows = [
      { id: 1, sessionId: 9, role: 'user', content: 'a', metadata: {}, extractedAt: null, createdAt: new Date(), updatedAt: new Date() },
    ]

    const { database, selectCallMeta } = createMockDatabase({
      selectResults: [[{ id: 7 }], rows],
    })

    const service = createSessionService({
      database,
      redisClient: {} as any,
      userId: 'u1',
    })

    const session = await service.create(7)
    const out = await session.listRecentMessages(3)

    expect(out).toEqual(rows)
    expect(selectCallMeta[1].innerJoinCalled).toBeTrue()
    expect(selectCallMeta[1].limitValue).toBe(3)
  })

  test('listRecentMessages with sameSession=true does not join sessions', async () => {
    const rows = [
      { id: 2, sessionId: 7, role: 'assistant', content: 'b', metadata: {}, extractedAt: null, createdAt: new Date(), updatedAt: new Date() },
    ]

    const { database, selectCallMeta } = createMockDatabase({
      selectResults: [[{ id: 7 }], rows],
    })

    const service = createSessionService({
      database,
      redisClient: {} as any,
      userId: 'u1',
    })

    const session = await service.create(7)
    const out = await session.listRecentMessages(2, true)

    expect(out).toEqual(rows)
    expect(selectCallMeta[1].innerJoinCalled).toBeFalse()
    expect(selectCallMeta[1].limitValue).toBe(2)
  })
})
