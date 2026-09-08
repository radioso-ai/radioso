import { describe, expect, it } from 'vitest'

import { mergeGeneralSettingsSnapshot } from '@/lib/general-settings-snapshot'
import type { GeneralSettings } from '@/lib/api-types'

const settings = (overrides: Partial<GeneralSettings>): GeneralSettings => ({
  assistantName: 'Support',
  assistantLogoUrl: null,
  anonymousChatEnabled: false,
  ...overrides,
} as GeneralSettings)

describe('mergeGeneralSettingsSnapshot', () => {
  it('keeps the draft logo URL when a logo landed while the save was in flight', () => {
    const current = settings({ assistantLogoUrl: '/api/v1/public/chat/token/assistant-logo?v=new' })
    const stale = settings({
      assistantLogoUrl: '/api/v1/public/chat/token/assistant-logo?v=replaced',
      anonymousChatEnabled: true,
    })

    const merged = mergeGeneralSettingsSnapshot(current, stale, { hasNewerLogo: true })

    expect(merged.assistantLogoUrl).toBe('/api/v1/public/chat/token/assistant-logo?v=new')
    expect(merged.anonymousChatEnabled).toBe(true)
  })

  it('keeps a removed logo when the save started before the removal', () => {
    const current = settings({ assistantLogoUrl: null })
    const stale = settings({ assistantLogoUrl: '/api/v1/public/chat/token/assistant-logo?v=removed' })

    expect(mergeGeneralSettingsSnapshot(current, stale, { hasNewerLogo: true }).assistantLogoUrl).toBeNull()
  })

  it('takes the snapshot logo URL when no logo write raced the save', () => {
    const current = settings({ assistantLogoUrl: '/api/v1/public/chat/old-token/assistant-logo?v=key' })
    const rotated = settings({ assistantLogoUrl: '/api/v1/public/chat/new-token/assistant-logo?v=key' })

    expect(mergeGeneralSettingsSnapshot(current, rotated, { hasNewerLogo: false }).assistantLogoUrl)
      .toBe('/api/v1/public/chat/new-token/assistant-logo?v=key')
  })

  it('takes the snapshot whole when there is no draft to protect', () => {
    const loaded = settings({ assistantLogoUrl: '/api/v1/public/chat/token/assistant-logo?v=loaded' })

    expect(mergeGeneralSettingsSnapshot(null, loaded, { hasNewerLogo: true })).toBe(loaded)
  })
})
