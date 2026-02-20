import 'dotenv/config'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { messages, sessions } from '../../src/db/schema'
import {
  setupE2eTestEnv,
  teardownE2eTestEnv,
  type E2eTestEnv,
} from './helpers/testcontainers'
import {
  issueConnectionKey,
  startServer,
  WsClient,
  type WsServer,
} from './helpers/ws-server'

const USER_ID = 'e2e-test-user'
const TIMEOUT = 30_000
const LONG_PROMPT = 'Write a very long essay about the history of computing'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

let env: E2eTestEnv | undefined
let server: WsServer | undefined

beforeAll(async () => {
  env = await setupE2eTestEnv()
  server = startServer(env)
}, 120_000)

afterAll(async () => {
  server?.close()
  await teardownE2eTestEnv(env)
})

function connect(params: Record<string, string>) {
  const client = new WsClient()
  return client.connect(server!.url, params).then(() => client)
}

async function chatClient(extra: { sessionId?: string, userId?: string } = {}) {
  const userId = extra.userId ?? USER_ID
  const connectionKey = await issueConnectionKey(server!, userId, extra.sessionId)
  return connect({ maidId: 'chat', connectionKey })
}

async function connectWithConnectionKey(maidId: string, userId = USER_ID, sessionId?: string) {
  const connectionKey = await issueConnectionKey(server!, userId, sessionId)
  return connect({ maidId, connectionKey })
}

