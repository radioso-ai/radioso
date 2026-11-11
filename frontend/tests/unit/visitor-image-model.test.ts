import { describe, expect, it } from 'vitest'

import type { KnownModelsByProvider } from '@/lib/api-llm-providers'
import { agentImageReading, modelReadsImages } from '@/lib/visitor-image-model'

const known: KnownModelsByProvider = {
  openai: ['gpt-5.4-mini', 'gpt-5.4'],
  'openai-compatible': [],
  gemini: ['gemini-2.5-flash'],
  claude: ['claude-sonnet-4-5'],
}

describe('which chat models read images', () => {
  it('reads with every catalog model', () => {
    expect(modelReadsImages({ provider: 'openai', model: 'gpt-5.4-mini' }, known)).toBe(true)
    expect(modelReadsImages({ provider: 'claude', model: 'claude-sonnet-4-5' }, known)).toBe(true)
    expect(modelReadsImages({ provider: 'gemini', model: 'gemini-2.5-flash' }, known)).toBe(true)
  })

  it('cannot tell for an openai-compatible endpoint, which serves whatever model it names', () => {
    expect(modelReadsImages({ provider: 'openai-compatible', model: 'gpt-5.4-mini' }, known)).toBe(false)
  })

  it('does not trust a model outside the catalog', () => {
    expect(modelReadsImages({ provider: 'openai', model: 'some-fine-tune' }, known)).toBe(false)
  })
})

describe('the model an agent answers with', () => {
  const models = (over: Partial<Parameters<typeof agentImageReading>[0]['models'] & object> = {}) => ({
    chat: null,
    managed: { chat: null, rewrite: null, rerank: null },
    knownModelsByProvider: known,
    ...over,
  })

  it("uses the agent's own model first", () => {
    const reading = agentImageReading({
      override: { provider: 'openai-compatible', model: 'llava' },
      models: models({ chat: { provider: 'openai', model: 'gpt-5.4-mini' } }),
    })
    expect(reading).toBe('cannot_read')
  })

  it("falls back to the plan's model, then the workspace's chat preference", () => {
    expect(agentImageReading({
      override: null,
      models: models({
        chat: { provider: 'openai-compatible', model: 'llava' },
        managed: { chat: { provider: 'claude', model: 'claude-sonnet-4-5' }, rewrite: null, rerank: null },
      }),
    })).toBe('reads')

    expect(agentImageReading({
      override: undefined,
      models: models({ chat: { provider: 'openai-compatible', model: 'llava' } }),
    })).toBe('cannot_read')
  })

  it('does not say when the deployment default decides, or before the models are known', () => {
    expect(agentImageReading({ override: null, models: models() })).toBe('unknown')
    expect(agentImageReading({ override: null, models: null })).toBe('unknown')
  })
})
