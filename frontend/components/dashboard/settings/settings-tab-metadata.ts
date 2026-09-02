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
    summary: 'Control workspace identity, API access, and lifecycle.',
    sections: [
      {
        id: 'workspace-access',
        label: 'Workspace and access',
        summary: 'Organization label, workspace naming, API access, and destructive actions.',
      },
      {
        id: 'webhook-destinations',
        label: 'Webhook destinations',
        summary: 'Reusable signed endpoints that routines can export completion data to.',
      },
    ],
  },
  'service-accounts': {
    id: 'service-accounts',
    title: 'Service accounts',
    summary: 'Manage standalone workspace identities for integrations and automation.',
    sections: [
      {
        id: 'service-accounts',
        label: 'Service accounts',
        summary: 'Create, disable, archive, and rotate credentials for non-human identities.',
      },
    ],
  },
  providers: {
    id: 'providers',
    title: 'Providers',
    summary: 'Connect AI provider API keys and pick which model handles chat, query rewrite, rerank, and embeddings.',
    sections: [
      {
        id: 'provider-credentials',
        label: 'Provider API keys',
        summary: 'Workspace API keys for OpenAI, Anthropic, Gemini, and OpenAI-compatible endpoints.',
      },
      {
        id: 'provider-models',
        label: 'Models',
        summary: 'Per-capability provider and model selection, including the workspace embedding model.',
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
