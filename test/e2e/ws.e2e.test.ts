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
  createTestServer,
  WsClient,
  type TestServer,
} from './helpers/ws-server'

const TEST_USER_ID = 'e2e-test-user'
const STREAM_TIMEOUT = 30_000

let env: E2eTestEnv | undefined
let server: TestServer | undefined

beforeAll(async () => {
  env = await setupE2eTestEnv()
  server = createTestServer(env)
}, 120_000)

afterAll(async () => {
  server?.close()
  await teardownE2eTestEnv(env)
})

function wsUrl() {
  return server!.url
}

describe('ws e2e', () => {
  // 1. Full input flow
  test('input: creates session, streams response, saves to DB', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })

    client.send({ type: 'input', content: 'Say exactly: "pong"' })

    await client.waitForStreamComplete(STREAM_TIMEOUT)
    client.close()

    // Verify message sequence
    const types = client.messages.map(m => m.type)
    expect(types).toContain('session_created')
    expect(types).toContain('stream_start')
    expect(types).toContain('stream_text_delta')
    expect(types).toContain('stream_done')

    // session_created comes before stream_start
    const sessionCreatedIdx = types.indexOf('session_created')
    const streamStartIdx = types.indexOf('stream_start')
    expect(sessionCreatedIdx).toBeLessThan(streamStartIdx)

    // Extract sessionId from session_created
    const sessionCreatedMsg = client.messages.find(m => m.type === 'session_created')!
    const sessionId = (sessionCreatedMsg as any).sessionId as number
    expect(sessionId).toBeGreaterThan(0)

    // Verify stream_done has same sessionId
    const streamDoneMsg = client.messages.find(m => m.type === 'stream_done')!
    expect((streamDoneMsg as any).sessionId).toBe(sessionId)

    // Verify deltas form a non-empty string
    const deltas = client.messages
      .filter(m => m.type === 'stream_text_delta')
      .map(m => (m as any).delta)
      .join('')
    expect(deltas.length).toBeGreaterThan(0)

    // Verify DB: session exists
    const [dbSession] = await env!.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
    expect(dbSession).toBeDefined()
    expect(dbSession.userId).toBe(TEST_USER_ID)

    // Verify DB: user + assistant messages saved
    const dbMessages = await env!.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
    expect(dbMessages.length).toBe(2)
    expect(dbMessages.find(m => m.role === 'user')?.content).toBe('Say exactly: "pong"')
    expect(dbMessages.find(m => m.role === 'assistant')).toBeDefined()
    expect(dbMessages.find(m => m.role === 'assistant')!.content.length).toBeGreaterThan(0)
  }, STREAM_TIMEOUT + 10_000)

  // 2. Welcome flow
  test('welcome: creates session, streams welcome message', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })

    client.send({ type: 'welcome' })

    await client.waitForStreamComplete(STREAM_TIMEOUT)
    client.close()

    const types = client.messages.map(m => m.type)
    expect(types).toContain('session_created')
    expect(types).toContain('stream_start')
    expect(types).toContain('stream_text_delta')
    expect(types).toContain('stream_done')

    // Welcome does NOT save a user message — only assistant
    const sessionId = (client.messages.find(m => m.type === 'session_created') as any).sessionId
    const dbMessages = await env!.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
    expect(dbMessages.length).toBe(1)
    expect(dbMessages[0].role).toBe('assistant')
  }, STREAM_TIMEOUT + 10_000)

  // 3. Existing session — no session_created
  test('existing session: no session_created emitted', async () => {
    // Seed a session in DB
    const [seeded] = await env!.db
      .insert(sessions)
      .values({ userId: TEST_USER_ID, title: null, metadata: {} })
      .returning({ id: sessions.id })

    const client = new WsClient()
    await client.connect(wsUrl(), {
      maidId: 'chat',
      userId: TEST_USER_ID,
      sessionId: String(seeded.id),
    })

    client.send({ type: 'input', content: 'Hello again' })

    await client.waitForStreamComplete(STREAM_TIMEOUT)
    client.close()

    const types = client.messages.map(m => m.type)
    expect(types).not.toContain('session_created')
    expect(types).toContain('stream_start')
    expect(types).toContain('stream_done')

    // stream_done should reference the seeded session
    const streamDoneMsg = client.messages.find(m => m.type === 'stream_done')!
    expect((streamDoneMsg as any).sessionId).toBe(seeded.id)
  }, STREAM_TIMEOUT + 10_000)

  // 4. Abort mid-stream — no error to client
  test('abort: stops stream without error to client', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })

    client.send({ type: 'input', content: 'Write a very long essay about the history of computing' })

    // Wait for stream to start then abort
    await client.waitFor('stream_start', STREAM_TIMEOUT)
    client.send({ type: 'abort' })

    // Give some time for the abort to take effect
    await new Promise(r => setTimeout(r, 1000))

    // Should not have received an error message
    const errors = client.messages.filter(m => m.type === 'error')
    expect(errors).toHaveLength(0)

    client.close()
  }, STREAM_TIMEOUT + 10_000)

  // 4a. Abort mid-stream — no stream_done emitted
  test('abort: no stream_done after abort', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })

    client.send({ type: 'input', content: 'Write a very long essay about the history of computing' })

    await client.waitFor('stream_start', STREAM_TIMEOUT)
    client.send({ type: 'abort' })

    await new Promise(r => setTimeout(r, 1000))

    // stream_done should NOT be present — the stream was aborted before completing
    const types = client.messages.map(m => m.type)
    expect(types).not.toContain('stream_done')

    client.close()
  }, STREAM_TIMEOUT + 10_000)

  // 4b. Abort mid-stream — DB state: user message saved, no assistant message
  test('abort: user message saved but no assistant message in DB', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })

    client.send({ type: 'input', content: 'Write a very long essay about the history of computing' })

    await client.waitFor('stream_start', STREAM_TIMEOUT)
    client.send({ type: 'abort' })

    await new Promise(r => setTimeout(r, 1000))

    // session_created should still have fired (session was created before streaming)
    const sessionCreatedMsg = client.messages.find(m => m.type === 'session_created')
    expect(sessionCreatedMsg).toBeDefined()
    const sessionId = (sessionCreatedMsg as any).sessionId as number

    // User message is saved before streaming starts, so it should exist
    const dbMessages = await env!.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
    const userMsg = dbMessages.find(m => m.role === 'user')
    expect(userMsg).toBeDefined()

    // Assistant message should NOT exist — the stream was aborted
    const assistantMsg = dbMessages.find(m => m.role === 'assistant')
    expect(assistantMsg).toBeUndefined()

    client.close()
  }, STREAM_TIMEOUT + 10_000)

  // 4c. Abort with no active stream — safe no-op
  test('abort: safe when no stream is active', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })

    // Send abort immediately — no input was ever sent, no stream exists
    client.send({ type: 'abort' })

    await new Promise(r => setTimeout(r, 500))

    // No error, no crash
    const errors = client.messages.filter(m => m.type === 'error')
    expect(errors).toHaveLength(0)

    // Connection still usable
    client.send({ type: 'bye' })
    const closeEvent = await client.waitForClose()
    expect(closeEvent.code).toBe(1000)
  })

  // 4d. Abort stops deltas — no new deltas arrive after abort
  test('abort: no new deltas arrive after abort', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })

    client.send({ type: 'input', content: 'Write a very long essay about the history of computing' })

    // Wait for at least one delta to confirm streaming has started
    await client.waitFor('stream_text_delta', STREAM_TIMEOUT)
    const deltaCountBefore = client.messages.filter(m => m.type === 'stream_text_delta').length

    client.send({ type: 'abort' })

    // Wait for abort to propagate
    await new Promise(r => setTimeout(r, 1000))

    const deltaCountAfter = client.messages.filter(m => m.type === 'stream_text_delta').length

    // Some deltas may have been in-flight when we aborted, but the count should
    // have stopped growing. Verify no new deltas arrive after the settle period.
    await new Promise(r => setTimeout(r, 500))
    const deltaCountFinal = client.messages.filter(m => m.type === 'stream_text_delta').length
    expect(deltaCountFinal).toBe(deltaCountAfter)

    client.close()
  }, STREAM_TIMEOUT + 10_000)

  // 4e. Bye during active stream — closes cleanly
  test('bye during stream: closes with 1000, no error', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })

    client.send({ type: 'input', content: 'Write a very long essay about the history of computing' })

    await client.waitFor('stream_start', STREAM_TIMEOUT)
    client.send({ type: 'bye' })

    const closeEvent = await client.waitForClose()
    expect(closeEvent.code).toBe(1000)

    // No error should have been sent
    const errors = client.messages.filter(m => m.type === 'error')
    expect(errors).toHaveLength(0)
  }, STREAM_TIMEOUT + 10_000)

  // 4f. Abort queued input — second input never starts streaming
  test('abort: cancels queued input that has not started', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })

    // Send two inputs rapidly — the second is queued behind the first
    client.send({ type: 'input', content: 'Write a very long essay about the history of computing' })
    client.send({ type: 'input', content: 'Now write another long essay about mathematics' })

    // Wait for the first stream to start
    await client.waitFor('stream_start', STREAM_TIMEOUT)

    // Abort clears the queue and cancels the active stream
    client.send({ type: 'abort' })

    await new Promise(r => setTimeout(r, 1500))

    // Should only have one stream_start (the second input was cleared from the queue)
    const streamStarts = client.messages.filter(m => m.type === 'stream_start')
    expect(streamStarts).toHaveLength(1)

    // No error
    const errors = client.messages.filter(m => m.type === 'error')
    expect(errors).toHaveLength(0)

    client.close()
  }, STREAM_TIMEOUT + 10_000)

  // 5. Bye
  test('bye: closes connection with code 1000', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })

    client.send({ type: 'bye' })

    const closeEvent = await client.waitForClose()
    expect(closeEvent.code).toBe(1000)
  })

  // 6. Invalid JSON
  test('invalid JSON: sends error, connection stays open', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })

    client.sendRaw('not json at all')

    const errorMsg = await client.waitFor('error')
    expect((errorMsg as any).message).toBe('invalid JSON')

    // Connection still open — can still send bye
    client.send({ type: 'bye' })
    const closeEvent = await client.waitForClose()
    expect(closeEvent.code).toBe(1000)
  })

  // 7. Unknown maid
  test('unknown maidId: sends error and closes with 1008', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'nonexistent', userId: TEST_USER_ID })

    // open handler fires withMaid check, which sends error + closes
    const errorMsg = await client.waitFor('error')
    expect((errorMsg as any).message).toContain('unknown maidId')

    const closeEvent = await client.waitForClose()
    expect(closeEvent.code).toBe(1008)
  })

  // 8. Session not found
  test('session not found: sends error and closes with 1008', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), {
      maidId: 'chat',
      userId: TEST_USER_ID,
      sessionId: '999999',
    })

    client.send({ type: 'input', content: 'Hello' })

    const errorMsg = await client.waitFor('error')
    expect((errorMsg as any).message).toContain('not found')

    const closeEvent = await client.waitForClose()
    expect(closeEvent.code).toBe(1008)
  })

  // 9. Disconnect mid-stream — no unhandled errors
  test('disconnect mid-stream: no server crash', async () => {
    const client = new WsClient()
    await client.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })

    client.send({ type: 'input', content: 'Write a very long essay about the history of computing' })

    // Wait for stream to start then disconnect abruptly
    await client.waitFor('stream_start', STREAM_TIMEOUT)
    client.close()

    // Give server time to process the close
    await new Promise(r => setTimeout(r, 1000))

    // Verify server is still healthy by connecting again
    const healthCheck = new WsClient()
    await healthCheck.connect(wsUrl(), { maidId: 'chat', userId: TEST_USER_ID })
    healthCheck.send({ type: 'bye' })
    const closeEvent = await healthCheck.waitForClose()
    expect(closeEvent.code).toBe(1000)
  }, STREAM_TIMEOUT + 10_000)
})
