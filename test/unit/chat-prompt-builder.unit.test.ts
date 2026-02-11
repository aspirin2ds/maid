import { describe, expect, test } from 'bun:test'

import { buildInstructions, buildWelcomePrompt } from '../../src/maid/core'

describe('chat prompt builder', () => {
  test('buildWelcomePrompt includes memories and recent conversation', () => {
    const prompt = buildWelcomePrompt({
      memories: ['prefers tea'],
      recentConversation: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
    })

    expect(prompt).toContain('# User memories')
    expect(prompt).toContain('- prefers tea')
    expect(prompt).toContain('# Recent conversation')
    expect(prompt).toContain('assistant: hi there')
  })

  test('buildInstructions avoids duplicating latest user input', () => {
    const prompt = buildInstructions({
      memories: [],
      recentConversation: [],
      history: [{ role: 'user', content: 'hello' }],
      input: { message: 'hello' },
    })

    const occurrences = prompt.split('user: hello').length - 1
    expect(occurrences).toBe(1)
  })
})
