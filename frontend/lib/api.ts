import {
  API_BASE,
  PUBLIC_CHAT_STREAMING_API_PATH,
  STREAMING_API_PATH,
  attachAnonymousSessionHeader,
  buildError,
  canRetryWithFreshWorkspaceToken,
  persistAnonymousSessionHeader,
  refreshWorkspaceApiToken,
  request,
  requestLongRunning,
  requireWorkspaceApiToken,
  storeEffectivePublicChatToken,
  storePublicSessionToken,
  storeWorkspaceToken,
} from './api-client'
import { streamChatEvents } from './api-chat-stream'
import { AUTH_RECOVERY_ENABLED } from './enterprise-features'
import type { components } from '../../typescript-sdk/src/generated/types'

export {
  activateWorkspaceToken,
  clearStoredAnonymousSession,
  clearStoredEmbedBootstrapSession,
  clearWorkspaceStorage,
  getPendingAccountSwitchId,
  getStoredActiveWorkspaceId,
  getStoredActiveWorkspacePublicRouteKey,
  readStoredAnonymousSessionId,
  readStoredEmbedBootstrapSession,
  readStoredEffectivePublicChatToken,
  readStoredPublicSessionToken,
  removeWorkspaceToken,
  seedWorkspaceSession,
  setPendingAccountSwitchId,
  storeEmbedBootstrapSession,
  storeEffectivePublicChatToken,
  storePublicSessionToken,
} from './api-client'

type ApiSchemas = components['schemas']
type RelaxedAssistantChatResponse<T> = T extends unknown
  ? Omit<T, 'conversationId' | 'assistantMessageId' | 'route' | 'suggestions'> & {
      conversationId?: string
      assistantMessageId?: string
      route?: ApiSchemas['AssistantRoute']
      suggestions?: ChatSuggestion[]
    }
  : never
type PlatformRetrievalSettings = Omit<ApiSchemas['PlatformRetrievalSettingsSection'], 'metadataRules'> & {
  metadataRules: RetrievalMetadataRule[]
}

export type RegisterRequest = ApiSchemas['RegisterRequest']
export type RegisterResponse = ApiSchemas['RegisterResponse'] & {
  requiresEmailVerification?: boolean
}
export type LoginRequest = ApiSchemas['LoginRequest']
export type LoginResponse = ApiSchemas['LoginResponse']

export type RetrievalSettings = PlatformRetrievalSettings &
  Pick<
    ApiSchemas['AssistantSettingsSection'],
    'suggestedQuestionsEnabled' | 'customInstruction'
  >

export type AssistantBehaviorSettings = Pick<
  RetrievalSettings,
  'suggestedQuestionsEnabled' | 'customInstruction'
> & {
  theme: WebsiteEmbedThemeSettings
}

export type PlatformSettings = Omit<ApiSchemas['PlatformSettingsResponse'], 'retrieval'> & {
  retrieval: PlatformRetrievalSettings
}

export type WebsiteEmbedThemeSettings = ApiSchemas['GeneralSettingsResponse']['websiteEmbedTheme']
export type WebsiteEmbedCopyPacks = ApiSchemas['GeneralSettingsResponse']['websiteEmbedCopy']
export type WebsiteEmbedExpertOverrides = ApiSchemas['GeneralSettingsResponse']['websiteEmbedExpertOverrides']

export type RetrievalMetadataRule = Omit<ApiSchemas['RetrievalMetadataRule'], 'combinator' | 'conditions'> &
  Partial<Pick<ApiSchemas['RetrievalMetadataRule'], 'combinator' | 'conditions'>>
export type RetrievalMetadataValueType = RetrievalMetadataRule['valueType']
export type MetadataFieldSuggestion = ApiSchemas['PlatformRetrievalSettingsSection']['metadataFieldSuggestions'][number]
export type RetrievalMetadataRuleOperator = RetrievalMetadataRule['operator']
export type RetrievalMetadataRuleEffect = RetrievalMetadataRule['effect']
export type RetrievalMetadataRuleCombinator = NonNullable<RetrievalMetadataRule['combinator']>
export type RetrievalMetadataCondition = NonNullable<RetrievalMetadataRule['conditions']>[number]

export type IngestionSettings = ApiSchemas['IngestionSettings']
export type WorkspaceIngestionReprocessResponse = ApiSchemas['WorkspaceIngestionReprocessResponse']
export type DocumentCreateRequest = ApiSchemas['DocumentCreateRequest']
export type DocumentCreateResponse = ApiSchemas['DocumentOperationResponse']
export type DocumentSourceSummary = ApiSchemas['DocumentSourceSummary']
export type DocumentSummary = ApiSchemas['DocumentSummary']
export type DocumentDetails = ApiSchemas['DocumentDetails']
export type DocumentListResponse = ApiSchemas['DocumentListResponse']

export type DocumentSearchAction = ApiSchemas['DocumentSearchAction']
export type DocumentSearchResult = ApiSchemas['DocumentSearchResult']
export type DocumentSearchResponse = ApiSchemas['DocumentSearchResponse']
export type DocumentSearchHistoryEntry = ApiSchemas['DocumentSearchHistoryEntry']
export type DocumentSearchHistoryListResponse = ApiSchemas['DocumentSearchHistoryListResponse']
export type WebsiteCrawlJobStatus = ApiSchemas['WebsiteCrawlJobStatus']
export type WebsiteCrawlJobSummary = ApiSchemas['WebsiteCrawlJobSummary']
export type WebsiteCrawlEnqueueResponse = ApiSchemas['WebsiteCrawlJobResponse']
export type WebsiteCrawlJobListResponse = ApiSchemas['WebsiteCrawlJobListResponse']

