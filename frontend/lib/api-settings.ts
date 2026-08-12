import { request } from './api-client'
import {
  agentToAssistantBehaviorSettings,
  agentToGeneralSettings,
  toGeneralSettings,
} from './api-types'
import type {
  AgentListResponse,
  AgentSettings,
  AgentSettingsUpdate,
  AssistantBehaviorSettings,
  GeneralSettings,
  IngestionSettings,
  PlatformSettings,
  RetrievalDefaults,
  WebsiteEmbedCopyPacks,
  WebsiteEmbedExpertOverrides,
  WebsiteEmbedThemeSettings,
  WebhookDestinationCreateResponse,
  WebhookDestinationListResponse,
  WebhookDestinationRequest,
  WebhookDestinationResponse,
  WorkspaceIngestionReprocessResponse,
} from './api-types'
import { writeRetrievalSkillSettingsOverride } from './retrieval-skill-settings'

type ChannelLifecycle = {
  lastUsedAt: string | null
}

export type ChannelsLifecycle = {
  anonymousChat: ChannelLifecycle
  websiteEmbed: ChannelLifecycle
}

export const mergeChannelsLifecycle = (
  general: GeneralSettings,
  lifecycle: ChannelsLifecycle,
): GeneralSettings => ({
  ...general,
  anonymousChatLastUsedAt: lifecycle.anonymousChat.lastUsedAt,
  websiteEmbedLastUsedAt: lifecycle.websiteEmbed.lastUsedAt,
})

export const settingsApi = {
  async getRetrievalDefaults(options: { auth?: 'apiToken' | 'session' } = {}): Promise<RetrievalDefaults> {
    return request<RetrievalDefaults>("/settings/retrieval-defaults", {
      method: "GET",
    }, options.auth === 'session' ? { withSession: true } : { withApiToken: true })
  },

  async getIngestionSettings(): Promise<IngestionSettings> {
    return request<IngestionSettings>("/settings/ingestion", {
      method: "GET",
    }, { withApiToken: true })
  },

  async updateIngestionSettings(data: IngestionSettings): Promise<IngestionSettings> {
    return request<IngestionSettings>("/settings/ingestion", {
      method: "PUT",
      body: JSON.stringify({
        chunkingStrategy: data.chunkingStrategy,
        embeddingModel: data.embeddingModel,
        fixedWindowChunkSize: data.fixedWindowChunkSize,
        fixedWindowChunkOverlap: data.fixedWindowChunkOverlap,
        structuredMinChunkSize: data.structuredMinChunkSize,
        structuredMaxChunkSize: data.structuredMaxChunkSize,
        documentEnrichmentEnabled: data.documentEnrichmentEnabled,
      }),
    }, { withApiToken: true })
  },

  async reprocessWorkspaceIngestion(input?: { documentEnrichmentOverride?: 'on' | 'off' }): Promise<WorkspaceIngestionReprocessResponse> {
    return request<WorkspaceIngestionReprocessResponse>("/settings/ingestion/reprocess", {
      method: "POST",
      ...(input?.documentEnrichmentOverride
        ? { body: JSON.stringify({ documentEnrichmentOverride: input.documentEnrichmentOverride }) }
        : {}),
    }, { withApiToken: true })
  },

  async cancelPendingEmbeddingModel(): Promise<IngestionSettings> {
    return request<IngestionSettings>("/settings/ingestion/embedding-model/cancel", {
      method: "POST",
    }, { withApiToken: true })
  }
}

