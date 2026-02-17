import { z } from 'zod'
import type { ServerWebSocket } from 'bun'
import type { StreamSocketData } from './index'

// -- Incoming message schemas ------------------------------------------------

const chatInput = z.object({
  type: z.literal("chat.input"),
  content: z.string().min(1),
})

const chatAbort = z.object({
  type: z.literal("chat.abort"),
})

const chatWelcome = z.object({
  type: z.literal("chat.welcome"),
})

export const clientMessage = z.discriminatedUnion("type", [
  chatInput,
  chatAbort,
  chatWelcome,
])

export type ClientMessage = z.infer<typeof clientMessage>

// -- Outgoing message schemas ------------------------------------------------

export const serverMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat.delta"), delta: z.string() }),
  z.object({ type: z.literal("chat.done"), sessionId: z.number() }),
  z.object({ type: z.literal("chat.session_created"), sessionId: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
])

export type ServerMessage = z.infer<typeof serverMessage>

// -- Routing -----------------------------------------------------------------

// Messages handled outside the queue (e.g. abort must not wait behind in-flight work)
type ImmediateMessageType = "chat.abort"
type QueuedMessageType = Exclude<ClientMessage["type"], ImmediateMessageType>

type MessageHandler<T extends ClientMessage["type"]> = (
  ws: ServerWebSocket<StreamSocketData>,
  payload: Extract<ClientMessage, { type: T }>,
) => void | Promise<void>

type MessageRouter = {
  [K in QueuedMessageType]: MessageHandler<K>
}

export function createRouter(handlers: MessageRouter) {
  return (ws: ServerWebSocket<StreamSocketData>, msg: ClientMessage) => {
    const handler = handlers[msg.type as QueuedMessageType] as MessageHandler<typeof msg.type>
    return handler(ws, msg as any)
  }
}

// -- Helpers -----------------------------------------------------------------

export function send(ws: ServerWebSocket<StreamSocketData>, msg: ServerMessage) {
  ws.sendText(JSON.stringify(msg))
}