export interface ChatRequest {
  agentId?: string
  query?: string
  stream: boolean
  conversationId?: string
  bootstrapGreeting?: boolean
  userExpectedLocale?: string
  inputMetadata?: ChatUserInputMetadata
}

export type WebsiteEmbedPageContext = NonNullable<ApiSchemas['PublicChatSessionRequest']['pageContext']>
export type PublicChatSessionResponse = ApiSchemas['PublicChatSessionResponse']

const toAssistantChatPayload = (data: ChatRequest) => ({
  agentId: data.agentId,
  conversationId: data.conversationId,
  message: data.query,
  startConversation: data.bootstrapGreeting,
  stream: data.stream,
  userExpectedLocale: data.userExpectedLocale,
  inputMetadata: data.inputMetadata,
  sourceContext: {
    surface: 'authenticated_chat' as const,
  },
})

const toRetrievalSettings = (settings: PlatformSettings): RetrievalSettings => ({
  ...settings.retrieval,
  suggestedQuestionsEnabled: settings.assistant.suggestedQuestionsEnabled,
  customInstruction: settings.assistant.customInstruction,
})

const toGeneralSettings = (settings: PlatformSettings): GeneralSettings => ({
  ...settings.channels,
  assistantName: settings.assistant.assistantName,
  greetingInstruction: settings.assistant.greetingInstruction,
  assistantDefaultLocale: settings.assistant.assistantDefaultLocale,
  proactiveGreetingEnabled: settings.assistant.proactiveGreetingEnabled,
  assistantBootstrapActive: settings.assistant.assistantBootstrapActive,
  assistantLogoUrl: settings.assistant.assistantLogoUrl,
})

export type ChatUserInputMetadata = NonNullable<
  Extract<ApiSchemas['AssistantChatRequest'], { inputMetadata?: unknown }>['inputMetadata']
>
export type Citation = ApiSchemas['Citation']
export type AnswerSegment = ApiSchemas['AnswerSegment']
export type ChatSuggestionKind = ApiSchemas['ChatSuggestion']['kind']
export type ChatSuggestion = Omit<ApiSchemas['ChatSuggestion'], 'kind'> & {
  kind?: ChatSuggestionKind
}

export type HumanContactTriggerSource =
  | 'manual'
  | 'assistant_suggestion'
  | 'no_context_refusal'
  | 'grounded_degraded_unsupported_segments'
  | 'explicit_user_request'
  | 'llm_classifier'

export interface HumanContactDraftResponse {
  draftMessage: string
  defaultEmail?: string | null
}

export interface HumanContactSubmitResponse {
  requestId: string
}

export interface HumanContactSubmitInput {
  conversationId: string
  assistantMessageId?: string
  email: string
  message: string
  triggerSource: HumanContactTriggerSource
  triggerReason?: string
}

export interface HumanContactAvailability {
  enabled: boolean
  configured: boolean
  emailEnabled?: boolean
  defaultEmail?: string | null
  webhookEnabled?: boolean
  webhookUrl?: string | null
  signingSecretConfigured?: boolean
  updatedAt?: string | null
}

export interface HumanContactSettingsUpdate {
  enabled: boolean
  emailEnabled?: boolean
  defaultEmail?: string | null
  webhookEnabled?: boolean
  webhookUrl?: string | null
  signingSecret?: string | null
  rotateSigningSecret?: boolean
}

export interface HumanContactSigningSecretResponse {
  signingSecret: string | null
}

export type RetrievalInfo = ApiSchemas['RetrievalInfo']
export type SkillDiagnostic = NonNullable<ApiSchemas['RetrievalInfo']['skillDiagnostic']>
export type ParsedQueryInfo = ApiSchemas['ParsedQuery']
export type RetrievalSubqueryInfo = ApiSchemas['RetrievalSubquery']
export type CandidateCounts = ApiSchemas['CandidateCounts']
export type AppliedConstraintInfo = ApiSchemas['AppliedConstraint']
export type RetrievalTraceStage = ApiSchemas['RetrievalTraceStage']
export type RetrievalTraceLink = ApiSchemas['RetrievalTraceLink']
export type RetrievalTrace = ApiSchemas['RetrievalTrace']
export type ChatResponse = RelaxedAssistantChatResponse<ApiSchemas['AssistantChatResponse']>

export type AnswerFeedbackValue = 'up' | 'down'

export interface AnswerFeedbackEntry {
  id: string
  value: AnswerFeedbackValue
  comment: string | null
  actorType: 'authenticated_user' | 'api_token' | 'anonymous_user'
  actorId: string
  accountId: string | null
  userId: string | null
  anonymousSessionId: string | null
  createdAt: string
  updatedAt: string
}

export interface AnswerFeedbackState {
  value: AnswerFeedbackValue
  comment?: string | null
}

export interface ChatStreamConversation {
  conversationId: string
}

export interface ChatStreamChunk {
  text: string
}

export interface ChatStreamSuggestions {
  conversationId?: string
  suggestions?: ChatSuggestion[]
}

export interface ChatStreamCompletion {
  agentId?: string
  agentName?: string
  conversationId?: string
  assistantMessageId?: string
  route?: ChatResponse['route']
  answer?: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  suggestions?: ChatSuggestion[]
  retrievalInfo?: RetrievalInfo
  retrievalTrace?: RetrievalTrace
}

