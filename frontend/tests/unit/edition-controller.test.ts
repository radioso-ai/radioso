import { afterEach, describe, expect, it, vi } from 'vitest'

const loadController = async (edition?: string) => {
  vi.resetModules()
  const previousEdition = process.env.NEXT_PUBLIC_RADIOSO_EDITION
  if (edition === undefined) {
    delete process.env.NEXT_PUBLIC_RADIOSO_EDITION
  } else {
    process.env.NEXT_PUBLIC_RADIOSO_EDITION = edition
  }

  const controllerModule = await import('@/lib/edition-controller')
  if (previousEdition === undefined) {
    delete process.env.NEXT_PUBLIC_RADIOSO_EDITION
  } else {
    process.env.NEXT_PUBLIC_RADIOSO_EDITION = previousEdition
  }
  return controllerModule.editionController
}

describe('editionController', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('hides human contact surfaces in the OSS edition', async () => {
    const controller = await loadController()

    expect(controller.canUseHumanContact()).toBe(false)
    expect(controller.canUseAssistantAnswerFeedback()).toBe(true)
    expect(controller.canUseAgentCreationExtensions()).toBe(false)
    expect(controller.shouldLoadHumanContactSettings('assistant')).toBe(false)
    expect(controller.shouldRenderWebsiteEmbedSettings('channels')).toBe(true)
    expect(controller.shouldRenderWebsiteEmbedSettings('assistant')).toBe(false)
    expect(controller.getActivityFilterOptions().map((option) => option.value)).toEqual(['all', 'chat', 'search'])
    expect(controller.normalizeHistoryFilter('contact')).toBe('all')
    expect(controller.normalizeHistorySelection({ kind: 'contact', id: 'contact-1' })).toBeNull()
  })

  it('enables human contact surfaces in the enterprise edition', async () => {
    const controller = await loadController('enterprise')

    expect(controller.canUseHumanContact()).toBe(true)
    expect(controller.canUseAssistantAnswerFeedback()).toBe(true)
    expect(controller.canUseAgentCreationExtensions()).toBe(true)
    expect(controller.shouldLoadHumanContactSettings('assistant')).toBe(true)
    expect(controller.shouldLoadHumanContactSettings('channels')).toBe(false)
    expect(controller.shouldRenderWebsiteEmbedSettings('channels')).toBe(true)
    expect(controller.getActivityFilterOptions().map((option) => option.value)).toEqual(['all', 'chat', 'search', 'contact'])
    expect(controller.normalizeHistoryFilter('contact')).toBe('contact')
    expect(controller.normalizeHistorySelection({ kind: 'contact', id: 'contact-1' })).toEqual({ kind: 'contact', id: 'contact-1' })
  })
})
