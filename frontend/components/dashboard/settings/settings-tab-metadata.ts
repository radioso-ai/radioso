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
  general: {
    id: 'general',
    title: 'General Settings',
    summary:
      'Manage workspace identity, operator access, assistant setup, public chat, and website embed from one control surface.',
    sections: [
      {
        id: 'workspace-access',
        label: 'Workspace & access',
        summary: 'Organization label, workspace naming, API access, and destructive actions.',
      },
      {
        id: 'assistant-identity',
        label: 'Assistant setup',
        summary: 'Assistant identity, locale fallback, and greeting behavior.',
      },
      {
        id: 'anonymous-chat',
        label: 'Anonymous chat',
        summary: 'Public chat access, link sharing, and rate limits.',
      },
      {
        id: 'website-embed',
        label: 'Website embed',
        summary: 'Launcher settings, approved origins, and install snippet.',
      },
    ],
  },
  ingestion: {
    id: 'ingestion',
    title: 'Ingestion Settings',
    summary:
      'Choose how documents are chunked before retrieval and control when existing documents should be reprocessed.',
    sections: [
      {
        id: 'chunking-strategy',
        label: 'Strategy',
        summary: 'Pick the chunking approach used for future ingests.',
      },
      {
        id: 'chunking-tuning',
        label: 'Active tuning',
        summary: 'Adjust the parameters for the currently selected strategy.',
      },
      {
        id: 'existing-documents',
        label: 'Existing documents',
        summary: 'Re-queue current documents when you want stored chunks rewritten.',
      },
    ],
  },
  retrieval: {
    id: 'retrieval',
    title: 'Retrieval Settings',
    summary:
      'Tune how Radioso rewrites, retrieves, filters, and presents grounded answers without changing the underlying corpus.',
    sections: [
      {
        id: 'query-rewrite',
        label: 'Query rewriting',
        summary: 'Control how incoming questions are rewritten for retrieval.',
      },
      {
        id: 'search-tuning',
        label: 'Search tuning',
        summary: 'Configure vector search thresholds and reranking behavior.',
      },
      {
        id: 'metadata-rules',
        label: 'Metadata rules',
        summary: 'Boost or filter results using persistent metadata conditions.',
      },
      {
        id: 'answer-behavior',
        label: 'Answer behavior',
        summary: 'Shape grounded answer style, suggestions, and support validation.',
      },
    ],
  },
  connectors: {
    id: 'connectors',
    title: 'Chat Connectors',
    summary:
      'Connect external chat channels to this workspace and manage each connector configuration from the same settings area.',
    sections: [
      {
        id: 'connectors',
        label: 'Connector list',
        summary: 'Browse, connect, and configure the available chat channels for this workspace.',
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