export type ChatConversationSummary = ApiSchemas['ChatConversationSummary']
export type ChatConversationTurnDebug = ApiSchemas['ChatConversationMessageDebug']
export type ChatConversationTurn = ApiSchemas['ChatConversationMessage'] & {
  answerFeedbackEntries?: AnswerFeedbackEntry[]
}
export type ChatConversationDetail = Omit<ApiSchemas['ChatConversationDetail'], 'messages'> & {
  messages: ChatConversationTurn[]
}

export interface ContactHistorySummary {
  id: string
  sortAt: string
  workspaceId: string
  conversationId: string
  assistantMessageId: string | null
  sourceChannel: string | null
  sourceOrigin: string | null
  userEmail: string
  messagePreview: string
  triggerSource: string
  triggerReason: string | null
  status: 'pending' | 'delivering' | 'delivered' | 'failed'
  attempts: number
  createdAt: string
  updatedAt: string
}

export interface ContactHistoryDetail extends ContactHistorySummary {
  message: string
  finalDeliveryError: string | null
}

export interface ContactHistoryListResponse {
  contacts: ContactHistorySummary[]
  total: number
  nextCursor: null
  hasMore: boolean
}

export interface ContactHistoryDetailResponse {
  contact: ContactHistoryDetail
  conversation: ChatConversationDetail
}

export type ChatHistoryListResponse = ApiSchemas['ChatHistoryListResponse'] & {
  workspaceName?: string
  assistantBootstrapActive?: boolean
}

export type HistoryItem =
  | ApiSchemas['HistoryItem']
  | {
      kind: 'contact'
      id: string
      sortAt: string
      contact: ContactHistorySummary
    }

export interface HistoryItemsResponse {
  items: HistoryItem[]
  total: number
  nextCursor: null
  hasMore: boolean
}

type HistoryItemsApiResponse =
  | HistoryItemsResponse
  | ChatHistoryListResponse
  | DocumentSearchHistoryListResponse
  | ContactHistoryListResponse

const normalizeHistoryItemsResponse = (response: HistoryItemsApiResponse): HistoryItemsResponse => {
  if ('items' in response) {
    return response
  }

  if ('conversations' in response) {
    return {
      items: response.conversations.map((conversation) => {
        return {
          kind: 'chat',
          id: conversation.id,
          sortAt: conversation.updatedAt,
          conversation,
        }
      }),
      total: response.total,
      nextCursor: null,
      hasMore: response.hasMore,
    }
  }

  if ('contacts' in response) {
    return {
      items: response.contacts.map((contact) => {
        return {
          kind: 'contact',
          id: contact.id,
          sortAt: contact.sortAt,
          contact,
        }
      }),
      total: response.total,
      nextCursor: null,
      hasMore: response.hasMore,
    }
  }

  return {
    items: response.searches.map((search) => {
      return {
        kind: 'search',
        id: search.searchId,
        sortAt: search.createdAt,
        search,
      }
    }),
    total: response.total,
    nextCursor: null,
    hasMore: response.hasMore,
  }
}

export interface ChatStreamHandlers {
  onConversation?: (payload: ChatStreamConversation) => void
  onChunk?: (payload: ChatStreamChunk) => void
  onDone?: (payload: ChatStreamCompletion) => void
  onSuggestions?: (payload: ChatStreamSuggestions) => void
}

export type ErrorResponse = ApiSchemas['ErrorResponse'] & {
  error: ApiSchemas['ErrorResponse']['error'] & {
    retryAfterSeconds?: number
  }
}

// Workspace types
export type Workspace = ApiSchemas['Workspace']
export type AccountUserSummary = ApiSchemas['AccountUser']

export type AccountMembershipRole = AccountUserSummary['role']
export type AssignableAccountRole = Exclude<AccountMembershipRole, 'owner'>
export type WorkspaceGrantRole = ApiSchemas['WorkspaceGrant']['role']
export type AccountInvitationSummary = ApiSchemas['AccountInvitation']
export type WorkspaceGrantSummary = ApiSchemas['WorkspaceGrant']

export type SupportImpersonationSummary = ApiSchemas['SupportImpersonation']

export type AccountUsersResponse = ApiSchemas['AccountUsersResponse']
export type AccessibleAccountSummary = ApiSchemas['AccessibleAccount']
export type AccessibleAccountsResponse = ApiSchemas['AccessibleAccountsResponse']
export type CreateAccountInvitationResponse = ApiSchemas['CreateAccountInvitationResponse']
export type InvitationDetailsResponse = ApiSchemas['InvitationDetailsResponse']
export type WorkspaceRouteResolutionResponse = ApiSchemas['WorkspaceRouteResolutionResponse']
export type WorkspaceSummaryResponse = ApiSchemas['WorkspaceSummaryResponse']

