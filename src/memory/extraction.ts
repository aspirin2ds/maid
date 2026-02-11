import { and, cosineDistance, eq, inArray, isNull, lte } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import type * as schema from '../db/schema'
import { memories, messages, sessions, toSqlVector } from '../db/schema'
import { embed, structuredResponse } from '../llm'
import { logger } from '../logger'
import {
  FactRetrievalSchema,
  MemoryUpdateSchema,
  getFactRetrievalPrompt,
  getUpdateMemoryPrompt,
  type MemoryAction,
} from './prompts'

const SIMILARITY_THRESHOLD = 0.7
const SIMILAR_TOP_K = 5
const MAX_RETRIES = 3

type Db = PostgresJsDatabase<typeof schema>

export interface ExtractionResult {
  factsExtracted: number
  memoriesAdded: number
  memoriesUpdated: number
  memoriesDeleted: number
  memoriesUnchanged: number
}

// --- Stage 1: Fetch unextracted messages ---

async function fetchUnextractedMessages(db: Db, userId: string): Promise<{ ids: number[]; text: string }> {
  const rows = await db
    .select({ id: messages.id, role: messages.role, content: messages.content })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(and(eq(sessions.userId, userId), isNull(messages.extractedAt)))
    .orderBy(messages.createdAt)

  if (rows.length === 0) return { ids: [], text: '' }

  const text = rows.map((r) => `${r.role}: ${r.content}`).join('\n')
  return { ids: rows.map((r) => r.id), text }
}

// --- Stage 2: Extract facts ---

async function extractFacts(conversationText: string): Promise<string[]> {
  const prompt = getFactRetrievalPrompt(conversationText)
  const result = await structuredResponse(prompt, FactRetrievalSchema)
  return result.facts || []
}

// --- Stage 3: Embed facts ---

async function embedFacts(facts: string[]): Promise<Map<string, number[]>> {
  const embeddings = await embed(facts)
  const embedMap = new Map<string, number[]>()
  facts.forEach((fact, i) => embedMap.set(fact, embeddings[i]))
  return embedMap
}

// --- Stage 4: Find similar existing memories ---

async function findSimilarMemories(
  db: Db,
  userId: string,
  facts: string[],
  embedMap: Map<string, number[]>,
): Promise<Map<string, { id: number; text: string }>> {
  const existingById = new Map<string, { id: number; text: string }>()

  for (const fact of facts) {
    const vec = embedMap.get(fact)!
    const maxDist = 1 - SIMILARITY_THRESHOLD
    const distance = cosineDistance(memories.embedding, vec)
    const rows = await db
      .select({ id: memories.id, content: memories.content })
      .from(memories)
      .where(and(eq(memories.userId, userId), lte(distance, maxDist)))
      .orderBy(distance)
      .limit(SIMILAR_TOP_K)

    for (const row of rows) {
      existingById.set(String(row.id), { id: row.id, text: row.content })
    }
  }

  return existingById
}

// --- Stage 5: Generate memory actions with retry + repair ---

async function generateMemoryActions(
  mapped: { id: string; text: string }[],
  facts: string[],
  tempToReal: Map<string, number>,
): Promise<MemoryAction[]> {
  async function callLLM(attempt: number): Promise<MemoryAction[]> {
    const start = Date.now()
    const prompt = getUpdateMemoryPrompt(mapped, facts)
    const result = await structuredResponse(prompt, MemoryUpdateSchema)
    logger.info({
      fn: 'generateMemoryActions',
      attempt,
      durationMs: Date.now() - start,
      actionCount: result.memory.length,
    }, 'memory.actions.generated')
    return result.memory
  }

  let actions = repairMemoryActions(await callLLM(1), tempToReal)

  for (let attempt = 1; attempt < MAX_RETRIES; attempt++) {
    const invalid = actions.filter(
      (a) => a.event !== 'ADD' && a.event !== 'NONE' && !tempToReal.has(a.id),
    )
    if (invalid.length === 0) break

    logger.warn({
      attempt,
      invalidIds: invalid.map((a) => a.id),
    }, 'memory.actions.invalid_ids')
    actions = repairMemoryActions(await callLLM(attempt + 1), tempToReal)
  }

  return actions
}

// --- Stage 6: Apply actions in transaction ---