export const webhookDestinationsApi = {
  async listDestinations(): Promise<WebhookDestinationListResponse> {
    return request<WebhookDestinationListResponse>('/settings/webhook-destinations', {
      method: 'GET',
    }, { withApiToken: true })
  },

  async createDestination(data: WebhookDestinationRequest): Promise<WebhookDestinationCreateResponse> {
    return request<WebhookDestinationCreateResponse>('/settings/webhook-destinations', {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async updateDestination(
    destinationId: string,
    data: WebhookDestinationRequest,
  ): Promise<WebhookDestinationResponse> {
    return request<WebhookDestinationResponse>(`/settings/webhook-destinations/${destinationId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async rotateSecret(destinationId: string): Promise<WebhookDestinationCreateResponse> {
    return request<WebhookDestinationCreateResponse>(`/settings/webhook-destinations/${destinationId}/rotate-secret`, {
      method: 'POST',
    }, { withApiToken: true })
  },

  async deleteDestination(destinationId: string): Promise<void> {
    await request<void>(`/settings/webhook-destinations/${destinationId}`, {
      method: 'DELETE',
    }, { withApiToken: true })
  },
}

export const generalSettingsApi = {
  async getGeneralSettings(options: { auth?: 'apiToken' | 'session' } = {}): Promise<GeneralSettings> {
    const settings = await request<PlatformSettings>('/settings', {
      method: 'GET',
    }, options.auth === 'session' ? { withSession: true } : { withApiToken: true })
    return toGeneralSettings(settings)
  },

  async updateGeneralSettings(data: {
    anonymousChatEnabled?: boolean
    assistantName?: string
    // Operator-only per-agent label. Accepted on the shared update shape so the
    // agent path can forward it; the workspace /settings path ignores it.
    internalName?: string
    greetingInstruction?: string
    assistantDefaultLocale?: string | null
    proactiveGreetingEnabled?: boolean
    websiteEmbedEnabled?: boolean
    websiteEmbedToken?: string | null
    websiteEmbedScriptUrl?: string | null
    websiteEmbedSnippet?: string | null
    websiteEmbedAllowedOrigins?: string[]
    websiteEmbedLauncherLabel?: string
    websiteEmbedLauncherPosition?: 'bottom-right' | 'bottom-left'
    websiteEmbedTheme?: Partial<WebsiteEmbedThemeSettings>
    websiteEmbedCopy?: WebsiteEmbedCopyPacks
    websiteEmbedExpertOverrides?: WebsiteEmbedExpertOverrides
  }, options: { auth?: 'apiToken' | 'session' } = {}): Promise<GeneralSettings> {
    const settings = await request<PlatformSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        assistant: {
          assistantName: data.assistantName,
          greetingInstruction: data.greetingInstruction,
          assistantDefaultLocale: data.assistantDefaultLocale,
          proactiveGreetingEnabled: data.proactiveGreetingEnabled,
        },
        channels: {
          anonymousChatEnabled: data.anonymousChatEnabled,
          websiteEmbedEnabled: data.websiteEmbedEnabled,
          websiteEmbedAllowedOrigins: data.websiteEmbedAllowedOrigins,
          websiteEmbedLauncherLabel: data.websiteEmbedLauncherLabel,
          websiteEmbedLauncherPosition: data.websiteEmbedLauncherPosition,
          websiteEmbedTheme: data.websiteEmbedTheme,
          websiteEmbedCopy: data.websiteEmbedCopy,
          websiteEmbedExpertOverrides: data.websiteEmbedExpertOverrides,
        },
      }),
    }, options.auth === 'session' ? { withSession: true } : { withApiToken: true })
    return toGeneralSettings(settings)
  },

  async rotateAnonymousChatToken(options: { auth?: 'apiToken' | 'session' } = {}): Promise<GeneralSettings> {
    const settings = await request<PlatformSettings>('/settings/general/anonymous-chat-token/rotate', {
      method: 'POST',
    }, options.auth === 'session' ? { withSession: true } : { withApiToken: true })
    return toGeneralSettings(settings)
  },

  async rotateWebsiteEmbedToken(options: { auth?: 'apiToken' | 'session' } = {}): Promise<GeneralSettings> {
    const settings = await request<PlatformSettings>('/settings/general/website-embed-token/rotate', {
      method: 'POST',
    }, options.auth === 'session' ? { withSession: true } : { withApiToken: true })
    return toGeneralSettings(settings)
  },

  async uploadAssistantLogo(file: File, options: { auth?: 'apiToken' | 'session' } = {}): Promise<GeneralSettings> {
    const formData = new FormData()
    formData.set('logo', file)
    const settings = await request<PlatformSettings>('/settings/general/assistant-logo', {
      method: 'POST',
      body: formData,
    }, options.auth === 'session' ? { withSession: true } : { withApiToken: true })
    return toGeneralSettings(settings)
  },

  async deleteAssistantLogo(options: { auth?: 'apiToken' | 'session' } = {}): Promise<GeneralSettings> {
    const settings = await request<PlatformSettings>('/settings/general/assistant-logo', {
      method: 'DELETE',
    }, options.auth === 'session' ? { withSession: true } : { withApiToken: true })
    return toGeneralSettings(settings)
  },
}

export const agentsApi = {
  async listAgents(): Promise<AgentListResponse> {
    return request<AgentListResponse>('/agents', {
      method: 'GET',
    }, { withApiToken: true })
  },

  async createAgent(data: {
    name: string
    customInstruction?: string
    retrievalEnabled?: boolean
  }): Promise<AgentSettings> {
    return request<AgentSettings>('/agents', {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async getAgent(agentId: string): Promise<AgentSettings> {
    return request<AgentSettings>(`/agents/${agentId}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async getChannelsLifecycle(agentId: string): Promise<ChannelsLifecycle> {
    return request<ChannelsLifecycle>(`/agents/${agentId}/channels/lifecycle`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async updateAgent(agentId: string, data: AgentSettingsUpdate): Promise<AgentSettings> {
    return request<AgentSettings>(`/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async setDefaultAgent(agentId: string): Promise<AgentSettings> {
    return request<AgentSettings>(`/agents/${agentId}/default`, {
      method: 'POST',
    }, { withApiToken: true })
  },

  async deleteAgent(agentId: string): Promise<void> {
    await request<void>(`/agents/${agentId}`, {
      method: 'DELETE',
    }, { withSession: true })
  },

  async getGeneralSettings(agentId: string): Promise<GeneralSettings> {
    const [agent, lifecycle] = await Promise.all([
      this.getAgent(agentId),
      this.getChannelsLifecycle(agentId),
    ])
    return mergeChannelsLifecycle(agentToGeneralSettings(agent), lifecycle)
  },

  async updateGeneralSettings(agentId: string, data: Parameters<typeof generalSettingsApi.updateGeneralSettings>[0]): Promise<GeneralSettings> {
    const agent = await this.updateAgent(agentId, {
      surfaceSettings: {
        anonymousChat: {
          enabled: data.anonymousChatEnabled,
        },
        websiteEmbed: {
          enabled: data.websiteEmbedEnabled,
          allowedOrigins: data.websiteEmbedAllowedOrigins,
          launcherLabel: data.websiteEmbedLauncherLabel,
          launcherPosition: data.websiteEmbedLauncherPosition,
          theme: data.websiteEmbedTheme,
          copy: data.websiteEmbedCopy,
          expertOverrides: data.websiteEmbedExpertOverrides,
        },
      },
      name: data.assistantName,
      internalName: data.internalName,
      greetingInstruction: data.greetingInstruction,
      assistantDefaultLocale: data.assistantDefaultLocale,
      proactiveGreetingEnabled: data.proactiveGreetingEnabled,
    })
    return mergeChannelsLifecycle(agentToGeneralSettings(agent), await this.getChannelsLifecycle(agentId))
  },

  async rotateAnonymousChatToken(agentId: string): Promise<GeneralSettings> {
    const agent = await request<AgentSettings>(`/agents/${agentId}/anonymous-chat-token/rotate`, {
      method: 'POST',
    }, { withApiToken: true })
    return mergeChannelsLifecycle(agentToGeneralSettings(agent), await this.getChannelsLifecycle(agentId))
  },

  async rotateWebsiteEmbedToken(agentId: string): Promise<GeneralSettings> {
    const agent = await request<AgentSettings>(`/agents/${agentId}/website-embed-token/rotate`, {
      method: 'POST',
    }, { withApiToken: true })
    return mergeChannelsLifecycle(agentToGeneralSettings(agent), await this.getChannelsLifecycle(agentId))
  },

  async uploadAssistantLogo(agentId: string, file: File): Promise<GeneralSettings> {
    const formData = new FormData()
    formData.set('logo', file)
    return agentToGeneralSettings(await request<AgentSettings>(`/agents/${agentId}/assistant-logo`, {
      method: 'POST',
      body: formData,
    }, { withApiToken: true }))
  },

  async deleteAssistantLogo(agentId: string): Promise<GeneralSettings> {
    return agentToGeneralSettings(await request<AgentSettings>(`/agents/${agentId}/assistant-logo`, {
      method: 'DELETE',
    }, { withApiToken: true }))
  },

  async getBehaviorSettings(agentId: string): Promise<AssistantBehaviorSettings> {
    return agentToAssistantBehaviorSettings(await this.getAgent(agentId))
  },

  async updateBehaviorSettings(
    agentId: string,
    data: AssistantBehaviorSettings,
    saved: AssistantBehaviorSettings,
  ): Promise<AssistantBehaviorSettings> {
    const hasChanged = (next: unknown, previous: unknown) => JSON.stringify(next) !== JSON.stringify(previous)
    const update: AgentSettingsUpdate = {}

    if (data.suggestedQuestionsEnabled !== saved.suggestedQuestionsEnabled) update.suggestedQuestionsEnabled = data.suggestedQuestionsEnabled
    if (data.customInstruction !== saved.customInstruction) update.customInstruction = data.customInstruction
    if (data.assistantLinkUtmEnabled !== saved.assistantLinkUtmEnabled) update.assistantLinkUtmEnabled = data.assistantLinkUtmEnabled
    if (data.citationDisplayEnabled !== saved.citationDisplayEnabled) update.citationDisplayEnabled = data.citationDisplayEnabled
    if (data.contactRequestsEnabled !== saved.contactRequestsEnabled) update.contactRequestsEnabled = data.contactRequestsEnabled
    if (data.webhookExportsEnabled !== saved.webhookExportsEnabled) update.webhookExportsEnabled = data.webhookExportsEnabled
    if (hasChanged(data.contactRequestDelivery, saved.contactRequestDelivery)) update.contactRequestDelivery = data.contactRequestDelivery
    if (data.retrievalEnabled !== saved.retrievalEnabled) update.retrievalEnabled = data.retrievalEnabled
    if (hasChanged(data.theme, saved.theme)) update.theme = data.theme
    if (hasChanged(data.branding, saved.branding)) update.branding = data.branding
    if (hasChanged(data.sourceScope, saved.sourceScope)) update.sourceScope = data.sourceScope
    if (hasChanged(data.skillSettings, saved.skillSettings) || hasChanged(data.retrievalSkillSettings, saved.retrievalSkillSettings)) {
      update.skillSettings = data.retrievalSkillSettings
        ? writeRetrievalSkillSettingsOverride(data.skillSettings, data.retrievalSkillSettings)
        : data.skillSettings
    }
    // null = clear back to workspace fallback; undefined = leave unchanged.
    if (data.chatModelOverride !== saved.chatModelOverride) update.chatModelOverride = data.chatModelOverride

    return agentToAssistantBehaviorSettings(await this.updateAgent(agentId, update))
  },
}
