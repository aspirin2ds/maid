import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl)
  const db = drizzle(client, { schema })

  return {
    db,
    close: () => client.end({ timeout: 5 }),
  }
}
