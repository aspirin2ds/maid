import OpenAI from 'openai'
import { Ollama } from 'ollama'
import { type output, toJSONSchema, type ZodType } from 'zod'
import { env } from './env'

export const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
})

export const ollama = new Ollama({
  host: env.OLLAMA_BASE_URL,
})

export async function streamResponse(
  input: string,
  instructions?: string,
) {
  return openai.responses.create({
    model: env.OPENAI_RESPONSE_MODEL,
    input,
    instructions,
    stream: true,
  })
}

export async function getStructuredResponse<T extends ZodType>(
  prompt: string,
  schema: T,
): Promise<output<T>> {
  const response = await ollama.generate({
    model: env.OLLAMA_GENERATE_MODEL,
    prompt,
    format: toJSONSchema(schema),
    options: { temperature: 0 },
  })
  return schema.parse(JSON.parse(extractJSON(response.response)))
}

function extractJSON(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const braces = raw.match(/[\[{][\s\S]*[\]}]/)
  if (braces) return braces[0]
  return raw.trim()
}

export async function getEmbeddings(input: string[]) {
  const response = await ollama.embed({ model: env.OLLAMA_EMBEDDING_MODEL, input })
  return response.embeddings
}
