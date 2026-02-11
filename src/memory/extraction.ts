import { and, cosineDistance, eq, inArray, isNull, lte } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import type * as schema from '../db/schema'
import { memories, messages, sessions, toSqlVector } from '../db/schema'
import { embed, textGenerate } from '../llm'
import { logger } from '../logger'
import {
  FactRetrievalSchema,
  MemoryUpdateSchema,
  getFactRetrievalPrompt,
  getUpdateMemoryPrompt,
  type MemoryAction,
} from './prompts'

const THRESHOLD = 0.7
const TOP_K = 5
const RETRIES = 3

type Db = PostgresJsDatabase<typeof schema>

type ExistingMem = { id: string; text: string }
type IdMap = Map<string, number>

export interface ExtractionResult {
  factsExtracted: number
  memoriesAdded: number
  memoriesUpdated: number
  memoriesDeleted: number
  memoriesUnchanged: number
}

async function loadPendingMessages(db: Db, userId: string): Promise<{ ids: number[]; text: string }> {
  const rows = await db
    .select({ id: messages.id, role: messages.role, content: messages.content })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(and(eq(sessions.userId, userId), isNull(messages.extractedAt)))
    .orderBy(messages.createdAt)

  if (rows.length === 0) return { ids: [], text: '' }

  return {
    ids: rows.map((r) => r.id),
    text: rows.map((r) => `${r.role}: ${r.content}`).join('\n'),
  }
}

async function extractFacts(messageText: string): Promise<string[]> {
  const prompt = getFactRetrievalPrompt(messageText)
  const raw = await textGenerate(prompt)
  const facts = parseFactList(raw)
  return FactRetrievalSchema.parse({ facts }).facts || []
}

async function embedFacts(facts: string[]): Promise<Map<string, number[]>> {
  const embeddings = await embed(facts)
  return new Map(facts.map((fact, index) => [fact, embeddings[index]]))
}

async function findNearbyMemories(
  db: Db,
  userId: string,
  facts: string[],
  embeddingsByFact: Map<string, number[]>,
): Promise<Map<string, { id: number; text: string }>> {
  const nearby = new Map<string, { id: number; text: string }>()

  for (const fact of facts) {
    const embedding = embeddingsByFact.get(fact)!
    const maxDist = 1 - THRESHOLD
    const distance = cosineDistance(memories.embedding, embedding)

    const rows = await db
      .select({ id: memories.id, content: memories.content })
      .from(memories)
      .where(and(eq(memories.userId, userId), lte(distance, maxDist)))
      .orderBy(distance)
      .limit(TOP_K)

    for (const row of rows) {
      nearby.set(String(row.id), { id: row.id, text: row.content })
    }
  }

  return nearby
}

async function generateActions(existing: ExistingMem[], facts: string[], idMap: IdMap): Promise<MemoryAction[]> {
  const run = async (attempt: number): Promise<MemoryAction[]> => {
    const start = Date.now()
    const prompt = getUpdateMemoryPrompt(existing, facts)
    const raw = await textGenerate(prompt)
    const actions = MemoryUpdateSchema.parse({ memory: parseMemoryActions(raw) }).memory

    logger.info({
      fn: 'generateActions',
      attempt,
      durationMs: Date.now() - start,
      actionCount: actions.length,
    }, 'memory.actions.generated')

    return actions
  }

  let actions = repairInvalidActions(await run(1), idMap)

  for (let attempt = 1; attempt < RETRIES; attempt++) {
    const invalid = actions.filter((action) => action.event !== 'ADD' && action.event !== 'NONE' && !idMap.has(action.id))
    if (invalid.length === 0) break

    logger.warn({ attempt, invalidIds: invalid.map((action) => action.id) }, 'memory.actions.invalid_ids')
    actions = repairInvalidActions(await run(attempt + 1), idMap)
  }

  return backfillMissingFactAdds(actions, existing, facts)
}

