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

  it('uses the shared activity surface in the OSS edition', async () => {
    const controller = await loadController()

    expect(controller.canUseAssistantAnswerFeedback()).toBe(true)
    expect(controller.canUseAgentCreationExtensions()).toBe(true)
    expect(controller.shouldRenderWebsiteEmbedSettings('channels')).toBe(true)
    expect(controller.shouldRenderWebsiteEmbedSettings('assistant')).toBe(false)
    expect(controller.getActivityFilterOptions().map((option) => option.value)).toEqual(['all', 'chat', 'search'])
    expect(controller.normalizeHistoryFilter('contact')).toBe('all')
    expect(controller.normalizeHistorySelection({ kind: 'contact', id: 'contact-1' })).toBeNull()
  })

  it('uses the shared activity surface in the enterprise edition', async () => {
    const controller = await loadController('enterprise')

    expect(controller.canUseAssistantAnswerFeedback()).toBe(true)
    expect(controller.canUseAgentCreationExtensions()).toBe(true)
    expect(controller.shouldRenderWebsiteEmbedSettings('channels')).toBe(true)
    expect(controller.getActivityFilterOptions().map((option) => option.value)).toEqual(['all', 'chat', 'search'])
    expect(controller.normalizeHistoryFilter('contact')).toBe('all')
    expect(controller.normalizeHistorySelection({ kind: 'contact', id: 'contact-1' })).toBeNull()
  })
})
