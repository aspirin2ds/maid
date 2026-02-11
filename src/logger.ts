import pino from 'pino'

const transport = pino.transport({
  target: 'pino-roll',
  options: {
    file: 'logs/current.log',
    size: '10m',
    mkdir: true,
  },
})

export const logger = pino(transport)
