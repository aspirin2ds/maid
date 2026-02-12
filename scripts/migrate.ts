import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { env } from '../src/env'

type RunMigrationsOptions = {
  migrationsFolder?: string
  timeoutMs?: number
  retryDelayMs?: number
}

export async function runMigrations(databaseUrl: string, options: RunMigrationsOptions = {}) {
  const timeoutMs = options.timeoutMs ?? env.MIGRATIONS_TIMEOUT_MS
  const retryDelayMs = options.retryDelayMs ?? env.MIGRATIONS_RETRY_DELAY_MS
  const migrationsFolder = options.migrationsFolder ?? env.MIGRATIONS_FOLDER
  const startedAt = Date.now()
  let lastError: unknown = null

  while (Date.now() - startedAt < timeoutMs) {
    const client = new Pool({ connectionString: databaseUrl })

    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector')
      const migrationDb = drizzle(client)
      await migrate(migrationDb, { migrationsFolder })
      await client.end()
      return
    } catch (error) {
      lastError = error
      await client.end()
      await Bun.sleep(retryDelayMs)
    }
  }

  throw new Error(`Failed to run migrations within ${timeoutMs}ms: ${String(lastError)}`)
}

if (import.meta.main) {
  await runMigrations(env.DATABASE_URL)
}
