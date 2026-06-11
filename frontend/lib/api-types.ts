import type { components } from '../../typescript-sdk/src/generated/types'
import { API_BASE } from './api-client'
import {
  readRetrievalSkillSettingsOverride,
  type AgentSkillSettingsMap,
  type RetrievalSkillSettingsOverride,
} from './retrieval-skill-settings'

type ApiSchemas = components['schemas']
type RelaxedAssistantChatResponse<T> = T extends unknown
  ? Omit<T, 'conversationId' | 'assistantMessageId' | 'route' | 'suggestions'> & {
      conversationId?: string
      assistantMessageId?: string
      route?: ApiSchemas['AssistantRoute']
      suggestions?: ChatSuggestion[]
      activitySummary?: ActivitySummary
      activityTrace?: ActivityTrace
    }
  : never
export type RegisterRequest = ApiSchemas['RegisterRequest']
export type RegisterResponse = ApiSchemas['RegisterResponse'] & {
  requiresEmailVerification?: boolean
}
export type LoginRequest = ApiSchemas['LoginRequest']
export type LoginResponse = ApiSchemas['LoginResponse']
export type AcceptedResponse = ApiSchemas['AcceptedResponse']
export type PasswordResetRequest = ApiSchemas['PasswordResetRequest']
export type PasswordResetConfirmRequest = ApiSchemas['PasswordResetConfirmRequest']
export type PasswordResetConfirmResponse = ApiSchemas['PasswordResetConfirmResponse']
export type EmailVerificationVerifyRequest = ApiSchemas['EmailVerificationVerifyRequest']
export type EmailVerificationVerifyResponse = ApiSchemas['EmailVerificationVerifyResponse']
export type EmailVerificationResendRequest = ApiSchemas['EmailVerificationResendRequest']

export type RetrievalDefaults = Omit<ApiSchemas['RetrievalDefaultsResponse'], 'metadataRules'> & {
  metadataRules: RetrievalMetadataRule[]
}

export type AgentChatModelOverride = NonNullable<ApiSchemas['ConversationAgent']['chatModelOverride']>
export type AgentContactRequestDelivery = ApiSchemas['AgentContactRequestDelivery']
export type DirectiveCondition = ApiSchemas['AuthoredDirectiveCondition']
export type Directive = ApiSchemas['AuthoredDirective']
export type BuiltInDirective = ApiSchemas['BuiltInDirective']
export type DirectiveCreateRequest = ApiSchemas['AuthoredDirectiveCreateRequest']
export type DirectiveUpdateRequest = ApiSchemas['AuthoredDirectiveUpdateRequest']
export type DirectiveCoherence = ApiSchemas['DirectiveCoherenceVerdict']
export type DirectiveMutationResponse = ApiSchemas['AuthoredDirectiveSaveResponse']
export type DirectiveListResponse = ApiSchemas['DirectiveListResponse']
export type DirectiveDraftRequest = ApiSchemas['DirectiveDraftRequest']
export type DirectiveDraftResponse = ApiSchemas['DirectiveDraftResponse']
export type DirectiveDraftDirective = ApiSchemas['DirectiveDraftDirective']

export type RoutineDefinitionStatus = 'draft' | 'published'
export type RoutineSlotType = 'text' | 'number' | 'boolean' | 'email' | 'date'
export type RoutineStepKind = 'chat' | 'tool' | 'fork' | 'action'
export type RoutineGuardKind = 'llm' | 'always' | 'fallback' | 'slot_filled' | 'outcome' | 'counter'
export type RoutineTerminalKind = 'complete' | 'handoff'
export type RoutineValidationCode =
  | 'unreachable_step'
  | 'missing_terminal'
  | 'dangling_action_reference'
  | 'dangling_step_reference'
  | 'missing_action_follow_up'
  | 'declared_unused_slot'
  | 'referenced_undeclared_slot'
  | 'unregistered_action_type'
  | 'action_capability_denied'
  | 'invalid_webhook_destination_ref'
  | 'unknown_webhook_destination'
  | 'attempt_limit_without_fallback'
  | 'outcome_guard_on_non_tool_step'
  | 'structured_guard_missing_parameter'
  | 'unsupported_tool_step'
  | 'completion_export_missing_destination'

