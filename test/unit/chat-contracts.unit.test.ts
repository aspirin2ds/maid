import { describe, expect, test } from 'bun:test'

import { ChatUserMessageInputSchema } from '../../src/maid/core'

describe('ChatUserMessageInputSchema', () => {
  test('trims message content', () => {
    const parsed = ChatUserMessageInputSchema.parse({ message: '  hello  ' })
    expect(parsed.message).toBe('hello')
  })

  test('rejects blank content', () => {
    const parsed = ChatUserMessageInputSchema.safeParse({ message: '   ' })
    expect(parsed.success).toBe(false)
  })
})
