import { z } from 'zod'
import type { ServerWebSocket } from 'bun'
import type { StreamSocketData } from './index'

// -- Incoming message schemas ------------------------------------------------

const input = z.object({
  type: z.literal("input"),
  content: z.string().min(1),
})

const abort = z.object({
  type: z.literal("abort"),
})

const welcome = z.object({
  type: z.literal("welcome"),
})

const bye = z.object({
  type: z.literal("bye"),
})

export const clientMessage = z.discriminatedUnion("type", [
  input,
  abort,
  welcome,
  bye,
])

export type ClientMessage = z.infer<typeof clientMessage>

// -- Outgoing message schemas ------------------------------------------------

export const serverMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stream_start") }),
  z.object({ type: z.literal("stream_text_delta"), delta: z.string() }),
  z.object({ type: z.literal("stream_done"), sessionId: z.number() }),
  z.object({ type: z.literal("session_created"), sessionId: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
])

export type ServerMessage = z.infer<typeof serverMessage>

// -- Helpers -----------------------------------------------------------------

export function send(ws: ServerWebSocket<StreamSocketData>, msg: ServerMessage): boolean {
  try {
    ws.sendText(JSON.stringify(msg))
    return true
  } catch {
    return false
  }
}
