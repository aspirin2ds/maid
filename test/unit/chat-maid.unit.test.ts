import { beforeEach, describe, expect, mock, test } from 'bun:test'

type StreamChunk = { type: 'response.output_text.delta', delta: string }
type StreamLike = {
  [Symbol.asyncIterator]: () => AsyncIterator<StreamChunk>
  on: () => StreamLike
  abort: () => void
}

let generateTextImpl: (prompt: string) => Promise<string> = async () => 'Welcome!'
let streamResponseImpl: (input: string, instructions?: string) => StreamLike = () => createStream()

mock.module('../../src/llm', () => ({
  generateText: (prompt: string) => generateTextImpl(prompt),
  streamResponse: (input: string, instructions?: string) => streamResponseImpl(input, instructions),
}))

mock.module('../../src/logger', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}))

import type { MemoryService } from '../../src/memory/service'
import type { SessionService } from '../../src/session-service'
import { ChatMaid } from '../../src/maid/chat'

function createSessionRow(id: number, userId = 'mock-user') {
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

function createStream(chunks: string[] = ['hi'], error?: Error): StreamLike {
  return {
    async *[Symbol.asyncIterator]() {
      if (error) throw error
      for (const chunk of chunks) {
        yield { type: 'response.output_text.delta', delta: chunk }
      }
    },
    on() {
      return this
    },
    abort() {},
  }
}

function createMockSessionService(options: {
  userId?: string
  sessionId?: number
  onLoad?: (sessionId: number) => Promise<ReturnType<typeof createSessionRow> | null>
  onCreate?: () => Promise<ReturnType<typeof createSessionRow>>
  onGetMessages?: (sessionId: number) => Promise<Array<{ role: string, content: string }>>
  onAddMessage?: (sessionId: number, role: string, content: string) => Promise<void> | void
  latestSessionId?: number | null
  listMessagesRows?: Array<{ role: 'system' | 'user' | 'assistant' | 'tool', content: string }>
} = {}): SessionService {
  const {
    userId = 'mock-user',
    sessionId,
    onLoad,
    onCreate,
    onGetMessages,
    onAddMessage,
    latestSessionId = null,
    listMessagesRows = [],
  } = options

  return {
    userId,
    sessionId,
    async load(targetSessionId) {
      if (onLoad) return await onLoad(targetSessionId)
      return null
    },
    async create() {
      if (onCreate) return await onCreate()
      return createSessionRow(1, userId)
    },
    async update() {
      return undefined
    },
    async delete() {
    },
    async findLatestSessionId() {
      return latestSessionId
    },
    async listMessages() {
      return listMessagesRows
    },
    async getMessages(targetSessionId) {
      if (onGetMessages) {
        return await onGetMessages(targetSessionId) as any
      }
      return [] as any
    },
    async addMessage(targetSessionId, role, content) {
      await onAddMessage?.(targetSessionId, role, content)
      return {} as any
    },
  }
}

function createMockMemoryService(options: {
  listRows?: Array<{ content: string }>
  onEnqueue?: () => void | Promise<void>
} = {}): MemoryService {
  const { listRows = [], onEnqueue } = options
  return {
    userId: 'mock-user',
    async create() { throw new Error('not implemented in unit test') },
    async load() { return null },
    async list() { return listRows as any },
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
      await onEnqueue?.()
    },
  }
}

function createMockWs() {
  const sent: Array<Record<string, unknown>> = []
  const closed: Array<{ code: number, reason: string }> = []

  return {
    send(payload: string) {
      sent.push(JSON.parse(payload))
    },
    close(code: number, reason: string) {
      closed.push({ code, reason })
    },
    sent,
    closed,
    raw: undefined,
    url: null,
    readyState: 1,
  }
}

function inputMessage(msg: string): MessageEvent {
  return new MessageEvent('message', { data: JSON.stringify({ e: 'input', msg }) })
}

function abortMessage(): MessageEvent {
  return new MessageEvent('message', { data: JSON.stringify({ e: 'abort' }) })
}

beforeEach(() => {
  generateTextImpl = async () => 'Welcome!'
  streamResponseImpl = () => createStream()
})