async function applyActions(
  db: Db,
  userId: string,
  actions: MemoryAction[],
  idMap: IdMap,
  embeddingsByFact: Map<string, number[]>,
): Promise<Pick<ExtractionResult, 'memoriesAdded' | 'memoriesUpdated' | 'memoriesDeleted' | 'memoriesUnchanged'>> {
  const stats = { memoriesAdded: 0, memoriesUpdated: 0, memoriesDeleted: 0, memoriesUnchanged: 0 }

  await db.transaction(async (tx) => {
    for (const action of actions) {
      if (action.event === 'NONE') {
        stats.memoriesUnchanged++
        continue
      }

      const realId = idMap.get(action.id)
      if (action.event !== 'ADD' && realId == null) {
        logger.error({ event: action.event, actionId: action.id }, 'memory.action.invalid_id')
        continue
      }

      if (action.event === 'DELETE') {
        await tx.delete(memories).where(eq(memories.id, realId!))
        stats.memoriesDeleted++
        continue
      }

      let embedding = embeddingsByFact.get(action.text)
      if (!embedding) {
        const [newEmbedding] = await embed(action.text)
        embedding = newEmbedding
      }
      const embeddingSql = toSqlVector(embedding)

      if (action.event === 'ADD') {
        await tx.insert(memories).values({
          userId,
          content: action.text,
          embedding: embeddingSql,
        })
        stats.memoriesAdded++
      } else {
        await tx
          .update(memories)
          .set({ content: action.text, embedding: embeddingSql, updatedAt: new Date() })
          .where(eq(memories.id, realId!))
        stats.memoriesUpdated++
      }
    }
  })

  return stats
}

async function markMessagesExtracted(db: Db, ids: number[]) {
  if (ids.length === 0) return

  await db
    .update(messages)
    .set({ extractedAt: new Date() })
    .where(inArray(messages.id, ids))
}

function repairInvalidActions(actions: MemoryAction[], idMap: IdMap): MemoryAction[] {
  const invalidActions = actions.filter((action) => (action.event === 'UPDATE' || action.event === 'DELETE') && !idMap.has(action.id))
  if (invalidActions.length === 0) return actions

  const noneActionsByText = new Map<string, MemoryAction>()
  for (const action of actions) {
    if (action.event === 'NONE' && idMap.has(action.id)) noneActionsByText.set(action.text, action)
  }

  const droppedIds = new Set<string>()

  for (const action of invalidActions) {
    if (!action.old_memory) continue
    const match = noneActionsByText.get(action.old_memory)
    if (!match) continue

    match.event = action.event
    match.old_memory = action.old_memory
    if (action.event === 'UPDATE') match.text = action.text

    droppedIds.add(action.id)
    noneActionsByText.delete(action.old_memory)
  }

  return actions.filter((action) => !droppedIds.has(action.id))
}

function parseFactList(raw: string): string[] {
  const asJson = parseFactsFromJson(raw)
  if (asJson) return asJson

  const rows = normalizeLines(raw)
  if (rows.length === 0) return []
  if (rows.length === 1 && rows[0].toUpperCase() === 'NONE') return []

  const facts = rows
    .map((row) => row.replace(/^FACT:\s*/i, '').trim())
    .filter((x) => x.length > 0 && x.toUpperCase() !== 'NONE')

  return [...new Set(facts)]
}

function parseMemoryActions(raw: string): MemoryAction[] {
  const asJson = parseActionsFromJson(raw)
  if (asJson) return asJson

  return normalizeLines(raw)
    .map((row) => {
      const parts = row.split('|').map((p) => p.trim())
      if (parts.length < 3) return null

      const [event, id, text, oldMemory = ''] = parts
      const e = event.toUpperCase()
      if (!['ADD', 'UPDATE', 'DELETE', 'NONE'].includes(e)) return null
      if (!id) return null

      const action: MemoryAction = {
        event: e as MemoryAction['event'],
        id,
        text,
      }

      if (oldMemory) action.old_memory = oldMemory
      return action
    })
    .filter((a): a is MemoryAction => a !== null)
}

function normalizeLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== '```')
    .filter((line) => !line.startsWith('```'))
}

function backfillMissingFactAdds(actions: MemoryAction[], existing: ExistingMem[], facts: string[]): MemoryAction[] {
  const memoriesById = new Map(existing.map((memory) => [memory.id, memory.text]))
  const addedTexts: string[] = []

  for (const action of actions) {
    if (action.event === 'ADD') {
      addedTexts.push(action.text)
      continue
    }

    if (action.event === 'DELETE') {
      memoriesById.delete(action.id)
      continue
    }

    memoriesById.set(action.id, action.text)
  }

  const finalTexts = [...memoriesById.values(), ...addedTexts]
  const missingFacts = facts.filter((fact) => !hasTextMatch(fact, finalTexts))
  if (missingFacts.length === 0) return actions

  const maxId = actions
    .map((action) => Number.parseInt(action.id, 10))
    .filter((id) => Number.isFinite(id))
    .reduce((max, id) => Math.max(max, id), -1)

  let nextId = maxId + 1
  const autoAddedActions = missingFacts.map((fact) => ({ id: String(nextId++), text: fact, event: 'ADD' as const }))
  return [...actions, ...autoAddedActions]
}

function hasTextMatch(fact: string, values: string[]): boolean {
  const normalizedFact = normalizeText(fact)
  return values.some((text) => {
    const normalizedText = normalizeText(text)
    return normalizedText.includes(normalizedFact) || normalizedFact.includes(normalizedText)
  })
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseFactsFromJson(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(extractJson(raw)) as { facts?: unknown }
    if (!parsed || !Array.isArray(parsed.facts)) return null
    return parsed.facts.filter((f): f is string => typeof f === 'string')
  } catch {
    return null
  }
}

function parseActionsFromJson(raw: string): MemoryAction[] | null {
  try {
    const parsed = JSON.parse(extractJson(raw)) as { memory?: unknown }
    if (!parsed || !Array.isArray(parsed.memory)) return null
    return parsed.memory as MemoryAction[]
  } catch {
    return null
  }
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()

  const braces = raw.match(/[\[{][\s\S]*[\]}]/)
  if (braces) return braces[0]

  return raw.trim()
}

export async function extractMemory(db: Db, userId: string): Promise<ExtractionResult> {
  const start = Date.now()
  const out: ExtractionResult = {
    factsExtracted: 0,
    memoriesAdded: 0,
    memoriesUpdated: 0,
    memoriesDeleted: 0,
    memoriesUnchanged: 0,
  }

  try {
    const { ids, text } = await loadPendingMessages(db, userId)
    if (ids.length === 0) {
      logger.info({ userId, durationMs: Date.now() - start }, 'memory.extraction.no_messages')
      return out
    }

    logger.info({ userId, messageCount: ids.length }, 'memory.extraction.started')

    const facts = await extractFacts(text)
    out.factsExtracted = facts.length

    if (facts.length === 0) {
      await markMessagesExtracted(db, ids)
      logger.info({ userId, durationMs: Date.now() - start }, 'memory.extraction.no_facts')
      return out
    }

    const embeddingsByFact = await embedFacts(facts)
    const nearbyMemories = await findNearbyMemories(db, userId, facts, embeddingsByFact)

    const idMap: IdMap = new Map()
    const existing: ExistingMem[] = [...nearbyMemories.values()].map((memory, i) => {
      const id = String(i)
      idMap.set(id, memory.id)
      return { id, text: memory.text }
    })

    const actions = await generateActions(existing, facts, idMap)
    Object.assign(out, await applyActions(db, userId, actions, idMap, embeddingsByFact))

    await markMessagesExtracted(db, ids)

    logger.info({ userId, durationMs: Date.now() - start, ...out }, 'memory.extraction.completed')
    return out
  } catch (err) {
    logger.error({ err, userId, durationMs: Date.now() - start }, 'memory.extraction.failed')
    throw err
  }
}
