import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  vector,
} from 'drizzle-orm/pg-core'

export function toSqlVector(embedding: number[]) {
  return sql`${`[${embedding.join(',')}]`}::vector`
}

export const messageRoleEnum = pgEnum('message_role', ['system', 'user', 'assistant', 'tool'])

export const sessions = pgTable(
  'sessions',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(),

    title: text('title'),
    metadata: jsonb('metadata').default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  () => [],
)

export const messages = pgTable(
  'messages',
  {
    id: serial('id').primaryKey(),
    sessionId: integer('session_id')
      .references(() => sessions.id, { onDelete: 'cascade' })
      .notNull(),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata').default({}),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('messages_session_id_idx').on(table.sessionId),
  ],
)

export const memories = pgTable(
  'memories',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(),
    content: text('content').notNull(),
    embedding: vector({ dimensions: 1024 }),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('memories_user_id_idx').on(table.userId),
    index('memories_embedding_cosine_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
  ],
)