describe('ChatMaid onOpen', () => {
  test('resumes existing session and sends session.resumed', async () => {
    const maid = new ChatMaid({
      sessionService: createMockSessionService({
        userId: 'u1',
        sessionId: 42,
        onLoad: async (id) => id === 42 ? createSessionRow(42, 'u1') : null,
        onGetMessages: async () => [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
          { role: 'system', content: 'ignored' },
        ],
      }),
      memoryService: createMockMemoryService({
        listRows: [{ content: 'prefers tea' }],
      }) as any,
    })
    const ws = createMockWs()

    await maid.onOpen!(new Event('open'), ws as any)

    expect(ws.sent).toHaveLength(1)
    expect(ws.sent[0]).toEqual({ type: 'session.resumed', sessionId: 42 })
    expect((maid as any).history).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ])
  })

  test('loads context and sends generated welcome message for a new session', async () => {
    let prompt = ''
    generateTextImpl = async (value) => {
      prompt = value
      return 'Welcome from model'
    }

    const maid = new ChatMaid({
      sessionService: createMockSessionService({
        userId: 'u2',
        latestSessionId: 7,
        listMessagesRows: [
          { role: 'assistant', content: 'latest' },
          { role: 'user', content: 'older' },
        ],
      }),
      memoryService: createMockMemoryService({
        listRows: [{ content: 'loves jazz' }],
      }) as any,
    })
    const ws = createMockWs()

    await maid.onOpen!(new Event('open'), ws as any)

    expect(ws.sent).toContainEqual({ type: 'welcome', message: 'Welcome from model' })
    expect(prompt).toContain('# User memories')
    expect(prompt).toContain('- loves jazz')
    expect(prompt).toContain('# Recent conversation')
    expect(prompt).toContain('user: older')
    expect(prompt).toContain('assistant: latest')
  })

  test('falls back to default welcome when open flow throws', async () => {
    generateTextImpl = async () => {
      throw new Error('llm down')
    }

    const maid = new ChatMaid({
      sessionService: createMockSessionService({ userId: 'u3' }),
      memoryService: createMockMemoryService() as any,
    })
    const ws = createMockWs()

    await maid.onOpen!(new Event('open'), ws as any)

    expect(ws.sent).toContainEqual({
      type: 'welcome',
      message: 'Hello! How can I help you today?',
    })
  })
})

describe('ChatMaid onMessage validation and control', () => {
  test('returns invalid format for invalid JSON', async () => {
    const maid = new ChatMaid({
      sessionService: createMockSessionService({ userId: 'u4' }),
      memoryService: createMockMemoryService() as any,
    })
    const ws = createMockWs()

    await maid.onMessage!(new MessageEvent('message', { data: '{oops' }), ws as any)

    expect(ws.sent).toEqual([{ type: 'error', message: 'Invalid message format' }])
  })

  test('returns invalid format for schema mismatch', async () => {
    const maid = new ChatMaid({
      sessionService: createMockSessionService({ userId: 'u5' }),
      memoryService: createMockMemoryService() as any,
    })
    const ws = createMockWs()

    await maid.onMessage!(
      new MessageEvent('message', { data: JSON.stringify({ e: 'unknown', msg: 'hi' }) }),
      ws as any,
    )

    expect(ws.sent).toEqual([{ type: 'error', message: 'Invalid message format' }])
  })

  test('returns empty input for blank message', async () => {
    const maid = new ChatMaid({
      sessionService: createMockSessionService({ userId: 'u6' }),
      memoryService: createMockMemoryService() as any,
    })
    const ws = createMockWs()

    await maid.onMessage!(inputMessage('   '), ws as any)

    expect(ws.sent).toEqual([{ type: 'error', message: 'Empty input' }])
  })

  test('aborts current stream and closes websocket on abort event', async () => {
    let aborted = false
    const maid = new ChatMaid({
      sessionService: createMockSessionService({ userId: 'u7' }),
      memoryService: createMockMemoryService() as any,
    })
    ;(maid as any).currentStream = {
      abort() { aborted = true },
    }
    const ws = createMockWs()

    await maid.onMessage!(abortMessage(), ws as any)

    expect(aborted).toBe(true)
    expect(ws.sent).toContainEqual({ type: 'aborted' })
    expect(ws.closed).toContainEqual({ code: 1000, reason: 'Aborted by user' })
  })
})

