import type { SettingsTab } from '@/lib/dashboard-routes'

export interface SettingsSectionDescriptor {
  id: string
  label: string
  summary: string
}

export interface SettingsTabDescriptor {
  id: SettingsTab
  title: string
  summary: string
  sections: SettingsSectionDescriptor[]
}

export const settingsTabMetadata: Record<SettingsTab, SettingsTabDescriptor> = {
  workspace: {
    id: 'workspace',
    title: 'Workspace',
    summary: 'Control workspace identity, access, and lifecycle.',
    sections: [
      {
        id: 'workspace-access',
        label: 'Workspace and access',
        summary: 'Organization label, workspace naming, API access, and destructive actions.',
      },
    ],
  },
  assistant: {
    id: 'assistant',
    title: 'Assistant',
    summary: 'Control the assistant’s public identity, answer behavior, and first-message defaults.',
    sections: [
      {
        id: 'assistant-identity',
        label: 'Assistant Identity',
        summary: 'Public identity, answer behavior, locale fallback, and first-message settings.',
      },
    ],
  },
  channels: {
    id: 'channels',
    title: 'Channels',
    summary: 'Control where users can access this assistant across public chat, website embed, and WhatsApp.',
    sections: [
      {
        id: 'anonymous-chat',
        label: 'Anonymous Chat Access',
        summary: 'Public chat access, link sharing, and rate limits.',
      },
      {
        id: 'website-embed',
        label: 'Website embed',
        summary: 'Launcher settings, approved origins, and install snippet.',
      },
      {
        id: 'connectors',
        label: 'WhatsApp',
        summary: 'Configure the WhatsApp channel for this workspace.',
      },
    ],
  },
  ingestion: {
    id: 'ingestion',
    title: 'Ingestion',
    summary: 'Control how documents are split before they become searchable.',
    sections: [
      {
        id: 'chunking-strategy',
        label: 'Chunking',
        summary: 'Pick the chunking approach and tune the active strategy in one place.',
      },
      {
        id: 'existing-documents',
        label: 'Reprocess existing documents',
        summary: 'Re-queue current documents when you want stored chunks rewritten.',
      },
    ],
  },
  retrieval: {
    id: 'retrieval',
    title: 'Retrieval',
    summary: 'Control how this workspace finds evidence and shows grounded citations and suggestions.',
    sections: [
      {
        id: 'query-rewrite',
        label: 'Rewrite the incoming question',
        summary: 'Control how incoming questions are rewritten for retrieval.',
      },
      {
        id: 'search-tuning',
        label: 'Tune search and reranking',
        summary: 'Configure vector search thresholds and reranking behavior.',
      },
      {
        id: 'metadata-rules',
        label: 'Prioritize by metadata',
        summary: 'Boost or filter results using persistent metadata conditions.',
      },
      {
        id: 'answer-behavior',
        label: 'Answer presentation',
        summary: 'Control citations and grounded follow-up suggestions.',
      },
    ],
  },
}

export const getSettingsTabDescriptor = (tab: SettingsTab): SettingsTabDescriptor =>
  settingsTabMetadata[tab]

export const getSettingsSectionDescriptor = (
  tab: SettingsTab,
  sectionId: string | undefined
): SettingsSectionDescriptor | null => {
  if (!sectionId) {
    return null
  }

  return settingsTabMetadata[tab].sections.find((section) => section.id === sectionId) ?? null
}