describe('ws e2e', () => {

  describe('input', () => {
    test('creates session, streams response, saves to DB', async () => {
      const ws = await chatClient()

      ws.send({ type: 'input', content: 'Say exactly: "pong"' })
      await ws.waitDone(TIMEOUT)
      ws.close()

      const types = ws.messages.map(m => m.type)
      expect(types).toContain('session_created')
      expect(types).toContain('stream_start')
      expect(types).toContain('stream_text_delta')
      expect(types).toContain('stream_done')

      expect(types.indexOf('session_created')).toBeLessThan(types.indexOf('stream_start'))

      const sid = (ws.messages.find(m => m.type === 'session_created') as any).sessionId as number
      expect(sid).toBeGreaterThan(0)
      expect((ws.messages.find(m => m.type === 'stream_done') as any).sessionId).toBe(sid)

      const deltas = ws.messages
        .filter(m => m.type === 'stream_text_delta')
        .map(m => (m as any).delta)
        .join('')
      expect(deltas.length).toBeGreaterThan(0)

      const [row] = await env!.db.select().from(sessions).where(eq(sessions.id, sid))
      expect(row).toBeDefined()
      expect(row.userId).toBe(USER_ID)

      const rows = await env!.db.select().from(messages).where(eq(messages.sessionId, sid))
      expect(rows.length).toBe(2)
      expect(rows.find(m => m.role === 'user')?.content).toBe('Say exactly: "pong"')
      expect(rows.find(m => m.role === 'assistant')!.content.length).toBeGreaterThan(0)
    }, TIMEOUT + 10_000)
  })

  describe('welcome', () => {
    test('creates session, streams welcome, saves only assistant message', async () => {
      const ws = await chatClient()

      ws.send({ type: 'welcome' })
      await ws.waitDone(TIMEOUT)
      ws.close()

      const types = ws.messages.map(m => m.type)
      expect(types).toContain('session_created')
      expect(types).toContain('stream_start')
      expect(types).toContain('stream_text_delta')
      expect(types).toContain('stream_done')

      const sid = (ws.messages.find(m => m.type === 'session_created') as any).sessionId
      const rows = await env!.db.select().from(messages).where(eq(messages.sessionId, sid))
      expect(rows.length).toBe(1)
      expect(rows[0].role).toBe('assistant')
    }, TIMEOUT + 10_000)
  })

  describe('existing session', () => {
    test('no session_created emitted', async () => {
      const [seeded] = await env!.db
        .insert(sessions)
        .values({ userId: USER_ID, title: null, metadata: {} })
        .returning({ id: sessions.id })

      const ws = await chatClient({ sessionId: String(seeded.id) })

      ws.send({ type: 'input', content: 'Hello again' })
      await ws.waitDone(TIMEOUT)
      ws.close()

      const types = ws.messages.map(m => m.type)
      expect(types).not.toContain('session_created')
      expect(types).toContain('stream_start')
      expect(types).toContain('stream_done')
      expect((ws.messages.find(m => m.type === 'stream_done') as any).sessionId).toBe(seeded.id)
    }, TIMEOUT + 10_000)
  })

  describe('abort', () => {
    test('no error sent to client', async () => {
      const ws = await chatClient()

      ws.send({ type: 'input', content: LONG_PROMPT })
      await ws.waitFor('stream_start', TIMEOUT)
      ws.send({ type: 'abort' })
      await wait(1000)

      expect(ws.messages.filter(m => m.type === 'error')).toHaveLength(0)
      ws.close()
    }, TIMEOUT + 10_000)

    test('no stream_done emitted', async () => {
      const ws = await chatClient()

      ws.send({ type: 'input', content: LONG_PROMPT })
      await ws.waitFor('stream_start', TIMEOUT)
      ws.send({ type: 'abort' })
      await wait(1000)

      expect(ws.messages.map(m => m.type)).not.toContain('stream_done')
      ws.close()
    }, TIMEOUT + 10_000)

    test('user message saved, no assistant message in DB', async () => {
      const ws = await chatClient()

      ws.send({ type: 'input', content: LONG_PROMPT })
      await ws.waitFor('stream_start', TIMEOUT)
      ws.send({ type: 'abort' })
      await wait(1000)

      const sid = (ws.messages.find(m => m.type === 'session_created') as any).sessionId as number
      const rows = await env!.db.select().from(messages).where(eq(messages.sessionId, sid))
      expect(rows.find(m => m.role === 'user')).toBeDefined()
      expect(rows.find(m => m.role === 'assistant')).toBeUndefined()

      ws.close()
    }, TIMEOUT + 10_000)

    test('safe when no stream is active', async () => {
      const ws = await chatClient()

      ws.send({ type: 'abort' })
      await wait(500)

      expect(ws.messages.filter(m => m.type === 'error')).toHaveLength(0)

      ws.send({ type: 'bye' })
      expect((await ws.waitClose()).code).toBe(1000)
    })

    test('deltas stop arriving', async () => {
      const ws = await chatClient()

      ws.send({ type: 'input', content: LONG_PROMPT })
      await ws.waitFor('stream_text_delta', TIMEOUT)
      ws.send({ type: 'abort' })

      await wait(1000)
      const count = ws.messages.filter(m => m.type === 'stream_text_delta').length

      await wait(500)
      expect(ws.messages.filter(m => m.type === 'stream_text_delta').length).toBe(count)

      ws.close()
    }, TIMEOUT + 10_000)

    test('cancels queued input', async () => {
      const ws = await chatClient()

      ws.send({ type: 'input', content: LONG_PROMPT })
      ws.send({ type: 'input', content: 'Now write another long essay about mathematics' })

      await ws.waitFor('stream_start', TIMEOUT)
      ws.send({ type: 'abort' })
      await wait(1500)

      expect(ws.messages.filter(m => m.type === 'stream_start')).toHaveLength(1)
      expect(ws.messages.filter(m => m.type === 'error')).toHaveLength(0)

      ws.close()
    }, TIMEOUT + 10_000)
  })

  describe('bye', () => {
    test('closes with code 1000', async () => {
      const ws = await chatClient()

      ws.send({ type: 'bye' })
      expect((await ws.waitClose()).code).toBe(1000)
    })

    test('during active stream: closes cleanly', async () => {
      const ws = await chatClient()

      ws.send({ type: 'input', content: LONG_PROMPT })
      await ws.waitFor('stream_start', TIMEOUT)
      ws.send({ type: 'bye' })

      expect((await ws.waitClose()).code).toBe(1000)
      expect(ws.messages.filter(m => m.type === 'error')).toHaveLength(0)
    }, TIMEOUT + 10_000)
  })

  describe('errors', () => {
    test('invalid JSON: sends error, connection stays open', async () => {
      const ws = await chatClient()

      ws.sendRaw('not json at all')

      const err = await ws.waitFor('error')
      expect((err as any).message).toBe('invalid JSON')

      ws.send({ type: 'bye' })
      expect((await ws.waitClose()).code).toBe(1000)
    })

    test('unknown maidId: error + close 1008', async () => {
      const ws = await connectWithConnectionKey('nonexistent')

      const err = await ws.waitFor('error')
      expect((err as any).message).toContain('unknown maidId')
      expect((await ws.waitClose()).code).toBe(1008)
    })

    test('session not found: connection key request fails', async () => {
      await expect(chatClient({ sessionId: '999999' })).rejects.toThrow('Failed to issue connection key: 404')
    })
  })

  describe('disconnect', () => {
    test('mid-stream: server stays healthy', async () => {
      const ws = await chatClient()

      ws.send({ type: 'input', content: LONG_PROMPT })
      await ws.waitFor('stream_start', TIMEOUT)
      ws.close()

      await wait(1000)

      const probe = await chatClient()
      probe.send({ type: 'bye' })
      expect((await probe.waitClose()).code).toBe(1000)
    }, TIMEOUT + 10_000)
  })
})
