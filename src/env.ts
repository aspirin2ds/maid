import 'dotenv/config'

function getRequired(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function getOptional(name: string): string | undefined {
  const value = process.env[name]
  if (!value) return undefined
  return value
}

function getNumber(name: string, fallback: number): number {
  const value = getOptional(name)
  if (!value) return fallback

  const parsed = Number(value)
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be a valid number`)
  }

  return parsed
}

export const env = {
  // required
  get DATABASE_URL() { return getRequired('DATABASE_URL') },
  get REDIS_URL() { return getRequired('REDIS_URL') },

  get BETTER_AUTH_URL() { return getRequired('BETTER_AUTH_URL') },
  get AUTH_ORIGIN() { return getRequired('AUTH_ORIGIN') },

  get PORT() { return getNumber('PORT', 3000) },

  get OPENAI_API_KEY() { return getRequired('OPENAI_API_KEY') },
  get OPENAI_RESPONSE_MODEL() { return getRequired('OPENAI_RESPONSE_MODEL') },

  get OLLAMA_BASE_URL() { return getRequired('OLLAMA_BASE_URL') },
  get OLLAMA_GENERATE_MODEL() { return getRequired('OLLAMA_GENERATE_MODEL') },
  get OLLAMA_EMBEDDING_MODEL() { return getRequired('OLLAMA_EMBEDDING_MODEL') },

  // not required
  get OLLAMA_KEEP_ALIVE() { return process.env.OLLAMA_KEEP_ALIVE ?? '-1m' },
  get APP_SHUTDOWN_TIMEOUT_MS() { return getNumber('APP_SHUTDOWN_TIMEOUT_MS', 10_000) },

  get LOGGER_FILE() { return process.env.LOGGER_FILE ?? 'logs/current.log' },
  get LOGGER_FILE_SIZE() { return process.env.LOGGER_FILE_SIZE ?? '10m' },

  get MEMORY_QUEUE_NAME() { return process.env.MEMORY_QUEUE_NAME ?? 'memory-extraction' },
  get MEMORY_QUEUE_JOB_NAME() { return process.env.MEMORY_QUEUE_JOB_NAME ?? 'memory.extract' },
  get MEMORY_QUEUE_DEBOUNCE_DELAY_MS() { return getNumber('MEMORY_QUEUE_DEBOUNCE_DELAY_MS', 3_000) },
  get MEMORY_QUEUE_ATTEMPTS() { return getNumber('MEMORY_QUEUE_ATTEMPTS', 3) },
  get MEMORY_QUEUE_BACKOFF_DELAY_MS() { return getNumber('MEMORY_QUEUE_BACKOFF_DELAY_MS', 1_000) },
  get MEMORY_QUEUE_WORKER_CONCURRENCY() { return getNumber('MEMORY_QUEUE_WORKER_CONCURRENCY', 1) },

  get MEMORY_SERVICE_DEFAULT_LIMIT() { return getNumber('MEMORY_SERVICE_DEFAULT_LIMIT', 5) },
  get MEMORY_SERVICE_DEFAULT_THRESHOLD() { return getNumber('MEMORY_SERVICE_DEFAULT_THRESHOLD', 0.7) },

  get MEMORY_EXTRACTION_THRESHOLD() { return getNumber('MEMORY_EXTRACTION_THRESHOLD', 0.7) },
  get MEMORY_EXTRACTION_TOP_K() { return getNumber('MEMORY_EXTRACTION_TOP_K', 5) },
  get MEMORY_EXTRACTION_RETRIES() { return getNumber('MEMORY_EXTRACTION_RETRIES', 3) },

  get MIGRATIONS_TIMEOUT_MS() { return getNumber('MIGRATIONS_TIMEOUT_MS', 30_000) },
  get MIGRATIONS_RETRY_DELAY_MS() { return getNumber('MIGRATIONS_RETRY_DELAY_MS', 500) },
  get MIGRATIONS_FOLDER() { return process.env.MIGRATIONS_FOLDER ?? './drizzle' },
}
