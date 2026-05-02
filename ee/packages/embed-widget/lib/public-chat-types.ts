export interface StoredEmbedBootstrapSession {
  workspaceName?: string
  publicChatToken: string
  publicSessionId: string
  publicSessionToken: string
  expiresAt: string
}

export interface StoredPublicSessionToken {
  token: string
  expiresAt: string
}

export interface ErrorResponse {
  error: {
    code: string
    message: string
    retryAfterSeconds?: number
  }
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
  expiresAt: string
}

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

export type ChatSuggestionKind = 'deeper' | 'broader'

export interface ChatSuggestion {
  text: string
  citation?: Citation
  kind?: ChatSuggestionKind
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
  conversationId: string
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
  conversationMode?: ChatResponse['conversationMode']
  conversationModeMetadata?: ChatResponse['conversationModeMetadata']
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
  retrievalInfo?: RetrievalInfo
  retrievalTrace?: RetrievalTrace
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

export interface ChatHistoryListResponse {
  workspaceName?: string
  assistantBootstrapActive?: boolean
  conversations: ChatConversationSummary[]
  total: number
  nextCursor: string | null
  hasMore: boolean
}

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

export interface ChatStreamHandlers {
  onConversation?: (payload: ChatStreamConversation) => void
  onChunk?: (payload: ChatStreamChunk) => void
  onDone?: (payload: ChatStreamCompletion) => void
  onSuggestions?: (payload: ChatStreamSuggestions) => void
}