// Workspace API
export const workspaceApi = {
  async list(): Promise<Workspace[]> {
    const response = await request<{ workspaces: Workspace[] }>("/workspace", {
      method: "GET",
    }, { withSession: true })
    return response.workspaces
  },

  async create(name: string): Promise<Workspace> {
    return request<Workspace>("/workspace", {
      method: "POST",
      body: JSON.stringify({ name }),
    }, { withSession: true })
  },

  async rename(workspaceId: string, name: string): Promise<Workspace> {
    return request<Workspace>(`/workspace/${workspaceId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }, { withSession: true })
  },

  async delete(workspaceId: string): Promise<void> {
    await request<void>(`/workspace/${workspaceId}`, {
      method: "DELETE",
    }, { withSession: true })
  },

  async resolve(workspaceKey: string): Promise<WorkspaceRouteResolutionResponse> {
    return request<WorkspaceRouteResolutionResponse>(`/workspace/resolve/${encodeURIComponent(workspaceKey)}`, {
      method: "GET",
    }, { withSession: true })
  },

  async getSummary(): Promise<WorkspaceSummaryResponse> {
    return request<WorkspaceSummaryResponse>("/workspace/summary", {
      method: "GET",
    }, { withApiToken: true })
  },
}

// Auth API
export const authApi = {
  async register(data: RegisterRequest): Promise<RegisterResponse> {
    return request<RegisterResponse>(AUTH_RECOVERY_ENABLED ? "/ee/auth/register" : "/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withSession: true })
  },

  async login(data: LoginRequest): Promise<LoginResponse> {
    return request<LoginResponse>(AUTH_RECOVERY_ENABLED ? "/ee/auth/login" : "/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withSession: true })
  },

  async getInvitation(invitationToken: string): Promise<InvitationDetailsResponse> {
    return request<InvitationDetailsResponse>(`/auth/invitations/${invitationToken}`, {
      method: 'GET',
    }, { withSession: true })
  },

  async acceptInvitation(invitationToken: string, data: RegisterRequest): Promise<LoginResponse> {
    return request<LoginResponse>(`/auth/invitations/${invitationToken}/accept`, {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withSession: true })
  }
}

// Settings API
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
          citationDisplayEnabled: payload.citationDisplayEnabled,
          answerSupportValidationEnabled: payload.answerSupportValidationEnabled,
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
  }
}

// Documents API
export const documentsApi = {
  async createDocument(data: DocumentCreateRequest): Promise<DocumentCreateResponse> {
    return request<DocumentCreateResponse>("/document/", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async getDocument(documentId: string): Promise<DocumentDetails> {
    return request<DocumentDetails>(`/document/${documentId}`, {
      method: "GET",
    }, { withApiToken: true })
  },

  async listDocuments(input?: { limit?: number; offset?: number; cursor?: string }): Promise<DocumentListResponse> {
    const searchParams = new URLSearchParams()
    if (input?.limit !== undefined) {
      searchParams.set('limit', String(input.limit))
    }
    if (input?.offset !== undefined) {
      searchParams.set('offset', String(input.offset))
    }
    if (input?.cursor !== undefined) {
      searchParams.set('cursor', input.cursor)
    }

    const query = searchParams.toString()
    return request<DocumentListResponse>(`/document/${query ? `?${query}` : ''}`, {
      method: "GET",
    }, { withApiToken: true })
  },

  async updateDocument(documentId: string, data: DocumentCreateRequest): Promise<DocumentCreateResponse> {
    return request<DocumentCreateResponse>(`/document/${documentId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async reprocessDocument(documentId: string): Promise<DocumentCreateResponse> {
    return request<DocumentCreateResponse>(`/document/${documentId}/reprocess`, {
      method: "POST",
    }, { withApiToken: true })
  },

  async deleteDocument(documentId: string): Promise<void> {
    await request<void>(`/document/${documentId}`, {
      method: "DELETE",
    }, { withApiToken: true })
  },

  async importDocument(file: File, title?: string): Promise<DocumentCreateResponse> {
    const formData = new FormData()
    formData.set("file", file)
    if (title?.trim()) {
      formData.set("title", title.trim())
    }

    return request<DocumentCreateResponse>("/document/import", {
      method: "POST",
      body: formData,
    }, { withApiToken: true })
  },

  async crawlWebsite(input: { url: string; limit?: number }): Promise<WebsiteCrawlEnqueueResponse> {
    return request<WebsiteCrawlEnqueueResponse>("/document/crawl", {
      method: "POST",
      body: JSON.stringify({
        url: input.url,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
    }, { withApiToken: true })
  },

  async listCrawlJobs(input?: { status?: WebsiteCrawlJobStatus; sinceMinutes?: number; limit?: number }): Promise<WebsiteCrawlJobListResponse> {
    const searchParams = new URLSearchParams()
    if (input?.status !== undefined) {
      searchParams.set('status', input.status)
    }
    if (input?.sinceMinutes !== undefined) {
      searchParams.set('sinceMinutes', String(input.sinceMinutes))
    }
    if (input?.limit !== undefined) {
      searchParams.set('limit', String(input.limit))
    }

    const query = searchParams.toString()
    return request<WebsiteCrawlJobListResponse>(`/document/crawl/jobs${query ? `?${query}` : ''}`, {
      method: "GET",
    }, { withApiToken: true })
  },

  async deleteCrawlJob(jobId: string): Promise<void> {
    await request<void>(`/document/crawl/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }, { withApiToken: true })
  },

  async searchDocuments(data: {
    query: string
    metadataFilter?: Record<string, string | number | boolean | null>
  }): Promise<DocumentSearchResponse> {
    return requestLongRunning<DocumentSearchResponse>('/api/document/search', {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async listSearchHistory(input?: { limit?: number; offset?: number; cursor?: string }): Promise<DocumentSearchHistoryListResponse> {
    const searchParams = new URLSearchParams()
    if (input?.limit !== undefined) {
      searchParams.set('limit', String(input.limit))
    }
    if (input?.offset !== undefined) {
      searchParams.set('offset', String(input.offset))
    }
    if (input?.cursor !== undefined) {
      searchParams.set('cursor', input.cursor)
    }

    const query = searchParams.toString()
    return request<DocumentSearchHistoryListResponse>(`/document/search/history${query ? `?${query}` : ''}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async getSearchHistory(searchId: string): Promise<DocumentSearchResponse> {
    return request<DocumentSearchResponse>(`/document/search/history/${searchId}`, {
      method: 'GET',
    }, { withApiToken: true })
  }
}

// Chat API
export const chatApi = {
  async createChatResponse(data: ChatRequest): Promise<ChatResponse> {
    return request<ChatResponse>("/assistant/chat", {
      method: "POST",
      body: JSON.stringify(toAssistantChatPayload(data)),
    }, { withApiToken: true })
  },

  async streamChatResponse(
    data: ChatRequest,
    handlers: ChatStreamHandlers = {},
  ): Promise<ChatResponse> {
    const headers = new Headers({
      "Content-Type": "application/json",
      Authorization: `Bearer ${await requireWorkspaceApiToken()}`,
    })
    const executeFetch = () => fetch(STREAMING_API_PATH, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers,
      body: JSON.stringify(toAssistantChatPayload(data)),
    })
    let response = await executeFetch()
    if (canRetryWithFreshWorkspaceToken(response) && await refreshWorkspaceApiToken(headers)) {
      response = await executeFetch()
    }

    if (!response.ok) {
      throw await buildError(response)
    }

    const contentType = response.headers.get("content-type") ?? ""

    if (!contentType.includes("text/event-stream")) {
      const payload = (await response.json()) as ChatResponse
      if (payload.conversationId) {
        handlers.onConversation?.({ conversationId: payload.conversationId })
      }
      if (payload.answer) {
        handlers.onChunk?.({ text: payload.answer })
      }
      handlers.onDone?.({
        conversationId: payload.conversationId,
        assistantMessageId: payload.assistantMessageId,
        agentId: payload.agentId,
        agentName: payload.agentName,
        route: payload.route,
        answer: payload.answer,
        citations: payload.citations,
        answerSegments: payload.answerSegments,
        suggestions: payload.suggestions,
        retrievalInfo: payload.retrievalInfo,
        retrievalTrace: payload.retrievalTrace,
      })
      return payload
    }

    return streamChatEvents(response, handlers)
  },

  async bootstrapConversation(
    data: Pick<ChatRequest, 'agentId' | 'stream' | 'bootstrapGreeting' | 'userExpectedLocale'>,
  ): Promise<ChatResponse | undefined> {
    return request<ChatResponse>('/assistant/chat', {
      method: 'POST',
      body: JSON.stringify(toAssistantChatPayload(data)),
    }, { withApiToken: true })
  },

  async listHistory(input?: { limit?: number; offset?: number }): Promise<HistoryItemsResponse> {
    const searchParams = new URLSearchParams()
    if (input?.limit !== undefined) {
      searchParams.set('limit', String(input.limit))
    }
    if (input?.offset !== undefined) {
      searchParams.set('offset', String(input.offset))
    }

    const query = searchParams.toString()
    const response = await request<HistoryItemsApiResponse>(`/history${query ? `?${query}` : ''}`, {
      method: 'GET',
    }, { withApiToken: true })

    return normalizeHistoryItemsResponse(response)
  },

  async listChatHistory(input?: { limit?: number; offset?: number; cursor?: string }): Promise<ChatHistoryListResponse> {
    const searchParams = new URLSearchParams()
    if (input?.limit !== undefined) {
      searchParams.set('limit', String(input.limit))
    }
    if (input?.offset !== undefined) {
      searchParams.set('offset', String(input.offset))
    }
    if (input?.cursor !== undefined) {
      searchParams.set('cursor', input.cursor)
    }

    const query = searchParams.toString()
    return request<ChatHistoryListResponse>(`/history/chat${query ? `?${query}` : ''}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async listSearchHistory(input?: { limit?: number; offset?: number; cursor?: string }): Promise<DocumentSearchHistoryListResponse> {
    const searchParams = new URLSearchParams()
    if (input?.limit !== undefined) {
      searchParams.set('limit', String(input.limit))
    }
    if (input?.offset !== undefined) {
      searchParams.set('offset', String(input.offset))
    }
    if (input?.cursor !== undefined) {
      searchParams.set('cursor', input.cursor)
    }

    const query = searchParams.toString()
    return request<DocumentSearchHistoryListResponse>(`/history/search${query ? `?${query}` : ''}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async listContactHistory(input?: { limit?: number; offset?: number }): Promise<ContactHistoryListResponse> {
    const searchParams = new URLSearchParams()
    if (input?.limit !== undefined) {
      searchParams.set('limit', String(input.limit))
    }
    if (input?.offset !== undefined) {
      searchParams.set('offset', String(input.offset))
    }

    const query = searchParams.toString()
    return request<ContactHistoryListResponse>(`/history/contact${query ? `?${query}` : ''}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async getHistoryConversation(
    conversationId: string,
    input?: { limit?: number; offset?: number; cursor?: string },
  ): Promise<ChatConversationDetail> {
    const searchParams = new URLSearchParams()
    if (input?.limit !== undefined) {
      searchParams.set('limit', String(input.limit))
    }
    if (input?.offset !== undefined) {
      searchParams.set('offset', String(input.offset))
    }
    if (input?.cursor !== undefined) {
      searchParams.set('cursor', input.cursor)
    }

    const query = searchParams.toString()
    return request<ChatConversationDetail>(`/history/chat/${conversationId}${query ? `?${query}` : ''}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async getSearchHistory(searchId: string): Promise<DocumentSearchResponse> {
    return request<DocumentSearchResponse>(`/history/search/${searchId}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async getContactHistory(
    requestId: string,
    input?: { limit?: number; offset?: number; cursor?: string },
  ): Promise<ContactHistoryDetailResponse> {
    const searchParams = new URLSearchParams()
    if (input?.limit !== undefined) {
      searchParams.set('limit', String(input.limit))
    }
    if (input?.offset !== undefined) {
      searchParams.set('offset', String(input.offset))
    }
    if (input?.cursor !== undefined) {
      searchParams.set('cursor', input.cursor)
    }

    const query = searchParams.toString()
    return request<ContactHistoryDetailResponse>(`/history/contact/${requestId}${query ? `?${query}` : ''}`, {
      method: 'GET',
    }, { withApiToken: true })
  },
}

export const humanContactApi = {
  async getSettings(): Promise<HumanContactAvailability> {
    return request<HumanContactAvailability>('/ee/contact/settings', {
      method: 'GET',
    }, { withApiToken: true })
  },

  async revealSigningSecret(): Promise<HumanContactSigningSecretResponse> {
    return request<HumanContactSigningSecretResponse>('/ee/contact/settings/signing-secret', {
      method: 'GET',
    }, { withApiToken: true })
  },

  async draft(input: { conversationId: string; assistantMessageId?: string }): Promise<HumanContactDraftResponse> {
    return request<HumanContactDraftResponse>('/ee/contact/draft', {
      method: 'POST',
      body: JSON.stringify(input),
    }, { withApiToken: true })
  },

  async submit(input: HumanContactSubmitInput): Promise<HumanContactSubmitResponse> {
    return request<HumanContactSubmitResponse>('/ee/contact/submit', {
      method: 'POST',
      body: JSON.stringify(input),
    }, { withApiToken: true })
  },

  async updateSettings(input: HumanContactSettingsUpdate): Promise<HumanContactAvailability> {
    return request<HumanContactAvailability>('/ee/contact/settings', {
      method: 'PUT',
      body: JSON.stringify(input),
    }, { withApiToken: true })
  },
}

// General Settings types
export type GeneralSettings = ApiSchemas['GeneralSettingsResponse']
export type AgentSettings = ApiSchemas['ConversationAgent']
export type AgentListResponse = ApiSchemas['AgentListResponse']
export type AgentSettingsUpdate = ApiSchemas['ConversationAgentRequest']

const agentToGeneralSettings = (agent: AgentSettings): GeneralSettings => ({
  anonymousChatEnabled: agent.surfaceSettings.anonymousChat.enabled,
  anonymousChatUrl: agent.surfaceSettings.anonymousChat.enabled && agent.surfaceSettings.anonymousChat.token && typeof window !== 'undefined'
      ? `${window.location.origin}/chat/${agent.surfaceSettings.anonymousChat.token}`
      : null,
  assistantName: agent.name,
  greetingInstruction: agent.greetingInstruction,
  assistantDefaultLocale: agent.assistantDefaultLocale,
  proactiveGreetingEnabled: agent.proactiveGreetingEnabled,
  assistantBootstrapActive: agent.assistantBootstrapActive,
  assistantLogoUrl: (() => {
    const token = agent.surfaceSettings.anonymousChat.token ?? agent.surfaceSettings.websiteEmbed.token
    return agent.logo && token && typeof window !== 'undefined'
      ? `${window.location.origin}/backend/api/v1/public/chat/${token}/assistant-logo`
      : null
  })(),
  websiteEmbedEnabled: agent.surfaceSettings.websiteEmbed.enabled,
  websiteEmbedToken: agent.surfaceSettings.websiteEmbed.token,
  websiteEmbedScriptUrl: typeof window !== 'undefined' ? `${window.location.origin}/embed-widget.js` : null,
  websiteEmbedSnippet: null,
  websiteEmbedAllowedOrigins: agent.surfaceSettings.websiteEmbed.allowedOrigins,
  websiteEmbedLauncherLabel: agent.surfaceSettings.websiteEmbed.launcherLabel,
  websiteEmbedLauncherPosition: agent.surfaceSettings.websiteEmbed.launcherPosition,
  websiteEmbedTheme: agent.surfaceSettings.websiteEmbed.theme,
  websiteEmbedCopy: agent.surfaceSettings.websiteEmbed.copy,
  websiteEmbedExpertOverrides: agent.surfaceSettings.websiteEmbed.expertOverrides,
})

const agentToAssistantBehaviorSettings = (agent: AgentSettings): AssistantBehaviorSettings => ({
  suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
  customInstruction: agent.customInstruction,
  theme: agent.theme,
})

const retrievalSettingsToAssistantBehaviorSettings = (settings: RetrievalSettings): AssistantBehaviorSettings => ({
  suggestedQuestionsEnabled: settings.suggestedQuestionsEnabled,
  customInstruction: settings.customInstruction,
  theme: {
    brand: '#0f172a',
    brandText: '#f8fafc',
    surface: '#ffffff',
    text: '#0f172a',
  },
})

export type WorkspaceTokenResponse = ApiSchemas['WorkspaceTokenResponse']

export interface RenameOrganizationResponse {
  accountId: string
  organizationName: string
}

export interface UsageLimitProfile {
  key: string
  displayName: string
  monthlyAnswerLimit: number | null
  storedDocumentLimit: number | null
  createdAt: string
  updatedAt: string
}

export interface AccountUsageSummary {
  accountId: string
  profile: UsageLimitProfile | null
  monthlyAnswers: {
    periodStart: string
    resetAt: string
    used: number
    limit: number | null
  }
  storedDocuments: {
    used: number
    limit: number | null
  }
}

// General Settings API
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
      theme: data.theme,
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

export const enterpriseUsageApi = {
  async getAccountUsage(input?: { period?: string }): Promise<AccountUsageSummary> {
    const searchParams = new URLSearchParams()
    if (input?.period) {
      searchParams.set('period', input.period)
    }
    const query = searchParams.toString()
    return request<AccountUsageSummary>(`/ee/usage-limits/me${query ? `?${query}` : ''}`, {
      method: 'GET',
    }, { withSession: true })
  },
}

export const accountApi = {
  async listAccounts(): Promise<AccessibleAccountsResponse> {
    return request<AccessibleAccountsResponse>('/account/accounts', {
      method: 'GET',
    }, { withSession: true })
  },

  async listUsers(): Promise<AccountUsersResponse> {
    return request<AccountUsersResponse>('/account/users', {
      method: 'GET',
    }, { withSession: true })
  },

  async createInvitation(email: string, role: AssignableAccountRole = 'member'): Promise<CreateAccountInvitationResponse> {
    return request<CreateAccountInvitationResponse>('/account/invitations', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }, { withSession: true })
  },

  async updateUserRole(membershipId: string, role: AssignableAccountRole): Promise<AccountUserSummary> {
    return request<AccountUserSummary>(`/account/users/${membershipId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }, { withSession: true })
  },

  async removeUser(membershipId: string): Promise<void> {
    await request<void>(`/account/users/${membershipId}`, {
      method: 'DELETE',
    }, { withSession: true })
  },

  async setWorkspaceGrant(workspaceId: string, userId: string, role: WorkspaceGrantRole): Promise<WorkspaceGrantSummary> {
    return request<WorkspaceGrantSummary>(`/account/workspaces/${workspaceId}/grants/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }, { withSession: true })
  },

  async removeWorkspaceGrant(workspaceId: string, userId: string): Promise<void> {
    await request<void>(`/account/workspaces/${workspaceId}/grants/${userId}`, {
      method: 'DELETE',
    }, { withSession: true })
  },

  async switchAccount(accountId: string, preferredWorkspaceId?: string): Promise<LoginResponse> {
    return request<LoginResponse>('/account/switch', {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        ...(preferredWorkspaceId ? { preferredWorkspaceId } : {}),
      }),
    }, { withSession: true })
  },

  async createOrganization(organizationName: string): Promise<LoginResponse> {
    return request<LoginResponse>('/account/accounts', {
      method: 'POST',
      body: JSON.stringify({ organizationName }),
    }, { withSession: true })
  },

  async renameOrganization(organizationName: string): Promise<RenameOrganizationResponse> {
    return request<RenameOrganizationResponse>('/account', {
      method: 'PATCH',
      body: JSON.stringify({ organizationName }),
    }, { withSession: true })
  },

  async getWorkspaceToken(workspaceId: string): Promise<WorkspaceTokenResponse> {
    const response = await request<WorkspaceTokenResponse>(`/account/workspaces/${workspaceId}/token`, {
      method: 'GET',
    }, { withSession: true })
    storeWorkspaceToken(workspaceId, response.token)
    return response
  },

  async rotateWorkspaceToken(workspaceId: string): Promise<WorkspaceTokenResponse> {
    const response = await request<WorkspaceTokenResponse>(`/account/workspaces/${workspaceId}/token/rotate`, {
      method: 'POST',
    }, { withSession: true })
    storeWorkspaceToken(workspaceId, response.token)
    return response
  },
}

export const answerFeedbackApi = {
  async submit(
    input: { assistantMessageId: string; value: AnswerFeedbackValue; comment?: string | null },
  ): Promise<AnswerFeedbackEntry> {
    return request<AnswerFeedbackEntry>(`/ee/answer-feedback/messages/${input.assistantMessageId}`, {
      method: 'PUT',
      body: JSON.stringify({
        value: input.value,
        comment: input.comment ?? undefined,
      }),
    }, { withApiToken: true })
  },

  async clear(assistantMessageId: string): Promise<{ cleared: boolean }> {
    return request<{ cleared: boolean }>(`/ee/answer-feedback/messages/${assistantMessageId}`, {
      method: 'DELETE',
    }, { withApiToken: true })
  },

  async submitPublic(
    token: string,
    input: { assistantMessageId: string; value: AnswerFeedbackValue; comment?: string | null },
  ): Promise<AnswerFeedbackEntry> {
    const response = await fetch(`${API_BASE}/ee/answer-feedback/public/chat/${encodeURIComponent(token)}/messages/${input.assistantMessageId}`, {
      method: 'PUT',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
      }),
      body: JSON.stringify({
        value: input.value,
        comment: input.comment ?? undefined,
      }),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)
    return response.json() as Promise<AnswerFeedbackEntry>
  },

  async clearPublic(token: string, assistantMessageId: string): Promise<{ cleared: boolean }> {
    const response = await fetch(`${API_BASE}/ee/answer-feedback/public/chat/${encodeURIComponent(token)}/messages/${assistantMessageId}`, {
      method: 'DELETE',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'X-Forwarded-Prefix': '/backend',
      }),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)
    return response.json() as Promise<{ cleared: boolean }>
  },
}

// Public Chat API (anonymous, cookie-based auth)
export const publicChatApi = {
  async createSession(
    token: string,
    data: {
      channel: 'anonymous_link' | 'website_embed'
      anonymousSessionId?: string | null
      pageContext?: WebsiteEmbedPageContext | null
    },
  ): Promise<PublicChatSessionResponse> {
    const response = await fetch(`${API_BASE}/public/chat/${token}/sessions`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
      },
      body: JSON.stringify({
        channel: data.channel,
        anonymousSessionId: data.anonymousSessionId ?? undefined,
        pageContext: data.pageContext,
      }),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    const session = await response.json() as PublicChatSessionResponse
    storePublicSessionToken(session.publicChatToken, session.publicSessionToken, session.expiresAt)
    storeEffectivePublicChatToken(token, session.publicChatToken)
    return session
  },

  async sendMessage(
    token: string,
    data: { message: string; stream: boolean; conversationId?: string; inputMetadata?: ChatUserInputMetadata; userExpectedLocale?: string; pageContext?: WebsiteEmbedPageContext | null },
  ): Promise<ChatResponse> {
    const response = await fetch(`${API_BASE}/public/chat/${token}`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
      }),
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)
    return response.json() as Promise<ChatResponse>
  },

  async streamMessage(
    token: string,
    data: { message: string; stream: boolean; conversationId?: string; inputMetadata?: ChatUserInputMetadata; userExpectedLocale?: string; pageContext?: WebsiteEmbedPageContext | null },
    handlers: ChatStreamHandlers = {},
  ): Promise<ChatResponse> {
    const response = await fetch(`${PUBLIC_CHAT_STREAMING_API_PATH}/${encodeURIComponent(token)}`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)

    const contentType = response.headers.get('content-type') ?? ''

    if (!contentType.includes('text/event-stream')) {
      const payload = (await response.json()) as ChatResponse
      if (payload.conversationId) {
        handlers.onConversation?.({ conversationId: payload.conversationId })
      }
      if (payload.answer) {
        handlers.onChunk?.({ text: payload.answer })
      }
      handlers.onDone?.({
        conversationId: payload.conversationId,
        assistantMessageId: payload.assistantMessageId,
        agentId: payload.agentId,
        agentName: payload.agentName,
        route: payload.route,
        answer: payload.answer,
        citations: payload.citations,
        answerSegments: payload.answerSegments,
        suggestions: payload.suggestions,
        retrievalInfo: payload.retrievalInfo,
        retrievalTrace: payload.retrievalTrace,
      })
      return payload
    }

    return streamChatEvents(response, handlers)
  },

  async bootstrapConversation(
    token: string,
    data: { stream: boolean; startConversation: true; userExpectedLocale?: string; pageContext?: WebsiteEmbedPageContext | null },
  ): Promise<ChatResponse | undefined> {
    const response = await fetch(`${API_BASE}/public/chat/${token}`, {
      method: 'POST',
      cache: 'no-store',
      headers: attachAnonymousSessionHeader(token, {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
      }),
      body: JSON.stringify(data),
      credentials: 'include',
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)

    if (response.status === 204) {
      return undefined
    }

    return response.json() as Promise<ChatResponse>
  },

  async listConversations(
    token: string,
    input?: { limit?: number; offset?: number; cursor?: string },
  ): Promise<ChatHistoryListResponse> {
    const searchParams = new URLSearchParams()
    if (input?.limit !== undefined) {
      searchParams.set('limit', String(input.limit))
    }
    if (input?.offset !== undefined) {
      searchParams.set('offset', String(input.offset))
    }
    if (input?.cursor !== undefined) {
      searchParams.set('cursor', input.cursor)
    }

    const query = searchParams.toString()
    const response = await fetch(`${API_BASE}/public/chat/${token}${query ? `?${query}` : ''}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'X-Forwarded-Prefix': '/backend',
      }),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)
    return response.json() as Promise<ChatHistoryListResponse>
  },

  async getConversationDetail(
    token: string,
    conversationId: string,
    input?: { limit?: number; offset?: number; cursor?: string },
  ): Promise<ChatConversationDetail> {
    const searchParams = new URLSearchParams()
    if (input?.limit !== undefined) {
      searchParams.set('limit', String(input.limit))
    }
    if (input?.offset !== undefined) {
      searchParams.set('offset', String(input.offset))
    }
    if (input?.cursor !== undefined) {
      searchParams.set('cursor', input.cursor)
    }

    const query = searchParams.toString()
    const response = await fetch(`${API_BASE}/public/chat/${token}/history/${conversationId}${query ? `?${query}` : ''}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'X-Forwarded-Prefix': '/backend',
      }),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)
    return response.json() as Promise<ChatConversationDetail>
  },

  async draftHumanContact(
    token: string,
    input: { conversationId: string; assistantMessageId?: string },
  ): Promise<HumanContactDraftResponse> {
    const response = await fetch(`${API_BASE}/ee/contact/public/chat/${encodeURIComponent(token)}/draft`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
      }),
      body: JSON.stringify(input),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    return response.json() as Promise<HumanContactDraftResponse>
  },

  async submitHumanContact(
    token: string,
    input: HumanContactSubmitInput,
  ): Promise<HumanContactSubmitResponse> {
    const response = await fetch(`${API_BASE}/ee/contact/public/chat/${encodeURIComponent(token)}/submit`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
      }),
      body: JSON.stringify(input),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    return response.json() as Promise<HumanContactSubmitResponse>
  },

}
