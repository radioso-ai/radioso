import { describe, expect, it } from 'vitest'

import {
  getSettingsSectionDescriptor,
  getSettingsTabDescriptor,
  settingsTabMetadata,
} from '@/components/dashboard/settings/settings-tab-metadata'

describe('settings tab metadata', () => {
  it('defines ordered section navigation for the main settings tabs', () => {
    expect(settingsTabMetadata.general.sections.map((section) => section.id)).toEqual([
      'workspace-access',
      'assistant-identity',
      'anonymous-chat',
      'website-embed',
    ])

    expect(settingsTabMetadata.ingestion.sections.map((section) => section.id)).toEqual([
      'chunking-strategy',
      'chunking-tuning',
      'existing-documents',
    ])

    expect(settingsTabMetadata.retrieval.sections.map((section) => section.id)).toEqual([
      'query-rewrite',
      'search-tuning',
      'metadata-rules',
      'answer-behavior',
    ])
  })

  it('returns tab descriptors and resolves only known sections', () => {
    expect(getSettingsTabDescriptor('connectors').title).toBe('Chat Connectors')
    expect(getSettingsSectionDescriptor('retrieval', 'metadata-rules')?.label).toBe('Metadata rules')
    expect(getSettingsSectionDescriptor('retrieval', 'missing-section')).toBeNull()
    expect(getSettingsSectionDescriptor('general', undefined)).toBeNull()
  })
})
