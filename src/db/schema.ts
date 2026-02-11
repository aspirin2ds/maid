import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

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
  (table) => [index('sessions_created_at_idx').on(table.createdAt)],
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('messages_session_id_idx').on(table.sessionId),
    index('messages_created_at_idx').on(table.createdAt),
  ],
)

export const memories = pgTable(
  'memories',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => sessions.userId, { onDelete: 'cascade' })
      .notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('memories_user_id_idx').on(table.userId),
    index('memories_created_at_idx').on(table.createdAt),
  ],
)
