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
    const suggestions = controller.filterChatSuggestions([
      { text: 'Read more' },
      { text: 'Talk to a human', action: { kind: 'contact_human' } },
    ])

    expect(controller.canUseHumanContact()).toBe(false)
    expect(controller.shouldLoadHumanContactSettings('channels')).toBe(false)
    expect(controller.canUseWebsiteEmbed()).toBe(false)
    expect(controller.shouldRenderWebsiteEmbedSettings('channels')).toBe(false)
    expect(controller.getActivityFilterOptions().map((option) => option.value)).toEqual(['all', 'chat', 'search'])
    expect(controller.normalizeHistoryFilter('contact')).toBe('all')
    expect(controller.normalizeHistorySelection({ kind: 'contact', id: 'contact-1' })).toBeNull()
    expect(suggestions).toEqual([{ text: 'Read more' }])
  })

  it('enables human contact surfaces in the enterprise edition', async () => {
    const controller = await loadController('enterprise')
    const contactSuggestion = { text: 'Talk to a human', action: { kind: 'contact_human' } }

    expect(controller.canUseHumanContact()).toBe(true)
    expect(controller.shouldLoadHumanContactSettings('channels')).toBe(true)
    expect(controller.canUseWebsiteEmbed()).toBe(true)
    expect(controller.shouldRenderWebsiteEmbedSettings('channels')).toBe(true)
    expect(controller.getActivityFilterOptions().map((option) => option.value)).toEqual(['all', 'chat', 'search', 'contact'])
    expect(controller.normalizeHistoryFilter('contact')).toBe('contact')
    expect(controller.normalizeHistorySelection({ kind: 'contact', id: 'contact-1' })).toEqual({ kind: 'contact', id: 'contact-1' })
    expect(controller.filterChatSuggestions([contactSuggestion])).toEqual([contactSuggestion])
  })
})
