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
    ])

    expect(settingsTabMetadata.users.sections.map((section) => section.id)).toEqual([
      'users-access',
    ])
  })

  it('returns tab descriptors and resolves only known sections', () => {
    expect(getSettingsTabDescriptor('users').id).toBe('users')
    expect(getSettingsSectionDescriptor('workspace', 'workspace-access')?.id).toBe('workspace-access')
    expect(getSettingsSectionDescriptor('users', 'users-access')?.id).toBe('users-access')
    expect(getSettingsSectionDescriptor('users', 'missing-section')).toBeNull()
    expect(getSettingsSectionDescriptor('workspace', undefined)).toBeNull()
  })
})
