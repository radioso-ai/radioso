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
  storePublicSessionToken,
  storeWorkspaceToken,
} from './api-client'
import { streamChatEvents } from './api-chat-stream'
import { AUTH_RECOVERY_ENABLED } from './enterprise-features'

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
  readStoredPublicSessionToken,
  removeWorkspaceToken,
  seedWorkspaceSession,
  setPendingAccountSwitchId,
  storeEmbedBootstrapSession,
  storePublicSessionToken,
} from './api-client'

// Types based on OpenAPI schema
export interface RegisterRequest {
  email: string
  password: string
  organizationName?: string
}

export interface RegisterResponse {
  userId: string
  accountId: string
  organizationName: string
  workspaceId: string
  workspaceName: string
  workspacePublicRouteKey: string
  requiresEmailVerification?: boolean
}

export interface LoginRequest {
  email: string
  password: string
  preferredWorkspaceId?: string
  preferredAccountId?: string
}

export interface LoginResponse {
  userId: string
  accountId: string
  organizationName: string
  workspaceId: string
  workspaceName: string
  workspacePublicRouteKey: string
}

export interface RetrievalSettings {
  queryRewriteEnabled: boolean
  semanticRewriteInstructions: string
  lexicalRewriteInstructions: string
  conversationMode: 'factual' | 'guided' | 'exploratory'
  suggestedQuestionsEnabled: boolean
  suggestedQuestionsCount: number
  rerankEnabled: boolean
  vectorTopK: number
  similarityThreshold: number
  rerankTopK: number
  citationDisplayEnabled: boolean
  answerSupportValidationEnabled: boolean
  metadataFieldSuggestions: MetadataFieldSuggestion[]
  metadataRules: RetrievalMetadataRule[]
  customInstruction: string
}

export interface PlatformSettings {
  assistant: {
    assistantName: string
    greetingInstruction: string
    assistantDefaultLocale: string | null
    proactiveGreetingEnabled: boolean
    assistantBootstrapActive: boolean
    conversationMode: RetrievalSettings['conversationMode']
    suggestedQuestionsEnabled: boolean
    suggestedQuestionsCount: number
    customInstruction: string
  }
  retrieval: Omit<RetrievalSettings, 'conversationMode' | 'suggestedQuestionsEnabled' | 'suggestedQuestionsCount' | 'customInstruction'>
  channels: {
    anonymousChatEnabled: boolean
    anonymousChatUrl: string | null
    anonymousRateLimit: number
    websiteEmbedEnabled?: boolean
    websiteEmbedToken?: string | null
    websiteEmbedScriptUrl?: string | null
    websiteEmbedSnippet?: string | null
    websiteEmbedAllowedOrigins?: string[]
    websiteEmbedLauncherLabel?: string
    websiteEmbedLauncherIcon?: 'chat' | 'sparkles' | 'message'
    websiteEmbedLauncherPosition?: 'bottom-right' | 'bottom-left'
  }
}

export type RetrievalMetadataValueType = 'string' | 'number' | 'date' | 'boolean'

export interface MetadataFieldSuggestion {
  field: string
  inferredType: RetrievalMetadataValueType
}

export type RetrievalMetadataRuleOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'

export type RetrievalMetadataRuleEffect = 'boost' | 'filter'
export type RetrievalMetadataRuleCombinator = 'and' | 'or'

export interface RetrievalMetadataCondition {
  id: string
  field: string
  valueType: RetrievalMetadataValueType
  operator: RetrievalMetadataRuleOperator
  value: string
}

export interface IngestionSettings {
  workspaceId: string
  chunkingStrategy: 'fixed_window' | 'structured_semantic'
  fixedWindowChunkSize: number
  fixedWindowChunkOverlap: number
  structuredMinChunkSize: number
  structuredMaxChunkSize: number
  createdAt: string
  updatedAt: string
}

export interface WorkspaceIngestionReprocessResponse {
  workspaceId: string
  queuedDocumentCount: number
  skippedDocumentCount: number
  status: 'queued' | 'noop'
}

export interface RetrievalMetadataRule {
  id: string
  field: string
  valueType: RetrievalMetadataValueType
  operator: RetrievalMetadataRuleOperator
  value: string
  combinator?: RetrievalMetadataRuleCombinator
  conditions?: RetrievalMetadataCondition[]
  effect: RetrievalMetadataRuleEffect
  enabled: boolean
  triggerMode: 'always_on' | 'match_turn'
  triggerInstruction?: string
}

