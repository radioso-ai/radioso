import { describe, expect, it } from 'vitest'

import { buildDashboardHref } from '@/lib/dashboard-routes'
import { buildProviderSettingsHref, isLlmMissing } from '@/lib/llm-readiness'

describe('isLlmMissing', () => {
  it('reads Ray availability: missing only when the reason says no LLM capability', () => {
    expect(isLlmMissing({ reason: 'no_llm_capability' })).toBe(true)
    expect(isLlmMissing({ reason: 'ok' })).toBe(false)
  })

  it('treats a status that has not loaded yet as not missing, so the setup prompt never flashes', () => {
    expect(isLlmMissing(null)).toBe(false)
    expect(isLlmMissing(undefined)).toBe(false)
  })
})

describe('buildProviderSettingsHref', () => {
  it('opens the providers tab of settings in the given workspace', () => {
    const workspace = { workspaceId: 'workspace-1', workspacePublicRouteKey: 'support-abc123' }

    expect(buildProviderSettingsHref('account-1', workspace)).toBe(
      buildDashboardHref('account-1', { section: 'settings', settingsTab: 'providers', ...workspace }),
    )
  })
})
