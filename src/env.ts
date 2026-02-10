function getRequired(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

export const env = {
  DATABASE_URL: getRequired('DATABASE_URL'),
  REDIS_URL: getRequired('REDIS_URL'),
  BETTER_AUTH_URL: getRequired('BETTER_AUTH_URL'),
  AUTH_ORIGIN: getRequired('AUTH_ORIGIN'),
  PORT: Number(process.env.PORT ?? 3000),
}