export type RoutineValidationDiagnostic = {
  code: RoutineValidationCode
  location: string
  message: string
}
export type RoutineValidationResult = {
  ok: boolean
  diagnostics: RoutineValidationDiagnostic[]
}
export type RoutineSlot = Omit<ApiSchemas['RoutineDefinition']['slots'][number], 'type'> & { type: RoutineSlotType }
export type RoutineStep = Omit<ApiSchemas['RoutineDefinition']['steps'][number], 'kind'> & { kind: RoutineStepKind }
export type RoutineTransition = Omit<ApiSchemas['RoutineDefinition']['transitions'][number], 'guardKind'> & {
  guardKind: RoutineGuardKind
}
export type RoutineTerminal = Omit<ApiSchemas['RoutineDefinition']['terminals'][number], 'kind'> & {
  kind: RoutineTerminalKind
}
export type RoutineCompletionExport = NonNullable<ApiSchemas['RoutineDefinition']['completionExport']>
export type RoutineDefinitionDraft = {
  name: string
  activation: {
    triggerDescription: string
    gateRef?: string | null
    priority: number
  }
  slots: RoutineSlot[]
  steps: RoutineStep[]
  transitions: RoutineTransition[]
  terminals: RoutineTerminal[]
  completionExport?: RoutineCompletionExport
}
export type RoutineDefinition = RoutineDefinitionDraft & {
  id: string
  agentId: string
  version: number
  status: RoutineDefinitionStatus
  createdAt: string
  updatedAt: string
}
export type RoutineDefinitionListResponse = { routines: RoutineDefinition[] }
export type RoutineDefinitionGetResponse = { routine: RoutineDefinition }
export type RoutineDefinitionSaveResponse = {
  routine: RoutineDefinition
  validation: RoutineValidationResult
}
export type RoutineDefinitionValidateResponse = { validation: RoutineValidationResult }
export type RoutineDefinitionPublishRejectedResponse = {
  error: 'Routine definition is invalid'
  validation: RoutineValidationResult
}

export type WebhookDestination = ApiSchemas['WebhookDestination']
export type WebhookDestinationRequest = ApiSchemas['WebhookDestinationRequest']
export type WebhookDestinationListResponse = ApiSchemas['WebhookDestinationListResponse']
export type WebhookDestinationResponse = ApiSchemas['WebhookDestinationResponse']
export type WebhookDestinationCreateResponse = ApiSchemas['WebhookDestinationCreateResponse']

export type AssistantBehaviorSettings = Pick<
  RetrievalDefaults,
  'suggestedQuestionsEnabled' | 'customInstruction'
> & {
  assistantLinkUtmEnabled: boolean
  citationDisplayEnabled: boolean
  // Per-agent "contact a human" capability. Only meaningful in the per-agent
  // (assistant) settings; the workspace-level mapping leaves it undefined.
  contactRequestsEnabled?: boolean
  webhookExportsEnabled?: boolean
  contactRequestDelivery?: AgentContactRequestDelivery
  theme: WebsiteEmbedThemeSettings
  branding?: AgentBrandingSettings
  sourceScope?: AgentSourceScope
  chatModelOverride?: AgentChatModelOverride | null
  retrievalEnabled?: boolean
  skillSettings?: AgentSkillSettingsMap
  retrievalSkillSettings?: RetrievalSkillSettingsOverride
}

export type PlatformSettings = ApiSchemas['PlatformSettingsResponse']

export type GeneralSettings = ApiSchemas['GeneralSettingsResponse']
export type WebsiteEmbedThemeSettings = ApiSchemas['GeneralSettingsResponse']['websiteEmbedTheme']
export type AgentBrandingSettings = ApiSchemas['ConversationAgent']['branding']
export type WebsiteEmbedCopyPacks = ApiSchemas['GeneralSettingsResponse']['websiteEmbedCopy']
export type WebsiteEmbedExpertOverrides = ApiSchemas['GeneralSettingsResponse']['websiteEmbedExpertOverrides']

export type RetrievalMetadataRule = Omit<ApiSchemas['RetrievalMetadataRule'], 'combinator' | 'conditions'> &
  Partial<Pick<ApiSchemas['RetrievalMetadataRule'], 'combinator' | 'conditions'>>
export type RetrievalMetadataValueType = RetrievalMetadataRule['valueType']
export type MetadataFieldSuggestion = ApiSchemas['RetrievalDefaultsResponse']['metadataFieldSuggestions'][number]
export type RetrievalMetadataRuleOperator = RetrievalMetadataRule['operator']
export type RetrievalMetadataRuleEffect = RetrievalMetadataRule['effect']
export type RetrievalMetadataRuleCombinator = NonNullable<RetrievalMetadataRule['combinator']>
export type RetrievalMetadataCondition = NonNullable<RetrievalMetadataRule['conditions']>[number]

