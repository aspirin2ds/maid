function getRequired(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

export const env = {
  DATABASE_URL: getRequired('DATABASE_URL'),
  REDIS_URL: getRequired("REDIS_URL"),
  PORT: Number(process.env.PORT ?? 3000),
}
