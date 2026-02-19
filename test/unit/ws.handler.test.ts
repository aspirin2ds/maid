import { afterEach, describe, expect, mock, test } from 'bun:test'
import PQueue from 'p-queue'

import { streamWebSocketHandlers, type StreamSocketData } from '../../src/ws/index'
import { SessionNotFoundError } from '../../src/session'

// -- Helpers ------------------------------------------------------------------

/** Messages sent via ws.sendText */
function sentMessages(ws: MockWs): unknown[] {
  return (ws.sendText.mock.calls as Array<unknown[]>).map((args) => JSON.parse(String(args[0])))
}

function lastSentMessage(ws: MockWs): unknown {
  const msgs = sentMessages(ws)
  return msgs[msgs.length - 1]
}

// -- Mocks --------------------------------------------------------------------

type MockWs = ReturnType<typeof createMockWs>

function createMockWs(overrides: Partial<StreamSocketData> = {}) {
  const ws = {
    sendText: mock(() => {}),
    close: mock(() => {}),
    data: {
      maidId: 'chat',
      sessionService: {
        ensure: mock(async (id?: number) => ({
          id: id ?? 1,
          saveMessage: mock(async () => ({})),
          listRecentMessages: mock(async () => []),
        })),
      },
      memoryService: {
        enqueueMemoryExtraction: mock(async () => {}),
        listRecentUpdatedMemories: mock(async () => []),
        getRelatedMemories: mock(async () => []),
      },
      q: new PQueue({ concurrency: 1 }),
      state: {
        session: null,
        stream: null,
        closing: false,
      },
      ...overrides,
    } as unknown as StreamSocketData,
  }
  return ws as typeof ws & { data: StreamSocketData }
}

function createMockStream() {
  const listeners = new Map<string, Function[]>()
  return {
    on: mock((event: string, cb: Function) => {
      const cbs = listeners.get(event) ?? []
      cbs.push(cb)
      listeners.set(event, cbs)
    }),
    abort: mock(() => {
      const errorCbs = listeners.get('error') ?? []
      for (const cb of errorCbs) cb(new Error('stream aborted'))
    }),
    emit(event: string, ...args: unknown[]) {
      const cbs = listeners.get(event) ?? []
      for (const cb of cbs) cb(...args)
    },
  }
}

const { message, close } = streamWebSocketHandlers

// -- Tests --------------------------------------------------------------------