export type IngestionSettings = ApiSchemas['IngestionSettings']
export type WorkspaceIngestionReprocessResponse = ApiSchemas['WorkspaceIngestionReprocessResponse']
export type DocumentCreateRequest = ApiSchemas['DocumentCreateRequest']
export type DocumentCreateResponse = ApiSchemas['DocumentOperationResponse']
export type DocumentSourceSummary = ApiSchemas['DocumentSourceSummary']
export type DocumentSourceKind = DocumentSourceSummary['kind']
export type AgentSourceScope = ApiSchemas['AgentSourceScope']
export type DocumentSourceListItem = ApiSchemas['DocumentSourceListItem']
export type DocumentSourceListResponse = ApiSchemas['DocumentSourceListResponse']
export type DocumentSourceCrawlSettings = ApiSchemas['DocumentSourceCrawlSettings']
export type DocumentSummary = ApiSchemas['DocumentSummary']
export type DocumentDetails = ApiSchemas['DocumentDetails']
export type DocumentListResponse = ApiSchemas['DocumentListResponse']

export interface DocumentChunkSummary {
  id: string
  chunkIndex: number
  contentPreview: string
  contentLength: number
  startOffset: number
  endOffset: number
}

export interface DocumentChunkListResponse {
  documentId: string
  chunks: DocumentChunkSummary[]
}

export interface DocumentChunkDetail {
  id: string
  documentId: string
  workspaceId: string
  chunkIndex: number
  content: string
  searchText: string | null
  startOffset: number
  endOffset: number
  metadata: Record<string, unknown>
  createdAt: string
  embeddingDimensions: number | null
}

export type DocumentSearchAction = ApiSchemas['DocumentSearchAction']
export type DocumentSearchResult = ApiSchemas['DocumentSearchResult']
export type DocumentSearchResponse = ApiSchemas['DocumentSearchResponse'] & {
  activityTrace?: ActivityTrace
}
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
  includeDebug?: boolean
}

export type WebsiteEmbedPageContext = NonNullable<ApiSchemas['PublicChatSessionRequest']['pageContext']>
export interface PublicChatIntakeAction {
  skillName: string
  intentName?: string
  display?: SkillDisplayMetadata
}
export type PublicChatSessionResponse = ApiSchemas['PublicChatSessionResponse'] & {
  assistantLinkUtmEnabled?: boolean
  citationDisplayEnabled?: boolean
  intakeActions?: PublicChatIntakeAction[]
}

export const toAssistantChatPayload = (data: ChatRequest) => ({
  agentId: data.agentId,
  conversationId: data.conversationId,
  message: data.query,
  startConversation: data.bootstrapGreeting,
  stream: data.stream,
  includeDebug: data.includeDebug,
  userExpectedLocale: data.userExpectedLocale,
  inputMetadata: data.inputMetadata,
  sourceContext: {
    surface: 'authenticated_chat' as const,
  },
})

export const toGeneralSettings = (settings: PlatformSettings): GeneralSettings => ({
  ...settings.channels,
  assistantName: settings.assistant.assistantName,
  greetingInstruction: settings.assistant.greetingInstruction,
  assistantDefaultLocale: settings.assistant.assistantDefaultLocale,
  proactiveGreetingEnabled: settings.assistant.proactiveGreetingEnabled,
  assistantBootstrapActive: settings.assistant.assistantBootstrapActive,
  assistantLogoUrl: settings.assistant.assistantLogoUrl,
})

type GeneratedChatUserInputMetadata = NonNullable<
  Extract<ApiSchemas['AssistantChatRequest'], { inputMetadata?: unknown }>['inputMetadata']
>
export type ChatUserInputMetadata = Omit<GeneratedChatUserInputMetadata, 'method' | 'intent'> & {
  method: 'typed' | 'suggestion_click' | 'intent_click'
  intent?: PublicChatIntakeAction
}
export type Citation = ApiSchemas['Citation']
export type SkillDisplayMetadata = NonNullable<ApiSchemas['SkillCatalogEntry']['display']>
export type AnswerSegment = ApiSchemas['AnswerSegment']
export type ChatSuggestionKind = ApiSchemas['ChatSuggestion']['kind']
export type ChatSuggestion = Omit<ApiSchemas['ChatSuggestion'], 'kind'> & {
  kind?: ChatSuggestionKind
}

