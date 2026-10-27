import { request } from './api-client'
import type { AgentVoiceSettings } from './api-types'

export const llmProviderNames = ['openai', 'openai-compatible', 'gemini', 'claude'] as const
export type LlmProviderName = (typeof llmProviderNames)[number]

/** Where an OpenAI credential's calls run. Meaningful only for the `openai` provider. */
export const openAiDataResidencies = ['global', 'us', 'eu'] as const
export type OpenAiDataResidency = (typeof openAiDataResidencies)[number]

/** The voice runtimes the API names, from the generated contract. */
export type VoiceVendorName = NonNullable<AgentVoiceSettings['runtime']>['vendor']
/** Every vendor the contract names, and only those: a vendor added to the API fails this list's type until it is here. */
const listEveryVoiceVendor = <const Names extends readonly VoiceVendorName[]>(
  names: Names & (Exclude<VoiceVendorName, Names[number]> extends never ? unknown : never),
) => names
/** Voice runtimes whose key the workspace holds beside its model provider keys; none has a deployment fallback. */
export const voiceVendorNames = listEveryVoiceVendor(['elevenlabs'])
export type CredentialProviderName = LlmProviderName | VoiceVendorName

export const llmCapabilityNames = ['chat', 'rewrite', 'rerank'] as const
export type LlmCapabilityName = (typeof llmCapabilityNames)[number]

export interface LlmCapabilityPreference {
  provider: LlmProviderName
  model: string
}

export type KnownModelsByProvider = Record<LlmProviderName, string[]>

/** What the plan runs for a capability instead of the stored preference; null when the workspace chooses. */
export type LlmManagedModel = LlmCapabilityPreference

type WorkspaceLlmPreferences = Record<LlmCapabilityName, LlmCapabilityPreference | null>

export interface WorkspaceLlmModels extends WorkspaceLlmPreferences {
  managed: Record<LlmCapabilityName, LlmManagedModel | null>
  knownModelsByProvider: KnownModelsByProvider
  /** The catalog models this workspace can run: what model pickers offer. */
  runnableModelsByProvider: KnownModelsByProvider
}

export interface ProviderCredentialSummary {
  provider: CredentialProviderName
  /** The stored row's residency; `global` for every provider but `openai`. */
  residency: OpenAiDataResidency
  updatedAt: string
}

export type EnvProviderAvailability = Record<LlmProviderName, boolean>

interface ProviderCredentialsList {
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

  /**
   * `apiKey` and `residency` are each optional so that changing an OpenAI credential's
   * residency alone reaches the same endpoint without re-entering the key.
   */
  async setCredential(
    provider: CredentialProviderName,
    input: { apiKey?: string; residency?: OpenAiDataResidency },
  ): Promise<void> {
    await request<void>(
      `/settings/credentials/${encodeURIComponent(provider)}`,
      { method: 'PUT', body: JSON.stringify(input) },
      sessionOnly,
    )
  },

  async removeCredential(provider: CredentialProviderName): Promise<void> {
    await request<void>(
      `/settings/credentials/${encodeURIComponent(provider)}`,
      { method: 'DELETE' },
      sessionOnly,
    )
  },

  async getModels(): Promise<WorkspaceLlmModels> {
    return request<WorkspaceLlmModels>('/settings/llm-models', { method: 'GET' }, sessionOnly)
  },

  async updateModels(payload: Partial<WorkspaceLlmPreferences>): Promise<WorkspaceLlmModels> {
    return request<WorkspaceLlmModels>(
      '/settings/llm-models',
      { method: 'PUT', body: JSON.stringify(payload) },
      sessionOnly,
    )
  },
}

export const providerDisplayName: Record<CredentialProviderName, string> = {
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-compatible',
  gemini: 'Google Gemini',
  claude: 'Anthropic Claude',
  elevenlabs: 'ElevenLabs',
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
