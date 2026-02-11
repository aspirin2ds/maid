import OpenAI from 'openai'
import { Ollama } from 'ollama'
import { type output, toJSONSchema, type ZodType } from 'zod'
import { env } from './env'
import { logger } from './logger'

export const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
})

export const ollama = new Ollama({
  host: env.OLLAMA_BASE_URL,
})

export function streamResponse(
  input: string,
  instructions?: string,
) {
  const start = Date.now()
  return openai.responses.stream({
    model: env.OPENAI_RESPONSE_MODEL,
    input,
    instructions,
  }).on('response.completed', (event) => {
    const { usage } = event.response
    logger.info({
      fn: 'streamResponse',
      model: env.OPENAI_RESPONSE_MODEL,
      durationMs: Date.now() - start,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
    }, 'llm.completed')
  }).on('error', (error) => {
    logger.error({
      fn: 'streamResponse',
      model: env.OPENAI_RESPONSE_MODEL,
      durationMs: Date.now() - start,
      error: error.message,
    }, 'llm.failed')
  })
}

export async function structuredResponse<T extends ZodType>(
  prompt: string,
  schema: T,
): Promise<output<T>> {
  const start = Date.now()
  try {
    const response = await ollama.generate({
      model: env.OLLAMA_GENERATE_MODEL,
      prompt,
      format: toJSONSchema(schema),
      keep_alive: "-1m"
    })
    logger.info({
      fn: 'structuredResponse',
      model: env.OLLAMA_GENERATE_MODEL,
      durationMs: Date.now() - start,
      inputTokens: response.prompt_eval_count,
      outputTokens: response.eval_count,
    }, 'llm.completed')
    return schema.parse(JSON.parse(extractJSON(response.response)))
  } catch (error) {
    logger.error({
      fn: 'structuredResponse',
      model: env.OLLAMA_GENERATE_MODEL,
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    }, 'llm.failed')
    throw error
  }
}

function extractJSON(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const braces = raw.match(/[\[{][\s\S]*[\]}]/)
  if (braces) return braces[0]
  return raw.trim()
}

export async function embed(input: string | string[]) {
  const start = Date.now()
  try {
    const response = await ollama.embed({
      model: env.OLLAMA_EMBEDDING_MODEL, input, keep_alive: "-1m"
    })
    logger.info({
      fn: 'getEmbeddings',
      model: env.OLLAMA_EMBEDDING_MODEL,
      durationMs: Date.now() - start,
      inputCount: input.length,
    }, 'llm.completed')
    return response.embeddings
  } catch (error) {
    logger.error({
      fn: 'embed',
      model: env.OLLAMA_EMBEDDING_MODEL,
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    }, 'llm.failed')
    throw error
  }
}
