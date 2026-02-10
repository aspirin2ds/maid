import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const test = pgTable('test', {
  id: serial('id').primaryKey(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
