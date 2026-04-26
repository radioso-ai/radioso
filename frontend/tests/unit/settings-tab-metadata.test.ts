import { describe, expect, it } from 'vitest'

import {
  getSettingsSectionDescriptor,
  getSettingsTabDescriptor,
  settingsTabMetadata,
} from '@/components/dashboard/settings/settings-tab-metadata'

describe('settings tab metadata', () => {
  it('defines ordered section navigation for the main settings tabs', () => {
    expect(settingsTabMetadata.workspace.sections.map((section) => section.id)).toEqual([
      'workspace-access',
    ])

    expect(settingsTabMetadata.assistant.sections.map((section) => section.id)).toEqual([
      'assistant-identity',
    ])

    expect(settingsTabMetadata.channels.sections.map((section) => section.id)).toEqual([
      'anonymous-chat',
      'website-embed',
    ])

    expect(settingsTabMetadata.ingestion.sections.map((section) => section.id)).toEqual([
      'chunking-strategy',
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
    expect(getSettingsTabDescriptor('channels').id).toBe('channels')
    expect(getSettingsSectionDescriptor('workspace', 'workspace-access')?.id).toBe('workspace-access')
    expect(getSettingsSectionDescriptor('ingestion', 'existing-documents')?.id).toBe('existing-documents')
    expect(getSettingsSectionDescriptor('retrieval', 'metadata-rules')?.id).toBe('metadata-rules')
    expect(getSettingsSectionDescriptor('retrieval', 'missing-section')).toBeNull()
    expect(getSettingsSectionDescriptor('workspace', undefined)).toBeNull()
  })
})
