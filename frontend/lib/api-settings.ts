import { request } from './api-client'
import {
  agentToAssistantBehaviorSettings,
  agentToGeneralSettings,
  retrievalSettingsToAssistantBehaviorSettings,
  toGeneralSettings,
  toRetrievalSettings,
} from './api-types'
import type {
  AgentListResponse,
  AgentSettings,
  AgentSettingsUpdate,
  AssistantBehaviorSettings,
  GeneralSettings,
  IngestionSettings,
  PlatformSettings,
  RetrievalSettings,
  WebsiteEmbedCopyPacks,
  WebsiteEmbedExpertOverrides,
  WebsiteEmbedThemeSettings,
  WorkspaceIngestionReprocessResponse,
} from './api-types'

export const settingsApi = {
  async getRetrievalSettings(options: { auth?: 'apiToken' | 'session' } = {}): Promise<RetrievalSettings> {
    const settings = await request<PlatformSettings>("/settings", {
      method: "GET",
    }, options.auth === 'session' ? { withSession: true } : { withApiToken: true })
    return toRetrievalSettings(settings)
  },

  async updateRetrievalSettings(data: RetrievalSettings, options: { auth?: 'apiToken' | 'session' } = {}): Promise<RetrievalSettings> {
    const { metadataFieldSuggestions, ...payload } = data
    void metadataFieldSuggestions
    const settings = await request<PlatformSettings>("/settings", {
      method: "PUT",
      body: JSON.stringify({
        assistant: {
          suggestedQuestionsEnabled: payload.suggestedQuestionsEnabled,
          customInstruction: payload.customInstruction,
        },
        retrieval: {
          queryRewriteEnabled: payload.queryRewriteEnabled,
          semanticRewriteInstructions: payload.semanticRewriteInstructions,
          lexicalRewriteInstructions: payload.lexicalRewriteInstructions,
          rerankEnabled: payload.rerankEnabled,
          vectorTopK: payload.vectorTopK,
          similarityThreshold: payload.similarityThreshold,
          rerankTopK: payload.rerankTopK,
          retrievalStrategy: payload.retrievalStrategy,
          metadataRules: payload.metadataRules,
        },
      }),
    }, options.auth === 'session' ? { withSession: true } : { withApiToken: true })
    return toRetrievalSettings(settings)
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
      }),
    }, { withApiToken: true })
  },

  async reprocessWorkspaceIngestion(): Promise<WorkspaceIngestionReprocessResponse> {
    return request<WorkspaceIngestionReprocessResponse>("/settings/ingestion/reprocess", {
      method: "POST",
    }, { withApiToken: true })
  },

  async cancelPendingEmbeddingModel(): Promise<IngestionSettings> {
    return request<IngestionSettings>("/settings/ingestion/embedding-model/cancel", {
      method: "POST",
    }, { withApiToken: true })
  }
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
    return agentToGeneralSettings(await this.getAgent(agentId))
  },

  async updateGeneralSettings(agentId: string, data: Parameters<typeof generalSettingsApi.updateGeneralSettings>[0]): Promise<GeneralSettings> {
    return agentToGeneralSettings(await this.updateAgent(agentId, {
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
      greetingInstruction: data.greetingInstruction,
      assistantDefaultLocale: data.assistantDefaultLocale,
      proactiveGreetingEnabled: data.proactiveGreetingEnabled,
    }))
  },

  async rotateAnonymousChatToken(agentId: string): Promise<GeneralSettings> {
    return agentToGeneralSettings(await request<AgentSettings>(`/agents/${agentId}/anonymous-chat-token/rotate`, {
      method: 'POST',
    }, { withApiToken: true }))
  },

  async rotateWebsiteEmbedToken(agentId: string): Promise<GeneralSettings> {
    return agentToGeneralSettings(await request<AgentSettings>(`/agents/${agentId}/website-embed-token/rotate`, {
      method: 'POST',
    }, { withApiToken: true }))
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

  async updateBehaviorSettings(agentId: string, data: AssistantBehaviorSettings): Promise<AssistantBehaviorSettings> {
    return agentToAssistantBehaviorSettings(await this.updateAgent(agentId, {
      suggestedQuestionsEnabled: data.suggestedQuestionsEnabled,
      customInstruction: data.customInstruction,
      assistantLinkUtmEnabled: data.assistantLinkUtmEnabled,
      citationDisplayEnabled: data.citationDisplayEnabled,
      theme: data.theme,
      branding: data.branding,
      sourceScope: data.sourceScope,
      // null = clear back to workspace fallback; undefined = leave unchanged.
      chatModelOverride: data.chatModelOverride === undefined ? undefined : data.chatModelOverride,
    }))
  },

  async getWorkspaceBehaviorSettings(options: { auth?: 'apiToken' | 'session' } = {}): Promise<AssistantBehaviorSettings> {
    return retrievalSettingsToAssistantBehaviorSettings(await settingsApi.getRetrievalSettings(options))
  },

  async updateWorkspaceBehaviorSettings(
    data: AssistantBehaviorSettings,
    options: { auth?: 'apiToken' | 'session' } = {},
  ): Promise<AssistantBehaviorSettings> {
    const current = await settingsApi.getRetrievalSettings(options)
    return retrievalSettingsToAssistantBehaviorSettings(await settingsApi.updateRetrievalSettings({
      ...current,
      ...data,
    }, options))
  },
}