export interface DocumentCreateRequest {
  title: string
  content: string
  metadata?: Record<string, string | number | boolean | null>
}

export interface DocumentCreateResponse {
  documentId: string
  status: 'queued' | 'processing' | 'ready' | 'failed'
}

export interface DocumentSummary {
  id: string
  title: string
  status: string
  ragStatus: 'processed' | 'pending'
  failureReason?: string | null
  createdAt: string
  updatedAt: string
  metadata: Record<string, string | number | boolean | null>
  sourceKind: 'inline_text' | 'uploaded_file'
  sourceFilename?: string | null
  sourceMimeType?: string | null
}

export interface DocumentDetails extends DocumentSummary {
  content: string
}

export interface DocumentListResponse {
  documents: DocumentSummary[]
  total: number
  nextCursor: string | null
  hasMore: boolean
}

export interface DocumentSearchAction {
  type: 'open_document' | 'inspect_match_evidence' | 'open_history_entry' | 'rerun_search'
  status: 'available' | 'unavailable'
}

export interface DocumentSearchResult {
  documentId: string
  title: string
  status: string
  ragStatus: 'processed' | 'pending'
  metadata: Record<string, unknown>
  score: number
  rank: number
  matchEvidence: string[]
  sourceKind: 'inline_text' | 'uploaded_file'
  sourceFilename?: string | null
  sourceMimeType?: string | null
  actions: DocumentSearchAction[]
}

export interface DocumentSearchResponse {
  searchId: string
  mode: 'live' | 'snapshot'
  query: string
  resultCount: number
  results: DocumentSearchResult[]
  retrievalTrace?: RetrievalTrace
}

export interface DocumentSearchHistoryEntry {
  searchId: string
  query: string
  createdAt: string
  resultCount: number
  traceAvailable: boolean
  previewTopTitles: string[]
}

export interface DocumentSearchHistoryListResponse {
  searches: DocumentSearchHistoryEntry[]
  total: number
  nextCursor: string | null
  hasMore: boolean
}

export interface ChatRequest {
  query?: string
  stream: boolean
  conversationId?: string
  bootstrapGreeting?: boolean
  userExpectedLocale?: string
  inputMetadata?: ChatUserInputMetadata
}

export interface WebsiteEmbedPageContext {
  pageUrl?: string | null
  pageTitle?: string | null
  pageLocale?: string | null
  browserLocale?: string | null
  content?: string | null
}

export interface PublicChatSessionResponse {
  workspaceName: string
  publicChatToken: string
  publicSessionId: string
  publicSessionToken: string
  assistantBootstrapActive: boolean
  actions?: Record<string, unknown>
  expiresAt: string
}

const toAssistantChatPayload = (data: ChatRequest) => ({
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
  conversationMode: settings.assistant.conversationMode,
  suggestedQuestionsEnabled: settings.assistant.suggestedQuestionsEnabled,
  suggestedQuestionsCount: settings.assistant.suggestedQuestionsCount,
  customInstruction: settings.assistant.customInstruction,
})

const toGeneralSettings = (settings: PlatformSettings): GeneralSettings => ({
  ...settings.channels,
  assistantName: settings.assistant.assistantName,
  greetingInstruction: settings.assistant.greetingInstruction,
  assistantDefaultLocale: settings.assistant.assistantDefaultLocale,
  proactiveGreetingEnabled: settings.assistant.proactiveGreetingEnabled,
  assistantBootstrapActive: settings.assistant.assistantBootstrapActive,
})

export interface ChatUserInputMetadata {
  method: 'typed' | 'suggestion_click'
  suggestionSourceMessageId?: string
}

export interface Citation {
  documentId: string
  chunkId: string
  title?: string
}

export interface AnswerSegment {
  text: string
  citationIndices?: number[]
}

export type ChatSuggestionKind = string

