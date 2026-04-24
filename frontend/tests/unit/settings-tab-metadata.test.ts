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
      'whatsapp-channel',
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
    expect(getSettingsTabDescriptor('channels').title).toBe('Channels')
    expect(getSettingsSectionDescriptor('workspace', 'workspace-access')?.label).toBe('Workspace and access')
    expect(getSettingsSectionDescriptor('ingestion', 'existing-documents')?.label).toBe(
      'Reprocess existing documents'
    )
    expect(getSettingsSectionDescriptor('retrieval', 'metadata-rules')?.label).toBe(
      'Prioritize by metadata'
    )
    expect(getSettingsSectionDescriptor('retrieval', 'missing-section')).toBeNull()
    expect(getSettingsSectionDescriptor('workspace', undefined)).toBeNull()
  })
})
