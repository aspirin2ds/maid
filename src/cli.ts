import 'dotenv/config'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

type ServerMessage =
  | { type: 'chat.delta'; delta: string }
  | { type: 'chat.done'; sessionId: number }
  | { type: 'chat.session_created'; sessionId: number }
  | { type: 'error'; message: string }

const AUTH_BASE_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'
const MAID_BASE_URL = process.env.MAID_BASE_URL ?? 'http://localhost:3010'
const MAID_ID = process.env.MAID_ID ?? 'cli'
const TOKEN_FILE = process.env.MAID_AUTH_TOKEN_FILE ?? join(homedir(), '.maid-auth-token')

function commandError(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

async function api(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${AUTH_BASE_URL}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = data?.message ?? data?.error ?? `Request failed (${res.status})`
    throw new Error(message)
  }

  const token = res.headers.get('set-auth-token')
  if (token) {
    await writeFile(TOKEN_FILE, token, { mode: 0o600 })
    console.log(`Token saved to ${TOKEN_FILE}`)
  }

  return data
}

async function loadToken(): Promise<string> {
  try {
    return (await readFile(TOKEN_FILE, 'utf-8')).trim()
  } catch {
    throw new Error(`Not authenticated. Run "cli login email" or "cli login phone" first.`)
  }
}

function toWebSocketBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`Unsupported MAID_BASE_URL protocol: ${url.protocol}`)
  }
  url.pathname = '/ws'
  url.search = ''
  return url.toString()
}

async function loginEmail() {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const email = (await rl.question('Email: ')).trim()
    const password = (await rl.question('Password: ')).trim()
    if (!email) commandError('Email is required')
    if (!password) commandError('Password is required')

    await api('/sign-in/email', { email, password })
    console.log('Signed in successfully.')
  } finally {
    rl.close()
  }
}

async function loginPhone() {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const phoneNumber = (await rl.question('Phone number (e.g. +8613800138000): ')).trim()
    if (!phoneNumber) commandError('Phone number is required')

    await api('/phone-number/send-otp', { phoneNumber })
    console.log('OTP sent to your phone.')
    const code = (await rl.question('OTP code: ')).trim()
    if (!code) commandError('OTP code is required')

    await api('/phone-number/verify', { phoneNumber, code })
    console.log('Signed in successfully.')
  } finally {
    rl.close()
  }
}

type PendingResponse = {
  printed: boolean
  resolve: (sessionId: number) => void
  reject: (error: Error) => void
}

type ChatOptions = {
  sessionId?: number
}

function parseChatOptions(args: string[]): ChatOptions {
  let sessionId: number | undefined

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]

    if (arg === '--session' || arg === '-s') {
      const value = args[i + 1]
      if (!value) commandError('Missing value for --session')
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        commandError(`Invalid session id: ${value}`)
      }
      sessionId = parsed
      i += 1
      continue
    }

    if (arg.startsWith('--session=')) {
      const value = arg.slice('--session='.length)
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        commandError(`Invalid session id: ${value}`)
      }
      sessionId = parsed
      continue
    }

    commandError(`Unknown chat option: ${arg}`)
  }

  return { sessionId }
}

type WelcomeOptions = {
  sessionId?: number
}

function parseWelcomeOptions(args: string[]): WelcomeOptions {
  const { sessionId } = parseChatOptions(args)
  return { sessionId }
}

