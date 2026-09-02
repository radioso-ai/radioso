import { describe, expect, it } from 'vitest'

import {
  getSettingsSectionDescriptor,
  getSettingsTabDescriptor,
  settingsTabMetadata,
} from '@/components/dashboard/settings/settings-tab-metadata'

describe('settings tab metadata', () => {
  it('defines ordered section navigation for workspace settings tabs', () => {
    expect(settingsTabMetadata.workspace.sections.map((section) => section.id)).toEqual([
      'workspace-access',
      'webhook-destinations',
    ])

    expect(settingsTabMetadata.providers.sections.map((section) => section.id)).toEqual([
      'provider-credentials',
      'provider-models',
    ])
    expect(settingsTabMetadata['api-access'].sections.map((section) => section.id)).toEqual([
      'personal-tokens',
      'service-accounts',
      'member-personal-tokens',
    ])
  })

  it('returns tab descriptors and resolves only known sections', () => {
    expect(getSettingsTabDescriptor('providers').id).toBe('providers')
    expect(getSettingsTabDescriptor('api-access').id).toBe('api-access')
    expect(getSettingsSectionDescriptor('workspace', 'workspace-access')?.id).toBe('workspace-access')
    expect(getSettingsSectionDescriptor('workspace', 'webhook-destinations')?.id).toBe('webhook-destinations')
    expect(getSettingsSectionDescriptor('workspace', 'missing-section')).toBeNull()
    expect(getSettingsSectionDescriptor('workspace', undefined)).toBeNull()
  })
})