export interface ChatSuggestion {
  text: string
  citation?: Citation
  kind?: ChatSuggestionKind
  action?: {
    kind: string
    payload?: Record<string, unknown>
  }
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

export interface RetrievalInfo {
  execution?: {
    surface: 'assistant' | 'retrieval' | 'mcp_capability'
    path:
      | 'assistant_direct'
      | 'assistant_retrieval'
      | 'retrieval_search'
      | 'retrieval_answer'
      | 'mcp_grounded_answer'
    retrievalInvoked: boolean
  }
  parsedQuery?: ParsedQueryInfo
  retrievalSubqueries?: RetrievalSubqueryInfo[]
  responseLanguagePolicy?: 'match_user_question'
  candidateCounts: CandidateCounts
  appliedConstraints?: AppliedConstraintInfo[]
  fallbackApplied: boolean
  rerankStatus: 'skipped' | 'applied' | 'fallback'
  rewrite?: {
    status: 'skipped' | 'applied' | 'fallback' | 'rejected'
    eligible: boolean
    ran: boolean
    materialDisagreement: boolean
    continuityDecision?: string
    rejectionReason?: string
    fallbackReason?: string
  }
  triggerAnalysis?: {
    status: 'skipped_not_configured' | 'skipped_unavailable' | 'applied' | 'fallback'
    consideredRules: Array<{
      ruleId: string
      matched: boolean
      matchStrength: number
      reason: string
      triggerInstructionPreview: string
    }>
    matchedRuleIds: string[]
    unmatchedRuleIds: string[]
    matchCount: number
    matcherVersion: string
    failureReason?: string
  }
  triggerBackoff?: {
    applied: boolean
    reason?: 'empty_filtered_candidates' | 'weak_filtered_support'
    relaxedRuleIds: string[]
    restoredCandidateCount?: number
  }
}

export interface ParsedQueryInfo {
  originalQuery: string
  semanticQuery: string
  lexicalQuery: string
  constraintSummary: string[]
}

export interface RetrievalSubqueryInfo {
  id: string
  label: string
  semanticQuery: string
  lexicalQuery: string
  reason?: string
  responseLanguagePolicy?: 'match_user_question'
}

export interface CandidateCounts {
  semantic: number
  lexical: number
  merged: number
  final: number
}

export interface AppliedConstraintInfo {
  signalKey: 'document_date' | 'document_period' | 'document_amount' | 'document_location'
  mode: 'boost_only' | 'hard_filter'
  outcome: 'applied' | 'relaxed' | 'skipped'
  summary: string
}

export interface RetrievalTraceStage {
  stageId: string
  kind: string
  label: string
  status: 'applied' | 'skipped' | 'fallback' | 'rejected' | 'unavailable' | 'failed'
  startedAt?: string
  durationMs?: number
  settings?: Record<string, unknown>
  inputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
  metrics?: Record<string, number>
  reason?: string
}

export interface RetrievalTraceLink {
  fromStageId: string
  toStageId: string
  kind: 'sequence' | 'branch' | 'converge'
}

export interface RetrievalTrace {
  traceId: string
  startedAt: string
  completedAt?: string
  totalDurationMs?: number
  stages: RetrievalTraceStage[]
  links: RetrievalTraceLink[]
  summary?: RetrievalInfo & {
    retrievalSubqueries?: RetrievalSubqueryInfo[]
  }
}

export interface ChatResponse {
  conversationId?: string
  route?: {
    type: 'direct' | 'retrieval'
    reason: 'assistant_identity' | 'conversation_start' | 'evidence_required' | 'social_only'
  }
  answer: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  suggestions?: ChatSuggestion[]
  conversationMode: 'factual' | 'guided' | 'exploratory'
  conversationModeMetadata: {
    conversationMode: 'factual' | 'guided' | 'exploratory'
    brevityOverrideApplied: boolean
    expansionApplied: boolean
    expansionKind: 'none' | 'focused' | 'expansive'
    suggestionCount: number
    followUpQuestionApplied: boolean
  }
  retrievalInfo: RetrievalInfo
  retrievalTrace: RetrievalTrace
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
  conversationModeMetadata?: ChatResponse['conversationModeMetadata']
}

export interface ChatStreamCompletion {
  conversationId?: string
  route?: ChatResponse['route']
  answer?: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  suggestions?: ChatSuggestion[]
  conversationMode?: 'factual' | 'guided' | 'exploratory'
  conversationModeMetadata?: {
    conversationMode: 'factual' | 'guided' | 'exploratory'
    brevityOverrideApplied: boolean
    expansionApplied: boolean
    expansionKind: 'none' | 'focused' | 'expansive'
    suggestionCount: number
    followUpQuestionApplied: boolean
  }
  retrievalInfo?: RetrievalInfo
  retrievalTrace?: RetrievalTrace
}

export interface ChatConversationSummary {
  id: string
  sourceChannel: string | null
  sourceOrigin: string | null
  anonymousSessionId: string | null
  createdAt: string
  updatedAt: string
  messageCount: number
  userMessageCount: number
  assistantMessageCount: number
  preview: string | null
}

export interface ChatConversationTurnDebug {
  eventStatus: 'success' | 'failure'
  recordedAt: string
  stream: boolean
  citationCount: number
  answerOutcome?: 'grounded_success' | 'grounded_degraded_unsupported_segments' | 'no_context_refusal'
  conversationMode?: 'factual' | 'guided' | 'exploratory'
  conversationModeMetadata?: {
    conversationMode: 'factual' | 'guided' | 'exploratory'
    brevityOverrideApplied: boolean
    expansionApplied: boolean
    expansionKind: 'none' | 'focused' | 'expansive'
    suggestionCount: number
    followUpQuestionApplied: boolean
  }
  validation?: {
    ran: boolean
    answerModified: boolean
    unsupportedSegmentCount: number
    substantiveUnsupportedSegmentCount: number
    supportedSegmentCount: number
    nonSubstantiveSegmentCount: number
    hiddenSupportUsed?: boolean
    hiddenSupportKindsUsed?: Array<'assistant_name'>
    segmentResults: Array<{
      originalText?: string
      text: string
      disposition: 'supported' | 'unsupported' | 'non_substantive'
      replacementApplied: boolean
      reason: string
      citationIndices?: number[]
    }>
  }
  retrievalInfo?: RetrievalInfo
  retrievalTrace?: RetrievalTrace
  route?: {
    generator: string
    routeType: 'direct' | 'retrieval'
    routeReason: string
    retrievalInvoked: boolean
  }
  errorMessage?: string | null
}

export interface ChatConversationTurn {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  inputMetadata?: ChatUserInputMetadata
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  suggestions?: ChatSuggestion[]
  debug?: ChatConversationTurnDebug
}

export interface ChatConversationDetail {
  conversationId: string
  workspaceId: string
  sourceChannel: string | null
  sourceOrigin: string | null
  createdAt: string
  updatedAt: string
  messageCount: number
  userMessageCount: number
  assistantMessageCount: number
  messagesTotal: number
  messageWindowOffset: number
  messageWindowLimit: number
  hasOlderMessages: boolean
  nextCursor: string | null
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

export interface ChatHistoryListResponse {
  workspaceName?: string
  assistantBootstrapActive?: boolean
  conversations: ChatConversationSummary[]
  total: number
  nextCursor: string | null
  hasMore: boolean
}

export type HistoryItem =
  | {
      kind: 'chat'
      id: string
      sortAt: string
      conversation: ChatConversationSummary
    }
  | {
      kind: 'search'
      id: string
      sortAt: string
      search: DocumentSearchHistoryEntry
    }
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

export interface ErrorResponse {
  error: {
    code: string
    message: string
    retryAfterSeconds?: number
  }
}

// Workspace types
export interface Workspace {
  id: string
  accountId: string
  name: string
  publicRouteKey: string
  createdAt: string
  updatedAt: string
}

export interface AccountUserSummary {
  membershipId: string
  userId: string
  email: string
  role: 'owner' | 'member'
  status: 'active'
  createdAt: string
}

export interface AccountInvitationSummary {
  id: string
  email: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  expiresAt: string
  acceptedAt: string | null
  createdAt: string
}

export interface AccountUsersResponse {
  accountId: string
  currentUserId: string
  users: AccountUserSummary[]
  invitations: AccountInvitationSummary[]
}

export interface AccessibleAccountSummary {
  accountId: string
  organizationName: string
  role: 'owner' | 'member'
  workspaceId: string
  workspaceName: string
  workspacePublicRouteKey: string
}

export interface AccessibleAccountsResponse {
  currentAccountId: string
  accounts: AccessibleAccountSummary[]
}

export interface CreateAccountInvitationResponse extends AccountInvitationSummary {
  acceptanceUrl: string
}

export interface InvitationDetailsResponse {
  accountId: string
  email: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  expiresAt: string
}

export interface WorkspaceRouteResolutionResponse {
  workspaceKey: string
  workspaceId: string
  workspaceName: string
  accountId: string
  organizationName: string
}

export interface WorkspaceSummaryResponse {
  documentCount: number
  readyDocumentCount: number
  pendingDocumentCount: number
  sampleDocumentCount: number
  sampleDocumentSlugs: string[]
  conversationCount: number
  hasDocuments: boolean
  hasPendingDocuments: boolean
  hasReadyDocuments: boolean
  hasCompletedChat: boolean
  sampleDocumentsImported: boolean
}

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
  async getRetrievalSettings(): Promise<RetrievalSettings> {
    const settings = await request<PlatformSettings>("/settings", {
      method: "GET",
    }, { withApiToken: true })
    return toRetrievalSettings(settings)
  },