async function chat(options: ChatOptions = {}) {
  const token = await loadToken()
  const wsUrl = new URL(toWebSocketBaseUrl(MAID_BASE_URL))
  wsUrl.searchParams.set('token', token)
  wsUrl.searchParams.set('maidId', MAID_ID)
  if (options.sessionId !== undefined) {
    wsUrl.searchParams.set('sessionId', String(options.sessionId))
  }

  const rl = createInterface({ input: stdin, output: stdout })
  const ws = new WebSocket(wsUrl)

  let pending: PendingResponse | null = null
  let closed = false
  const openPromise = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (err) => reject(err.message)
  })

  ws.onmessage = (event) => {
    let message: ServerMessage
    try {
      message = JSON.parse(String(event.data))
    } catch {
      console.error('\n[server] invalid JSON response')
      return
    }

    if (message.type === 'chat.delta') {
      if (!pending) return
      if (!pending.printed) {
        pending.printed = true
        stdout.write('assistant> ')
      }
      stdout.write(message.delta)
      return
    }

    if (message.type === 'chat.session_created') {
      wsUrl.searchParams.set('sessionId', String(message.sessionId))
      console.log(`[session] ${message.sessionId}`)
      return
    }

    if (message.type === 'chat.done') {
      wsUrl.searchParams.set('sessionId', String(message.sessionId))

      if (pending) {
        if (pending.printed) stdout.write('\n')
        pending.resolve(message.sessionId)
        pending = null
      }
      return
    }

    if (pending) {
      pending.reject(new Error(message.message))
      pending = null
      return
    }
    console.error(`\n[server] ${message.message}`)
  }

  ws.onclose = () => {
    closed = true
    if (pending) {
      pending.reject(new Error('WebSocket closed'))
      pending = null
    }
  }

  try {
    await openPromise
    console.log('Connected. Type a message and press Enter. Type "exit" to quit.')

    ws.send(JSON.stringify({ type: 'chat.welcome' }))
    await new Promise<number>((resolve, reject) => {
      pending = { printed: false, resolve, reject }
    })

    while (!closed) {
      const input = (await rl.question('you> ')).trim()
      if (!input) continue
      if (input === 'exit' || input === 'quit') break

      if (pending) commandError('Previous request is still in progress')

      ws.send(JSON.stringify({ type: 'chat.input', content: input }))
      await new Promise<number>((resolve, reject) => {
        pending = { printed: false, resolve, reject }
      })
    }
  } finally {
    rl.close()
    if (!closed) ws.close()
  }
}

async function welcome(options: WelcomeOptions = {}) {
  const token = await loadToken()
  const wsUrl = new URL(toWebSocketBaseUrl(MAID_BASE_URL))
  wsUrl.searchParams.set('token', token)
  wsUrl.searchParams.set('maidId', MAID_ID)
  if (options.sessionId !== undefined) {
    wsUrl.searchParams.set('sessionId', String(options.sessionId))
  }

  const ws = new WebSocket(wsUrl)
  let printed = false

  const donePromise = new Promise<number>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'chat.welcome' }))
    }

    ws.onerror = (err) => {
      reject(new Error(err.message))
    }

    ws.onmessage = (event) => {
      let message: ServerMessage
      try {
        message = JSON.parse(String(event.data))
      } catch {
        reject(new Error('invalid JSON response'))
        return
      }

      if (message.type === 'chat.delta') {
        if (!printed) {
          printed = true
          stdout.write('assistant> ')
        }
        stdout.write(message.delta)
        return
      }

      if (message.type === 'chat.session_created') {
        wsUrl.searchParams.set('sessionId', String(message.sessionId))
        console.log(`[session] ${message.sessionId}`)
        return
      }

      if (message.type === 'chat.done') {
        if (printed) stdout.write('\n')
        resolve(message.sessionId)
        return
      }

      reject(new Error(message.message))
    }

    ws.onclose = () => {
      reject(new Error('WebSocket closed'))
    }
  })

  try {
    await donePromise
  } finally {
    ws.close()
  }
}

async function logout() {
  try {
    await unlink(TOKEN_FILE)
    console.log(`Token removed: ${TOKEN_FILE}`)
  } catch {
    console.log(`No token file found: ${TOKEN_FILE}`)
  }
}

function printUsage() {
  console.log(
    [
      'Usage:',
      '  bun run cli login email',
      '  bun run cli login phone',
      '  bun run cli chat [--session <id>]',
      '  bun run cli welcome [--session <id>]',
      '  bun run cli logout',
      '',
      'Environment:',
      `  BETTER_AUTH_URL=${AUTH_BASE_URL}`,
      `  MAID_BASE_URL=${MAID_BASE_URL}`,
      `  MAID_ID=${MAID_ID}`,
      `  MAID_AUTH_TOKEN_FILE=${TOKEN_FILE}`,
    ].join('\n'),
  )
}

async function main() {
  const [, , ...args] = process.argv
  const [command, ...rest] = args

  if (command === 'login' && rest[0] === 'email') {
    await loginEmail()
    return
  }

  if (command === 'login' && rest[0] === 'phone') {
    await loginPhone()
    return
  }

  if (command === 'chat') {
    const options = parseChatOptions(rest)
    await chat(options)
    return
  }

  if (command === 'welcome') {
    const options = parseWelcomeOptions(rest)
    await welcome(options)
    return
  }

  if (command === 'logout') {
    await logout()
    return
  }

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage()
    return
  }

  commandError(`Unknown command: ${[command, ...rest].filter(Boolean).join(' ')}`)
}

main().catch((error) => commandError(error instanceof Error ? error.message : String(error)))
