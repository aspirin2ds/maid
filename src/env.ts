function getRequired(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

export const env = {
  get DATABASE_URL() { return getRequired('DATABASE_URL') },
  get REDIS_URL() { return getRequired('REDIS_URL') },
  get BETTER_AUTH_URL() { return getRequired('BETTER_AUTH_URL') },
  get AUTH_ORIGIN() { return getRequired('AUTH_ORIGIN') },
  get PORT() { return Number(process.env.PORT ?? 3000) },
  get OPENAI_API_KEY() { return getRequired('OPENAI_API_KEY') },
  get OLLAMA_BASE_URL() { return getRequired('OLLAMA_BASE_URL') },
  get OPENAI_RESPONSE_MODEL() { return getRequired('OPENAI_RESPONSE_MODEL') },
  get OLLAMA_GENERATE_MODEL() { return getRequired('OLLAMA_GENERATE_MODEL') },
  get OLLAMA_EMBEDDING_MODEL() { return getRequired('OLLAMA_EMBEDDING_MODEL') },
}
