import { z } from 'zod'

import type { Session } from '../session'

const trimmedTextSchema = z.string().transform((value) => value.trim())

export const ChatUserMessageInputSchema = z.object({
  message: trimmedTextSchema.pipe(z.string().min(1, 'Empty input')),
})

export type ChatUserMessageInput = z.infer<typeof ChatUserMessageInputSchema>

export type PromptMessage = {
  role: string
  content: string
}

export type PromptHistoryItem = {
  role: 'user' | 'assistant'
  content: string
}

type BuildWelcomePromptParams = {
  memories: string[]
  recentConversation: PromptMessage[]
}

type BuildInstructionsParams = {
  memories: string[]
  recentConversation: PromptMessage[]
  history: PromptHistoryItem[]
  input: ChatUserMessageInput
}

function appendSection(parts: string[], title: string, body: string) {
  if (!body) return
  parts.push(`# ${title}\n${body}`)
}

function formatConversation(items: PromptMessage[]): string {
  return items.map((item) => `${item.role}: ${item.content}`).join('\n')
}

function formatMemoryBullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n')
}

export function buildWelcomePrompt(params: BuildWelcomePromptParams): string {
  const sections: string[] = [
    'You are a friendly AI assistant. Generate a brief, warm welcome message for the user.',
  ]

  appendSection(sections, 'User memories', formatMemoryBullets(params.memories))
  appendSection(sections, 'Recent conversation', formatConversation(params.recentConversation))
  sections.push('Welcome message:')
  return sections.join('\n\n')
}

export function buildInstructions(params: BuildInstructionsParams): string {
  const currentConversation = [...params.history]
  const lastItem = currentConversation[currentConversation.length - 1]
  if (!lastItem || lastItem.role !== 'user' || lastItem.content !== params.input.message) {
    currentConversation.push({ role: 'user', content: params.input.message })
  }

  const sections: string[] = []
  appendSection(sections, 'User Memories', params.memories.join('\n'))
  appendSection(sections, 'Previous Conversation', formatConversation(params.recentConversation))
  appendSection(sections, 'Current Conversation', formatConversation(currentConversation))
  return sections.join('\n\n')
}

export type StoredMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface ConversationRepository {
  loadSession(sessionId: number, userId: string): Promise<Session | null>
  createSession(userId: string): Promise<Session>
  findLatestSessionId(userId: string): Promise<number | null>
  listSessionMessages(sessionId: number, limit: number): Promise<StoredMessage[]>
}

export interface UserMemoryStore {
  list(userId: string): Promise<string[]>
  enqueueExtraction(userId: string): Promise<void>
}
