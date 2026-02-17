import type { ServerWebSocket } from 'bun'
import type { StreamSocketData } from '../index'
import type { ClientMessage } from '../schema'

type ClientEventType = ClientMessage['type']

type MaidEventHandler<T extends ClientEventType> = (
  ws: ServerWebSocket<StreamSocketData>,
  payload: Extract<ClientMessage, { type: T }>
) => void | Promise<void>

export type StreamSocketHandler = {
  onWelcome: MaidEventHandler<'welcome'>
  onInput: MaidEventHandler<'input'>
  onAbort: MaidEventHandler<'abort'>
  onBye: MaidEventHandler<'bye'>
}

