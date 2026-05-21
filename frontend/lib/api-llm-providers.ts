import { request } from './api-client'

export const llmProviderNames = ['openai', 'openai-compatible', 'gemini', 'claude'] as const
export type LlmProviderName = (typeof llmProviderNames)[number]

export const llmCapabilityNames = ['chat', 'rewrite', 'rerank'] as const
export type LlmCapabilityName = (typeof llmCapabilityNames)[number]

export interface LlmCapabilityPreference {
  provider: LlmProviderName
  model: string
}

export type KnownModelsByProvider = Record<LlmProviderName, string[]>

export interface WorkspaceLlmModels {
  chat: LlmCapabilityPreference | null
  rewrite: LlmCapabilityPreference | null
  rerank: LlmCapabilityPreference | null
  knownModelsByProvider: KnownModelsByProvider
}

export interface ProviderCredentialSummary {
  provider: LlmProviderName
  updatedAt: string
}

export type EnvProviderAvailability = Record<LlmProviderName, boolean>

export interface ProviderCredentialsList {
  encryptionConfigured: boolean
  credentials: ProviderCredentialSummary[]
  envProviderAvailability: EnvProviderAvailability
}

export const emptyEnvProviderAvailability: EnvProviderAvailability = {
  openai: false,
  'openai-compatible': false,
  gemini: false,
  claude: false,
}

const sessionOnly = { withSession: true } as const

export const llmProvidersApi = {
  async listCredentials(): Promise<ProviderCredentialsList> {
    return request<ProviderCredentialsList>('/settings/credentials', { method: 'GET' }, sessionOnly)
  },

  async setCredential(provider: LlmProviderName, apiKey: string): Promise<void> {
    await request<void>(
      `/settings/credentials/${encodeURIComponent(provider)}`,
      { method: 'PUT', body: JSON.stringify({ apiKey }) },
      sessionOnly,
    )
  },

  async removeCredential(provider: LlmProviderName): Promise<void> {
    await request<void>(
      `/settings/credentials/${encodeURIComponent(provider)}`,
      { method: 'DELETE' },
      sessionOnly,
    )
  },

  async getModels(): Promise<WorkspaceLlmModels> {
    return request<WorkspaceLlmModels>('/settings/llm-models', { method: 'GET' }, sessionOnly)
  },

  async updateModels(payload: Partial<WorkspaceLlmModels>): Promise<WorkspaceLlmModels> {
    return request<WorkspaceLlmModels>(
      '/settings/llm-models',
      { method: 'PUT', body: JSON.stringify(payload) },
      sessionOnly,
    )
  },
}

export const providerDisplayName: Record<LlmProviderName, string> = {
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-compatible',
  gemini: 'Google Gemini',
  claude: 'Anthropic Claude',
}

export const capabilityDisplayName: Record<LlmCapabilityName, string> = {
  chat: 'Chat',
  rewrite: 'Query rewrite',
  rerank: 'Rerank',
}

/**
 * Default empty catalog used until the backend response loads. The real
 * `knownModelsByProvider` arrives in the `GET /settings/llm-models` payload —
 * the backend is the single source of truth.
 */
export const emptyKnownModelsByProvider: KnownModelsByProvider = {
  openai: [],
  'openai-compatible': [],
  gemini: [],
  claude: [],
}