export type ActivitySummary = ApiSchemas['ActivitySummary']
export type SkillDiagnostic = NonNullable<ApiSchemas['ActivitySummary']['skillDiagnostic']>
export type ParsedQueryInfo = ApiSchemas['ParsedQuery']
export type RetrievalSubqueryInfo = ApiSchemas['RetrievalSubquery']
export type CandidateCounts = ApiSchemas['CandidateCounts']
export type AppliedConstraintInfo = ApiSchemas['AppliedConstraint']
export type ActivityStage = ApiSchemas['ActivityStage']
export type ActivityLink = ApiSchemas['ActivityLink']
export type ActivityTrace = ApiSchemas['ActivityTrace']
export type TurnTraceEnvelope = ApiSchemas['TurnTraceEnvelope']
export type ConversationTrace = ApiSchemas['ConversationTrace']
export type ConversationTraceStage = ApiSchemas['ConversationTraceStage']
export type CapabilitySubTrace = ApiSchemas['CapabilitySubTrace']
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

export type SkillStreamPhase = 'active' | 'completed' | 'failed'

export interface SkillReceiptField {
  name: string
  displayName: string
  value: string
}

export interface SkillReceipt {
  fields: SkillReceiptField[]
  statusLabel?: string
}

export interface SkillStreamPayload {
  skillName: string
  phase: SkillStreamPhase
  display?: SkillDisplayMetadata
  localizedTitle?: string
  receipt?: SkillReceipt
}

export interface ChatStreamSkill extends SkillStreamPayload {
  conversationId?: string
}

export interface ChatStreamCompletion {
  agentId?: string
  agentName?: string
  conversationId?: string
  assistantMessageId?: string
  answer?: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  suggestions?: ChatSuggestion[]
  debug?: ChatResponse['debug']
  skill?: SkillStreamPayload
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
  activitySummary?: ActivitySummary
}

