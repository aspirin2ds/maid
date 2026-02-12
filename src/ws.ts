import type { Context } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import { z } from 'zod'

import { streamResponse } from './llm'
import type { Session } from './session'
import type { AppEnv } from './types'

const inputEventDataSchema = z.object({
  input: z.string().trim().min(1),
  instructions: z.string().trim().min(1).optional(),
  sessionId: z.number().int().positive().optional(),
})

const websocketEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('welcome') }),
  z.object({ event: z.literal('abort') }),
  z.object({ event: z.literal('input'), data: inputEventDataSchema }),
])

type WebSocketEvent = z.infer<typeof websocketEventSchema>

type WebSocketPeer = {
  send: (message: string) => unknown
}

function readMessageData(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) {
    return Buffer.from(data).toString('utf8')
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  }
  return String(data)
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function validationErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.') || 'event'}: ${issue.message}`).join('; ')
  }
  return toErrorMessage(error)
}

function getFinalResponseText(
  response: Awaited<ReturnType<ReturnType<typeof streamResponse>['finalResponse']>>,
): string {
  const outputText = response?.output_text
  return typeof outputText === 'string' ? outputText : ''
}

function assertNever(value: never): never {
  throw new Error(`Unhandled event: ${JSON.stringify(value)}`)
}

export const streamWebSocket = upgradeWebSocket((c: Context<AppEnv>) => {
  const maid = c.req.param('maid')
  const sessionService = c.get('sessionService')
  const memoryService = c.get('memoryService')
  const querySessionId = c.req.query('session')
  const requestedSessionId = querySessionId ? Number.parseInt(querySessionId, 10) : undefined

  let activeStream: ReturnType<typeof streamResponse> | null = null
  let session: Session | null = null
  let sessionInitPromise: Promise<Session> | null = null
  let hasInput = false
  let isClosed = false
  let memoryEnqueued = false
  let inputChain: Promise<void> = Promise.resolve()

  const safeSend = (ws: WebSocketPeer, payload: unknown) => {
    try {
      const result = ws.send(JSON.stringify(payload))
      if (typeof result === 'number' && result === 0) return false
      return true
    } catch {
      return false
    }
  }

  const sendError = (ws: WebSocketPeer, error: string) => {
    safeSend(ws, { type: 'error', error })
  }

  const ensureSession = async (sessionId?: number) => {
    if (session) {
      if (sessionId !== undefined && session.id !== sessionId) {
        throw new Error(`Session already initialized as ${session.id}, got ${sessionId}`)
      }
      return session
    }

    // Guard one-time session resolution/creation so concurrent inputs don't create duplicates.
    if (!sessionInitPromise) {
      sessionInitPromise = sessionService.ensure(sessionId)
        .then((createdSession) => {
          session = createdSession
          return createdSession
        })
        .finally(() => {
          sessionInitPromise = null
        })
    }

    const resolved = await sessionInitPromise
    if (sessionId !== undefined && resolved.id !== sessionId) {
      throw new Error(`Session already initialized as ${resolved.id}, got ${sessionId}`)
    }

    return resolved
  }

  const queueInput = async (handler: () => Promise<void>) => {
    // Serialize input handling per socket to preserve ordering and avoid overlapping streams/writes.
    const run = inputChain.then(handler)
    inputChain = run.catch(() => { })
    await run
  }

  const handleWelcomeEvent = async (ws: WebSocketPeer) => {
    safeSend(ws, {
      type: 'welcome',
      maid,
      sessionId: session?.id ?? null,
    })
  }

  const handleAbortEvent = async (ws: WebSocketPeer) => {
    activeStream?.abort?.()
    activeStream = null
    safeSend(ws, { type: 'aborted' })
  }

  const handleInputEvent = async (
    payload: Extract<WebSocketEvent, { event: 'input' }>,
    ws: WebSocketPeer,
  ) => {
    if (isClosed) return

    activeStream?.abort?.()

    const activeSession = await ensureSession(payload.data.sessionId ?? requestedSessionId)

    hasInput = true

    await activeSession.saveMessage({
      role: 'user',
      content: payload.data.input,
      metadata: { maid },
    })

    safeSend(ws, {
      type: 'start',
      maid,
      sessionId: activeSession.id,
    })

    let output = ''
    const stream = streamResponse(
      payload.data.input,
      payload.data.instructions ?? `You are Maid "${maid}".`,
    )
    activeStream = stream

    stream.on('response.output_text.delta', (streamEvent) => {
      if (!streamEvent.delta || isClosed) return
      output += streamEvent.delta
      safeSend(ws, {
        type: 'delta',
        delta: streamEvent.delta,
      })
    })

    try {
      const finalResponse = await stream.finalResponse()
      const assistantMessage = output.trim().length > 0
        ? finalResponse.output_text
        : getFinalResponseText(finalResponse)

      if (assistantMessage.trim().length > 0) {
        await activeSession.saveMessage({
          role: 'assistant',
          content: assistantMessage,
          metadata: { maid },
        })
      }

      if (!isClosed) {
        safeSend(ws, { type: 'done' })
      }
    } catch (error) {
      if (!isClosed) {
        sendError(ws, toErrorMessage(error))
      }
    } finally {
      activeStream = null
    }
  }

  const routeClientEvent = async (payload: WebSocketEvent, ws: WebSocketPeer) => {
    switch (payload.event) {
      case 'welcome':
        await handleWelcomeEvent(ws)
        return
      case 'abort':
        await handleAbortEvent(ws)
        return
      case 'input':
        await queueInput(() => handleInputEvent(payload, ws))
        return
      default:
        assertNever(payload)
    }
  }

  return {
    async onMessage(event, ws) {
      let payload: WebSocketEvent

      try {
        const raw = readMessageData(event.data)
        payload = websocketEventSchema.parse(JSON.parse(raw))
      } catch (error) {
        sendError(ws, `Invalid payload: ${validationErrorMessage(error)}`)
        return
      }

      try {
        await routeClientEvent(payload, ws)
      } catch (error) {
        sendError(ws, toErrorMessage(error))
      }
    },

    async onClose() {
      isClosed = true
      activeStream?.abort?.()
      activeStream = null

      // Enqueue at most once per connection close cycle.
      if (!hasInput || memoryEnqueued) return
      memoryEnqueued = true

      try {
        await memoryService.enqueueMemoryExtraction()
      } catch {
        // Socket is already closed, so the job enqueue failure can only be observed in logs.
      }
    },
  }
})