async function applyMemoryActions(
  db: Db,
  userId: string,
  actions: MemoryAction[],
  tempToReal: Map<string, number>,
  embedMap: Map<string, number[]>,
): Promise<Pick<ExtractionResult, 'memoriesAdded' | 'memoriesUpdated' | 'memoriesDeleted' | 'memoriesUnchanged'>> {
  const stats = { memoriesAdded: 0, memoriesUpdated: 0, memoriesDeleted: 0, memoriesUnchanged: 0 }

  await db.transaction(async (tx) => {
    for (const action of actions) {
      if (action.event === 'NONE') {
        stats.memoriesUnchanged++
        continue
      }

      const realId = tempToReal.get(action.id)
      if (action.event !== 'ADD' && realId == null) {
        logger.error({ event: action.event, actionId: action.id }, 'memory.action.invalid_id')
        continue
      }

      if (action.event === 'ADD' || action.event === 'UPDATE') {
        let embedding = embedMap.get(action.text)
        if (!embedding) {
          const [vec] = await embed(action.text)
          embedding = vec
        }
        const vecSql = toSqlVector(embedding)

        if (action.event === 'ADD') {
          await tx.insert(memories).values({
            userId,
            content: action.text,
            embedding: vecSql,
          })
          stats.memoriesAdded++
        } else {
          await tx
            .update(memories)
            .set({ content: action.text, embedding: vecSql, updatedAt: new Date() })
            .where(eq(memories.id, realId!))
          stats.memoriesUpdated++
        }
      } else {
        await tx.delete(memories).where(eq(memories.id, realId!))
        stats.memoriesDeleted++
      }
    }
  })

  return stats
}

// --- Stage 7: Mark messages as extracted ---

async function markExtracted(db: Db, messageIds: number[]) {
  if (messageIds.length === 0) return
  await db
    .update(messages)
    .set({ extractedAt: new Date() })
    .where(inArray(messages.id, messageIds))
}

// --- Repair utilities ---

function repairMemoryActions(
  actions: MemoryAction[],
  tempToReal: Map<string, number>,
): MemoryAction[] {
  const invalid = actions.filter(
    (a) => (a.event === 'UPDATE' || a.event === 'DELETE') && !tempToReal.has(a.id),
  )
  if (invalid.length === 0) return actions

  const noneByText = new Map<string, MemoryAction>()
  for (const a of actions) {
    if (a.event === 'NONE' && tempToReal.has(a.id)) {
      noneByText.set(a.text, a)
    }
  }

  const repairedIds = new Set<string>()

  for (const inv of invalid) {
    if (!inv.old_memory) continue
    const match = noneByText.get(inv.old_memory)
    if (!match) continue

    match.event = inv.event
    match.old_memory = inv.old_memory
    if (inv.event === 'UPDATE') {
      match.text = inv.text
    }
    repairedIds.add(inv.id)
    noneByText.delete(inv.old_memory)
  }

  return actions.filter((a) => !repairedIds.has(a.id))
}

// --- Main orchestrator ---

export async function extractMemory(db: Db, userId: string): Promise<ExtractionResult> {
  const start = Date.now()
  const stats: ExtractionResult = {
    factsExtracted: 0,
    memoriesAdded: 0,
    memoriesUpdated: 0,
    memoriesDeleted: 0,
    memoriesUnchanged: 0,
  }

  try {
    // Stage 1: Fetch unextracted messages
    const { ids: messageIds, text: conversationText } = await fetchUnextractedMessages(db, userId)
    if (messageIds.length === 0) {
      logger.info({ userId, durationMs: Date.now() - start }, 'memory.extraction.no_messages')
      return stats
    }

    logger.info({ userId, messageCount: messageIds.length }, 'memory.extraction.started')

    // Stage 2: Extract facts
    const facts = await extractFacts(conversationText)
    stats.factsExtracted = facts.length
    if (facts.length === 0) {
      await markExtracted(db, messageIds)
      logger.info({ userId, durationMs: Date.now() - start }, 'memory.extraction.no_facts')
      return stats
    }

    // Stage 3: Embed facts
    const embedMap = await embedFacts(facts)

    // Stage 4: Find similar existing memories
    const existingById = await findSimilarMemories(db, userId, facts, embedMap)

    // Map temp IDs for LLM
    const tempToReal = new Map<string, number>()
    const mapped = [...existingById.entries()].map(([_key, mem], idx) => {
      const tempId = String(idx)
      tempToReal.set(tempId, mem.id)
      return { id: tempId, text: mem.text }
    })

    // Stage 5: Generate memory actions
    const actions = await generateMemoryActions(mapped, facts, tempToReal)

    // Stage 6: Apply actions
    const actionStats = await applyMemoryActions(db, userId, actions, tempToReal, embedMap)
    Object.assign(stats, actionStats)

    // Stage 7: Mark messages as extracted
    await markExtracted(db, messageIds)

    logger.info({
      userId,
      durationMs: Date.now() - start,
      ...stats,
    }, 'memory.extraction.completed')

    return stats
  } catch (err) {
    logger.error({
      err,
      userId,
      durationMs: Date.now() - start,
    }, 'memory.extraction.failed')
    throw err
  }
}