describe('ws handler', () => {
  describe('send() on closed socket', () => {
    test('does not throw when sendText fails', () => {
      const ws = createMockWs()
      ws.sendText = mock(() => { throw new Error('socket closed') })

      message(ws as any, JSON.stringify({ type: 'input', content: 'hello' }))

      // should not throw — send() swallows the error
    })
  })

  describe('message parsing errors', () => {
    test('sends error for invalid JSON', () => {
      const ws = createMockWs()
      message(ws as any, 'not json')
      expect(lastSentMessage(ws)).toEqual({ type: 'error', message: 'invalid JSON' })
    })

    test('sends error for invalid message schema', () => {
      const ws = createMockWs()
      message(ws as any, JSON.stringify({ type: 'unknown' }))
      expect(lastSentMessage(ws)).toMatchObject({ type: 'error' })
    })
  })

  describe('unknown maid', () => {
    test('sends error and closes socket for unknown maidId', () => {
      const ws = createMockWs({ maidId: 'nonexistent' } as any)
      message(ws as any, JSON.stringify({ type: 'input', content: 'hello' }))

      expect(lastSentMessage(ws)).toEqual({ type: 'error', message: 'unknown maidId: nonexistent' })
      expect(ws.close).toHaveBeenCalledWith(1008, 'unknown maid')
    })
  })

  describe('abort', () => {
    test('keeps connection open', () => {
      const ws = createMockWs()
      message(ws as any, JSON.stringify({ type: 'abort' }))

      expect(ws.data.state.closing).toBe(false)
    })

    test('aborts active stream', () => {
      const ws = createMockWs()
      const stream = createMockStream()
      ws.data.state.stream = stream as any

      message(ws as any, JSON.stringify({ type: 'abort' }))

      expect(stream.abort).toHaveBeenCalled()
      expect(ws.data.state.stream).toBeNull()
    })

    test('is safe when no stream is active', () => {
      const ws = createMockWs()
      ws.data.state.stream = null

      // should not throw
      message(ws as any, JSON.stringify({ type: 'abort' }))
      expect(ws.data.state.closing).toBe(false)
    })
  })

  describe('bye', () => {
    test('aborts and closes socket', () => {
      const ws = createMockWs()
      message(ws as any, JSON.stringify({ type: 'bye' }))

      expect(ws.data.state.closing).toBe(true)
      expect(ws.close).toHaveBeenCalledWith(1000, 'bye')
    })
  })

  describe('close', () => {
    test('sets closing flag and aborts stream', () => {
      const ws = createMockWs()
      const stream = createMockStream()
      ws.data.state.stream = stream as any

      close(ws as any)

      expect(ws.data.state.closing).toBe(true)
      expect(stream.abort).toHaveBeenCalled()
      expect(ws.data.state.stream).toBeNull()
    })
  })

  describe('queue error handling', () => {
    test('sends error to client when handler throws', async () => {
      const ws = createMockWs()
      // Make session.ensure throw
      ws.data.sessionService.ensure = mock(async () => { throw new Error('db down') }) as any

      message(ws as any, JSON.stringify({ type: 'input', content: 'hello' }))
      await ws.data.q.onIdle()

      // wait for .catch microtask
      await new Promise((r) => setTimeout(r, 0))

      expect(sentMessages(ws)).toContainEqual({ type: 'error', message: 'db down' })
    })

    test('suppresses error when closing', async () => {
      const ws = createMockWs()
      ws.data.sessionService.ensure = mock(async () => { throw new Error('db down') }) as any
      ws.data.state.closing = true

      message(ws as any, JSON.stringify({ type: 'input', content: 'hello' }))
      await ws.data.q.onIdle()
      await new Promise((r) => setTimeout(r, 0))

      // no error message sent — closing flag suppresses it
      const errors = sentMessages(ws).filter((m: any) => m.type === 'error')
      expect(errors).toHaveLength(0)
    })

    test('closes socket when sessionId given but session not found', async () => {
      const ws = createMockWs({ sessionId: 42 } as any)
      ws.data.sessionService.ensure = mock(async () => { throw new SessionNotFoundError(42, 'u1') }) as any

      message(ws as any, JSON.stringify({ type: 'input', content: 'hello' }))
      await ws.data.q.onIdle()
      await new Promise((r) => setTimeout(r, 0))

      expect(ws.close).toHaveBeenCalledWith(1008, 'session not found')
    })

    test('does not close socket for non-session errors when sessionId was provided', async () => {
      const ws = createMockWs({ sessionId: 42 } as any)
      ws.data.sessionService.ensure = mock(async () => { throw new Error('db down') }) as any

      message(ws as any, JSON.stringify({ type: 'input', content: 'hello' }))
      await ws.data.q.onIdle()
      await new Promise((r) => setTimeout(r, 0))

      expect(sentMessages(ws)).toContainEqual({ type: 'error', message: 'db down' })
      expect(ws.close).not.toHaveBeenCalled()
    })

    test('does not close socket when no sessionId given and session creation fails', async () => {
      const ws = createMockWs()
      // sessionId is undefined (default) — session creation, not lookup
      ws.data.sessionService.ensure = mock(async () => { throw new Error('db down') }) as any

      message(ws as any, JSON.stringify({ type: 'input', content: 'hello' }))
      await ws.data.q.onIdle()
      await new Promise((r) => setTimeout(r, 0))

      // error sent but socket stays open
      expect(sentMessages(ws)).toContainEqual({ type: 'error', message: 'db down' })
      expect(ws.close).not.toHaveBeenCalled()
    })
  })
})
