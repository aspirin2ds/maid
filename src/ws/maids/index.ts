import type { ServerWebSocket } from 'bun'
import type { StreamSocketData } from '../index'
import type { ClientMessage } from '../schema'
import { chatMaidHandler } from './chat'

type ClientEventType = ClientMessage['type']

/** Typed handler for a specific client event, extracting the matching payload variant. */
type MaidEventHandler<T extends ClientEventType> = (
  ws: ServerWebSocket<StreamSocketData>,
  payload: Extract<ClientMessage, { type: T }>
) => void | Promise<void>

/** Each maid implements this interface to handle the four client event types. */
export interface StreamSocketHandler {
  onWelcome: MaidEventHandler<'welcome'>
  onInput: MaidEventHandler<'input'>
  onAbort: MaidEventHandler<'abort'>
  onBye: MaidEventHandler<'bye'>
}

// -- Maid registry ------------------------------------------------------------

const streamSocketHandlersByMaidId: Record<string, StreamSocketHandler> = {
  cli: chatMaidHandler,
  chat: chatMaidHandler,
}

export function findStreamSocketHandler(maidId: string): StreamSocketHandler | null {
  return streamSocketHandlersByMaidId[maidId] ?? null
}

