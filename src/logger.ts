import pino from 'pino'
import { env } from './env'

const transport = pino.transport({
  target: 'pino-roll',
  options: {
    file: env.LOGGER_FILE,
    size: env.LOGGER_FILE_SIZE,
    mkdir: true,
  },
})

export const logger = pino(transport)
