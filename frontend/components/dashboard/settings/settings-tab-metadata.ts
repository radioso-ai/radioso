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
    summary: 'Control workspace identity and lifecycle.',
    sections: [
      {
        id: 'workspace-access',
        label: 'Workspace and access',
        summary: 'Organization label, workspace naming, and destructive actions.',
      },
      {
        id: 'webhook-destinations',
        label: 'Webhook destinations',
        summary: 'Reusable signed endpoints that routines can export completion data to.',
      },
    ],
  },
  'api-access': {
    id: 'api-access',
    title: 'API access',
    summary: 'Every identity that can call this workspace over the API.',
    sections: [
      {
        id: 'personal-tokens',
        label: 'Personal tokens',
        summary: 'Act as you.',
      },
      {
        id: 'service-accounts',
        label: 'Service accounts',
        summary: 'One identity per integration, revocable on its own.',
      },
      {
        id: 'member-personal-tokens',
        label: 'Members’ personal tokens',
        summary: 'Revoke any; owners manage their own.',
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