  async updateRetrievalSettings(data: RetrievalSettings): Promise<RetrievalSettings> {
    const { metadataFieldSuggestions, ...payload } = data
    void metadataFieldSuggestions
    const settings = await request<PlatformSettings>("/settings", {
      method: "PUT",
      body: JSON.stringify({
        assistant: {
          conversationMode: payload.conversationMode,
          suggestedQuestionsEnabled: payload.suggestedQuestionsEnabled,
          suggestedQuestionsCount: payload.suggestedQuestionsCount,
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
    }, { withApiToken: true })
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
        route: payload.route,
        answer: payload.answer,
        citations: payload.citations,
        answerSegments: payload.answerSegments,
        suggestions: payload.suggestions,
        conversationMode: payload.conversationMode,
        conversationModeMetadata: payload.conversationModeMetadata,
        retrievalInfo: payload.retrievalInfo,
        retrievalTrace: payload.retrievalTrace,
      })
      return payload
    }

    return streamChatEvents(response, handlers)
  },

  async bootstrapConversation(
    data: Pick<ChatRequest, 'stream' | 'bootstrapGreeting' | 'userExpectedLocale'>,
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
export interface GeneralSettings {
  anonymousChatEnabled: boolean
  anonymousChatUrl: string | null
  anonymousRateLimit: number
  assistantName: string
  greetingInstruction: string
  assistantDefaultLocale: string | null
  proactiveGreetingEnabled: boolean
  assistantBootstrapActive: boolean
  websiteEmbedEnabled?: boolean
  websiteEmbedToken?: string | null
  websiteEmbedScriptUrl?: string | null
  websiteEmbedSnippet?: string | null
  websiteEmbedAllowedOrigins?: string[]
  websiteEmbedLauncherLabel?: string
  websiteEmbedLauncherIcon?: 'chat' | 'sparkles' | 'message'
  websiteEmbedLauncherPosition?: 'bottom-right' | 'bottom-left'
}

export interface WorkspaceTokenResponse {
  token: string
}

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
  async getGeneralSettings(): Promise<GeneralSettings> {
    const settings = await request<PlatformSettings>('/settings', {
      method: 'GET',
    }, { withApiToken: true })
    return toGeneralSettings(settings)
  },

  async updateGeneralSettings(data: {
    anonymousChatEnabled?: boolean
    anonymousRateLimit?: number
    rotateAnonymousChatToken?: boolean
    assistantName?: string
    greetingInstruction?: string
    assistantDefaultLocale?: string | null
    proactiveGreetingEnabled?: boolean
    websiteEmbedEnabled?: boolean
    rotateWebsiteEmbedToken?: boolean
    websiteEmbedToken?: string | null
    websiteEmbedScriptUrl?: string | null
    websiteEmbedSnippet?: string | null
    websiteEmbedAllowedOrigins?: string[]
    websiteEmbedLauncherLabel?: string
    websiteEmbedLauncherIcon?: 'chat' | 'sparkles' | 'message'
    websiteEmbedLauncherPosition?: 'bottom-right' | 'bottom-left'
  }): Promise<GeneralSettings> {
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
          anonymousRateLimit: data.anonymousRateLimit,
          rotateAnonymousChatToken: data.rotateAnonymousChatToken,
          websiteEmbedEnabled: data.websiteEmbedEnabled,
          rotateWebsiteEmbedToken: data.rotateWebsiteEmbedToken,
          websiteEmbedAllowedOrigins: data.websiteEmbedAllowedOrigins,
          websiteEmbedLauncherLabel: data.websiteEmbedLauncherLabel,
          websiteEmbedLauncherIcon: data.websiteEmbedLauncherIcon,
          websiteEmbedLauncherPosition: data.websiteEmbedLauncherPosition,
        },
      }),
    }, { withApiToken: true })
    return toGeneralSettings(settings)
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

  async createInvitation(email: string): Promise<CreateAccountInvitationResponse> {
    return request<CreateAccountInvitationResponse>('/account/invitations', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }, { withSession: true })
  },

  async removeUser(membershipId: string): Promise<void> {
    await request<void>(`/account/users/${membershipId}`, {
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
        route: payload.route,
        answer: payload.answer,
        citations: payload.citations,
        answerSegments: payload.answerSegments,
        suggestions: payload.suggestions,
        conversationMode: payload.conversationMode,
        conversationModeMetadata: payload.conversationModeMetadata,
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