export interface ContactHistoryDetail extends ContactHistorySummary {
  message: string
  finalDeliveryError: string | null
  activityTrace?: ActivityTrace
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
  assistantLinkUtmEnabled?: boolean
  citationDisplayEnabled?: boolean
  intakeActions?: PublicChatIntakeAction[]
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

export type HistoryItemsApiResponse =
  | HistoryItemsResponse
  | ChatHistoryListResponse
  | DocumentSearchHistoryListResponse
  | ContactHistoryListResponse

export const normalizeHistoryItemsResponse = (response: HistoryItemsApiResponse): HistoryItemsResponse => {
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
  onSkill?: (payload: ChatStreamSkill) => void
}

export type ErrorResponse = ApiSchemas['ErrorResponse'] & {
  error: ApiSchemas['ErrorResponse']['error'] & {
    retryAfterSeconds?: number
  }
}

export type Workspace = ApiSchemas['Workspace']
export type AccountUserSummary = ApiSchemas['AccountUser']

export type AccountMembershipRole = AccountUserSummary['role']
export type AssignableAccountRole = Exclude<AccountMembershipRole, 'owner'>
export type WorkspaceGrantRole = ApiSchemas['WorkspaceGrant']['role']
export type AccountInvitationSummary = ApiSchemas['AccountInvitation']
export type WorkspaceGrantSummary = ApiSchemas['WorkspaceGrant']
export type UsageTrendsResponse = ApiSchemas['UsageTrendsResponse']
export type UsageTrendBucket = ApiSchemas['UsageTrendBucket']


export type AccountUsersResponse = ApiSchemas['AccountUsersResponse']
export type AccessibleAccountSummary = ApiSchemas['AccessibleAccount']
export type AccessibleAccountsResponse = ApiSchemas['AccessibleAccountsResponse']
export type CreateAccountInvitationResponse = ApiSchemas['CreateAccountInvitationResponse']
export type InvitationDetailsResponse = ApiSchemas['InvitationDetailsResponse']
export type WorkspaceRouteResolutionResponse = ApiSchemas['WorkspaceRouteResolutionResponse']
export type WorkspaceSummaryResponse = ApiSchemas['WorkspaceSummaryResponse']

export type AgentSettings = ApiSchemas['ConversationAgent'] & {
  assistantLinkUtmEnabled: boolean
}
export type AgentListResponse = ApiSchemas['AgentListResponse']
export type AgentSettingsUpdate = ApiSchemas['ConversationAgentRequest'] & {
  assistantLinkUtmEnabled?: boolean
}
export type WorkspaceTokenResponse = ApiSchemas['WorkspaceTokenResponse']

const buildAgentAssistantLogoUrl = (agent: AgentSettings): string | null => {
  if (!agent.logo || typeof window === 'undefined') {
    return null
  }

  const publicChatToken = agent.surfaceSettings.anonymousChat.enabled
    ? agent.surfaceSettings.anonymousChat.token
    : agent.surfaceSettings.websiteEmbed.enabled
      ? agent.surfaceSettings.websiteEmbed.token
      : null

  if (!publicChatToken) {
    return null
  }

  const apiBaseUrl = new URL(API_BASE.endsWith('/') ? API_BASE : `${API_BASE}/`, window.location.origin)
  return new URL(`public/chat/${encodeURIComponent(publicChatToken)}/assistant-logo`, apiBaseUrl).toString()
}

export const agentToGeneralSettings = (agent: AgentSettings): GeneralSettings => ({
  anonymousChatEnabled: agent.surfaceSettings.anonymousChat.enabled,
  anonymousChatUrl: agent.surfaceSettings.anonymousChat.enabled && agent.surfaceSettings.anonymousChat.token && typeof window !== 'undefined'
      ? `${window.location.origin}/chat/${agent.surfaceSettings.anonymousChat.token}`
      : null,
  anonymousChatLastUsedAt: null,
  assistantName: agent.name,
  greetingInstruction: agent.greetingInstruction,
  assistantDefaultLocale: agent.assistantDefaultLocale,
  proactiveGreetingEnabled: agent.proactiveGreetingEnabled,
  assistantBootstrapActive: agent.assistantBootstrapActive,
  assistantLogoUrl: buildAgentAssistantLogoUrl(agent),
  websiteEmbedEnabled: agent.surfaceSettings.websiteEmbed.enabled,
  websiteEmbedToken: agent.surfaceSettings.websiteEmbed.token,
  websiteEmbedLastUsedAt: null,
  websiteEmbedScriptUrl: typeof window !== 'undefined' ? `${window.location.origin}/radioso-embed.js` : null,
  websiteEmbedSnippet: null,
  websiteEmbedAllowedOrigins: agent.surfaceSettings.websiteEmbed.allowedOrigins,
  websiteEmbedLauncherLabel: agent.surfaceSettings.websiteEmbed.launcherLabel,
  websiteEmbedLauncherPosition: agent.surfaceSettings.websiteEmbed.launcherPosition,
  websiteEmbedTheme: agent.surfaceSettings.websiteEmbed.theme,
  websiteEmbedCopy: agent.surfaceSettings.websiteEmbed.copy,
  websiteEmbedExpertOverrides: agent.surfaceSettings.websiteEmbed.expertOverrides,
})

export const agentToAssistantBehaviorSettings = (agent: AgentSettings): AssistantBehaviorSettings => ({
  suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
  customInstruction: agent.customInstruction,
  assistantLinkUtmEnabled: agent.assistantLinkUtmEnabled,
  citationDisplayEnabled: agent.citationDisplayEnabled,
  contactRequestsEnabled: agent.contactRequestsEnabled,
  webhookExportsEnabled: agent.webhookExportsEnabled,
  contactRequestDelivery: agent.contactRequestDelivery,
  theme: agent.theme,
  branding: agent.branding,
  sourceScope: agent.sourceScope,
  chatModelOverride: agent.chatModelOverride,
  retrievalEnabled: agent.retrievalEnabled,
  skillSettings: agent.skillSettings,
  retrievalSkillSettings: readRetrievalSkillSettingsOverride(agent.skillSettings),
})

export interface RenameOrganizationResponse {
  accountId: string
  organizationName: string
}

export interface UsageLimitProfile {
  key: string
  displayName: string
  monthlyAnswerLimit: number | null
  storedDocumentLimit: number | null
  storedIndexedByteLimit: number | null
  monthlyIndexedByteLimit: number | null
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
  storedIndexedBytes: {
    used: number
    limit: number | null
  }
  monthlyIndexedBytes: {
    periodStart: string
    resetAt: string
    used: number
    limit: number | null
  }
}