describe('ChatMaid streaming and queue behavior', () => {
  test('streams deltas and persists user + assistant messages', async () => {
    const addCalls: Array<{ sessionId: number, role: string, content: string }> = []
    const memoryJobs: number[] = []

    let streamInput = ''
    let streamInstructions = ''
    streamResponseImpl = (input, instructions) => {
      streamInput = input
      streamInstructions = instructions ?? ''
      return createStream(['hello ', 'world'])
    }

    const maid = new ChatMaid({
      sessionService: createMockSessionService({
        userId: 'u8',
        onCreate: async () => createSessionRow(99, 'u8'),
        onAddMessage: async (sessionId, role, content) => {
          addCalls.push({ sessionId, role, content })
        },
      }),
      memoryService: createMockMemoryService({
        onEnqueue: () => {
          memoryJobs.push(1)
        },
      }) as any,
    })
    const ws = createMockWs()

    await maid.onMessage!(inputMessage('  hi there  '), ws as any)

    expect(ws.sent).toContainEqual({ type: 'session.created', sessionId: 99 })
    expect(ws.sent).toContainEqual({ type: 'text.delta', data: 'hello ' })
    expect(ws.sent).toContainEqual({ type: 'text.delta', data: 'world' })
    expect(ws.sent).toContainEqual({ type: 'text.done' })
    expect(streamInput).toBe('hi there')
    expect(streamInstructions).toContain('# Current Conversation')
    expect(streamInstructions).toContain('user: hi there')
    expect(addCalls).toEqual([
      { sessionId: 99, role: 'user', content: 'hi there' },
      { sessionId: 99, role: 'assistant', content: 'hello world' },
    ])
    expect(memoryJobs).toEqual([1])
  })

  test('handles stream errors by sending generation error', async () => {
    const addCalls: Array<{ role: string, content: string }> = []
    streamResponseImpl = () => createStream([], new Error('stream failed'))

    const maid = new ChatMaid({
      sessionService: createMockSessionService({
        userId: 'u9',
        onCreate: async () => createSessionRow(9, 'u9'),
        onAddMessage: async (_id, role, content) => {
          addCalls.push({ role, content })
        },
      }),
      memoryService: createMockMemoryService() as any,
    })
    const ws = createMockWs()

    await maid.onMessage!(inputMessage('fail me'), ws as any)

    expect(ws.sent).toContainEqual({ type: 'error', message: 'Failed to generate response' })
    expect(addCalls).toEqual([{ role: 'user', content: 'fail me' }])
  })

  test('swallows abort errors from stream without sending generation error', async () => {
    const abortError = new Error('aborted')
    abortError.name = 'APIUserAbortError'
    streamResponseImpl = () => createStream([], abortError)

    const maid = new ChatMaid({
      sessionService: createMockSessionService({
        userId: 'u10',
        onCreate: async () => createSessionRow(10, 'u10'),
      }),
      memoryService: createMockMemoryService() as any,
    })
    const ws = createMockWs()

    await maid.onMessage!(inputMessage('abort stream'), ws as any)

    const generationErrors = ws.sent.filter((m) => m.type === 'error')
    expect(generationErrors).toHaveLength(0)
  })

  test('recovers queue after a failed message and processes the next one', async () => {
    let attempts = 0

    const maid = new ChatMaid({
      sessionService: createMockSessionService({
        userId: 'u11',
        onCreate: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('first create fails')
          return createSessionRow(123, 'u11')
        },
      }),
      memoryService: createMockMemoryService() as any,
    })
    const ws = createMockWs()

    await maid.onMessage!(inputMessage('first'), ws as any)
    await maid.onMessage!(inputMessage('second'), ws as any)

    expect(ws.sent).toContainEqual({ type: 'error', message: 'Failed to process message' })
    expect(ws.sent).toContainEqual({ type: 'session.created', sessionId: 123 })
  })
})

describe('ChatMaid lifecycle cleanup', () => {
  test('aborts stream and clears history on close and error', () => {
    let aborts = 0
    const maid = new ChatMaid({
      sessionService: createMockSessionService({ userId: 'u12' }),
      memoryService: createMockMemoryService() as any,
    })

    ;(maid as any).currentStream = { abort: () => { aborts += 1 } }
    ;(maid as any).history = [{ role: 'user', content: 'keep?' }]
    maid.onClose!()

    expect(aborts).toBe(1)
    expect((maid as any).history).toEqual([])

    ;(maid as any).currentStream = { abort: () => { aborts += 1 } }
    ;(maid as any).history = [{ role: 'assistant', content: 'keep?' }]
    maid.onError!()

    expect(aborts).toBe(2)
    expect((maid as any).history).toEqual([])
  })
})
