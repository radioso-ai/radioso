const API_BASE = `${process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/backend/api/v1"}`;
const STREAMING_API_PATH = '/api/chat/stream'
const API_TOKEN_STORAGE_KEY = "radioso.apiToken";
const WORKSPACE_TOKENS_STORAGE_KEY = "radioso.workspaceTokens";
const ACTIVE_WORKSPACE_STORAGE_KEY = "radioso.activeWorkspaceId";
const WORKSPACE_HEADER = 'X-Workspace-Id'
const ANONYMOUS_SESSION_HEADER = 'X-Radioso-Anonymous-Session'
const ANONYMOUS_SESSION_STORAGE_PREFIX = 'radioso.anonymousSession.'
const EMBED_SESSION_HEADER = 'X-Radioso-Embed-Session'
const EMBED_SESSION_STORAGE_PREFIX = 'radioso.embedSession.'
const EMBED_BOOTSTRAP_STORAGE_PREFIX = 'radioso.embedBootstrap.'

interface StoredEmbedBootstrapSession {
  publicChatToken: string
  embedSessionToken: string
  expiresAt: string
}

interface StoredEmbedSessionToken {
  token: string
  expiresAt: string
}

export const activateWorkspaceToken = (workspaceId: string): boolean => {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
  }
  return true;
};

export const seedWorkspaceSession = (workspaceId: string, _token?: string) => {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
  }
};

export const getStoredActiveWorkspaceId = (): string | null => {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
};

export const clearWorkspaceStorage = () => {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(WORKSPACE_TOKENS_STORAGE_KEY);
  window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
};

export const removeWorkspaceToken = (workspaceId: string) => {
  if (typeof window === "undefined") return;
  if (getStoredActiveWorkspaceId() === workspaceId) {
    window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  }
};

const getAnonymousSessionStorageKey = (token: string) => `${ANONYMOUS_SESSION_STORAGE_PREFIX}${token}`
const getEmbedSessionStorageKey = (token: string) => `${EMBED_SESSION_STORAGE_PREFIX}${token}`
const getEmbedBootstrapStorageKey = (token: string) => `${EMBED_BOOTSTRAP_STORAGE_PREFIX}${token}`

const readAnonymousSessionId = (token: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  return window.sessionStorage.getItem(getAnonymousSessionStorageKey(token))
}

export const readStoredAnonymousSessionId = (token: string) => readAnonymousSessionId(token)

const readEmbedSessionToken = (token: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  const rawValue = window.sessionStorage.getItem(getEmbedSessionStorageKey(token))
  if (!rawValue) {
    return null
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<StoredEmbedSessionToken>
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'string') {
      window.sessionStorage.removeItem(getEmbedSessionStorageKey(token))
      return null
    }

    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      window.sessionStorage.removeItem(getEmbedSessionStorageKey(token))
      return null
    }

    return parsed.token
  } catch {
    window.sessionStorage.removeItem(getEmbedSessionStorageKey(token))
    return null
  }
}

export const readStoredEmbedSessionToken = (token: string) => readEmbedSessionToken(token)

export const readStoredEmbedBootstrapSession = (token: string): StoredEmbedBootstrapSession | null => {
  if (typeof window === 'undefined') {
    return null
  }

  const rawValue = window.sessionStorage.getItem(getEmbedBootstrapStorageKey(token))
  if (!rawValue) {
    return null
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<StoredEmbedBootstrapSession>
    if (
      typeof parsed.publicChatToken !== 'string' ||
      typeof parsed.embedSessionToken !== 'string' ||
      typeof parsed.expiresAt !== 'string'
    ) {
      window.sessionStorage.removeItem(getEmbedBootstrapStorageKey(token))
      return null
    }

    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      window.sessionStorage.removeItem(getEmbedBootstrapStorageKey(token))
      return null
    }

    return {
      publicChatToken: parsed.publicChatToken,
      embedSessionToken: parsed.embedSessionToken,
      expiresAt: parsed.expiresAt,
    }
  } catch {
    window.sessionStorage.removeItem(getEmbedBootstrapStorageKey(token))
    return null
  }
}

export const storeEmbedSessionToken = (
  token: string,
  sessionToken: string | null,
  expiresAt?: string,
) => {
  if (typeof window === 'undefined') {
    return
  }

  const storageKey = getEmbedSessionStorageKey(token)
  if (!sessionToken || !expiresAt) {
    window.sessionStorage.removeItem(storageKey)
    return
  }

  window.sessionStorage.setItem(storageKey, JSON.stringify({ token: sessionToken, expiresAt }))
}

export const storeEmbedBootstrapSession = (token: string, session: StoredEmbedBootstrapSession | null) => {
  if (typeof window === 'undefined') {
    return
  }

  const storageKey = getEmbedBootstrapStorageKey(token)
  if (!session) {
    window.sessionStorage.removeItem(storageKey)
    return
  }

  window.sessionStorage.setItem(storageKey, JSON.stringify(session))
  storeEmbedSessionToken(session.publicChatToken, session.embedSessionToken, session.expiresAt)
}

const writeAnonymousSessionId = (token: string, sessionId: string | null) => {
  if (typeof window === 'undefined') {
    return
  }

  const storageKey = getAnonymousSessionStorageKey(token)
  if (!sessionId) {
    window.sessionStorage.removeItem(storageKey)
    return
  }

  window.sessionStorage.setItem(storageKey, sessionId)
}

const attachAnonymousSessionHeader = (token: string, headers?: HeadersInit) => {
  const nextHeaders = new Headers(headers)
  const sessionId = readAnonymousSessionId(token)
  const embedSessionToken = readEmbedSessionToken(token)

  if (sessionId && !nextHeaders.has(ANONYMOUS_SESSION_HEADER)) {
    nextHeaders.set(ANONYMOUS_SESSION_HEADER, sessionId)
  }

  if (embedSessionToken && !nextHeaders.has(EMBED_SESSION_HEADER)) {
    nextHeaders.set(EMBED_SESSION_HEADER, embedSessionToken)
  }

  return nextHeaders
}

const persistAnonymousSessionHeader = (token: string, response: Response) => {
  const sessionId = response.headers.get(ANONYMOUS_SESSION_HEADER)
  if (sessionId) {
    writeAnonymousSessionId(token, sessionId)
  }
}

const buildError = async (response: Response): Promise<ErrorResponse> => {
  try {
    const payload = await response.json();
    if (
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object"
    ) {
      return payload as ErrorResponse;
    }

    if (
      payload &&
      typeof payload === "object" &&
      "code" in payload &&
      typeof payload.code === "string" &&
      "message" in payload &&
      typeof payload.message === "string"
    ) {
      return {
        error: {
          code: payload.code,
          message: payload.message,
          retryAfterSeconds:
            "retryAfterSeconds" in payload && typeof payload.retryAfterSeconds === "number"
              ? payload.retryAfterSeconds
              : undefined,
        },
      };
    }

    return {
      error: {
        code: "HTTP_ERROR",
        message: `Request failed with status ${response.status}`,
      },
    };
  } catch {
    return {
      error: {
        code: "HTTP_ERROR",
        message: `Request failed with status ${response.status}`,
      },
    };
  }
};

const request = async <T>(
  path: string,
  init: RequestInit = {},
  options: { withSession?: boolean; withApiToken?: boolean } = {},
): Promise<T> => {
  const headers = new Headers(init.headers);
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;

  if (!headers.has("Content-Type") && init.body && !isFormData) {
    headers.set("Content-Type", "application/json");
  }
  if (!headers.has("X-Forwarded-Prefix")) {
    headers.set("X-Forwarded-Prefix", "/backend");
  }

  if (options.withApiToken) {
    const workspaceId = getStoredActiveWorkspaceId();

    if (!workspaceId) {
      throw {
        error: {
          code: "UNAUTHORIZED",
          message: "Sign in again to continue.",
        },
      } satisfies ErrorResponse;
    }

    headers.set(WORKSPACE_HEADER, workspaceId);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers,
    credentials: options.withSession || options.withApiToken ? "include" : init.credentials,
  });

  if (!response.ok) {
    throw await buildError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
};

const requestLongRunning = async <T>(
  path: string,
  init: RequestInit = {},
  options: { withSession?: boolean; withApiToken?: boolean } = {},
): Promise<T> => {
  const headers = new Headers(init.headers);
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;

  if (!headers.has("Content-Type") && init.body && !isFormData) {
    headers.set("Content-Type", "application/json");
  }

  if (options.withApiToken) {
    const workspaceId = getStoredActiveWorkspaceId();

    if (!workspaceId) {
      throw {
        error: {
          code: "UNAUTHORIZED",
          message: "Sign in again to continue.",
        },
      } satisfies ErrorResponse;
    }

    headers.set(WORKSPACE_HEADER, workspaceId);
  }

  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers,
    credentials: options.withSession || options.withApiToken ? "include" : init.credentials,
  });

  if (!response.ok) {
    throw await buildError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
};

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
}

export interface RetrievalSettings {
  queryRewriteEnabled: boolean
  semanticRewriteInstructions: string
  lexicalRewriteInstructions: string
  answerSupportPolicy: 'strict' | 'warn' | 'off'
  conversationMode: 'factual' | 'guided' | 'exploratory'
  rerankEnabled: boolean
  vectorTopK: number
  similarityThreshold: number
  rerankTopK: number
  citationDisplayEnabled: boolean
  metadataFieldSuggestions: MetadataFieldSuggestion[]
  metadataRules: RetrievalMetadataRule[]
  customInstruction: string
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
  effect: RetrievalMetadataRuleEffect
  enabled: boolean
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

export interface RetrievalInfo {
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
  answer: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
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

export interface ChatStreamCompletion {
  conversationId?: string
  answer?: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
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
  answerSupportPolicy?: 'strict' | 'warn' | 'off'
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
    supportedSegmentCount: number
    nonSubstantiveSegmentCount: number
    answerSupportPolicy?: 'strict' | 'warn' | 'off'
    segmentResults: Array<{
      text: string
      disposition: 'supported' | 'unsupported' | 'non_substantive'
      replacementApplied: boolean
      reason: string
      citationIndices?: number[]
    }>
  }
  retrievalInfo?: RetrievalInfo
  retrievalTrace?: RetrievalTrace
  errorMessage?: string | null
}

export interface ChatConversationTurn {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
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

export type EvalExpectedRefusalBehavior = 'refusal' | 'answer'
export type EvalAnswerOutcome = 'grounded_success' | 'grounded_degraded_unsupported_segments' | 'no_context_refusal'
export type EvalComparisonOutcome = 'improved' | 'regressed' | 'unchanged' | 'unscored'

export interface EvalCaseConversationMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface EvalCaseExpectations {
  expectedDocumentIds?: string[]
  expectedCitationTitles?: string[]
  expectedRefusalBehavior?: EvalExpectedRefusalBehavior
  expectedAnswerOutcome?: EvalAnswerOutcome
  requiredPhrases?: string[]
  forbiddenPhrases?: string[]
  latencyBudgetMs?: number
}

export interface EvalDatasetSummary {
  id: string
  workspaceId: string
  name: string
  description: string
  status: 'active' | 'archived'
  createdByAccountId: string | null
  createdAt: string
  updatedAt: string
  caseCount: number
  runCount: number
  lastRunAt: string | null
}

export interface EvalImportDraft {
  title: string
  query: string
  conversationContext: EvalCaseConversationMessage[]
  sourceType: 'manual' | 'conversation_import'
  provenance: Record<string, unknown>
  seededExpectations: EvalCaseExpectations
  unavailable: string[]
}

export interface EvalCase {
  id: string
  datasetId: string
  workspaceId: string
  title: string
  sourceType: 'manual' | 'conversation_import'
  query: string
  conversationContext: EvalCaseConversationMessage[]
  expectations: EvalCaseExpectations
  provenance: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface EvalDimensionResult {
  verdict: 'pass' | 'fail' | 'unscored'
  expected?: unknown
  actual?: unknown
  reason?: string
}

export interface EvalCaseScore {
  documentMatch: EvalDimensionResult
  citationMatch: EvalDimensionResult
  refusalMatch: EvalDimensionResult
  answerOutcomeMatch: EvalDimensionResult
  answerContainsMatch: EvalDimensionResult
  latencyMatch: EvalDimensionResult
  overallVerdict: 'pass' | 'fail'
  reasons: string[]
}

export interface EvalReplayDiagnostics {
  retrievalInfo: RetrievalInfo
  retrievalTrace?: RetrievalTrace
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  answerOutcome: EvalAnswerOutcome
  answerSupportPolicy?: string
  answer: string
  latencyMs: number
}

export interface EvalCaseResult {
  caseId: string
  status: 'pass' | 'fail' | 'skipped' | 'invalid'
  score: EvalCaseScore
  diagnostics: EvalReplayDiagnostics
  comparisonOutcome?: EvalComparisonOutcome
  comparisonReasons?: string[]
}

export interface EvalRunSummary {
  totalCases: number
  passCount: number
  failCount: number
  skippedCount: number
  invalidCount: number
  improvementCount: number
  regressionCount: number
  unchangedCount: number
}

export interface EvalRun {
  id: string
  datasetId: string
  workspaceId: string
  label: string | null
  baselineRunId: string | null
  createdByAccountId: string | null
  runMetadata: Record<string, unknown>
  summary: EvalRunSummary
  results: EvalCaseResult[]
  startedAt: string
  completedAt: string
}

export interface EvalDatasetDetail {
  id: string
  workspaceId: string
  name: string
  description: string
  status: 'active' | 'archived'
  createdByAccountId: string | null
  createdAt: string
  updatedAt: string
  cases: EvalCase[]
  runs: EvalRun[]
}

export interface EvalRunComparisonCase {
  caseId: string
  title: string
  outcome: EvalComparisonOutcome
  reasons: string[]
  baselineStatus?: 'pass' | 'fail' | 'skipped' | 'invalid'
  candidateStatus?: 'pass' | 'fail' | 'skipped' | 'invalid'
}

export interface EvalRunComparison {
  baselineRunId: string
  candidateRunId: string
  regressions: number
  improvements: number
  unchanged: number
  unscored: number
  cases: EvalRunComparisonCase[]
}

interface ChatStreamHandlers {
  onConversation?: (payload: ChatStreamConversation) => void
  onChunk?: (payload: ChatStreamChunk) => void
  onDone?: (payload: ChatStreamCompletion) => void
}

export interface ErrorResponse {
  error: {
    code: string
    message: string
    retryAfterSeconds?: number
  }
}

export interface ConnectorFieldOption {
  value: string
  label: string
}

export interface ConnectorConfigField {
  key: string
  type: 'text' | 'secret' | 'toggle' | 'select'
  label: string
  required: boolean
  defaultValue?: string
  placeholder?: string
  helpText?: string
  options?: ConnectorFieldOption[]
}

export interface ConnectorSummary {
  id: string
  name: string
  description: string
  enabled: boolean
  errorStatus: string | null
}

export interface ConnectorDetail extends ConnectorSummary {
  schema: ConnectorConfigField[]
  config: Record<string, string>
  webhookUrl: string | null
}

export interface ConnectorValidationIssue {
  key: string
  message: string
}

export interface ConnectorValidationErrorResponse {
  error: string
  fields: ConnectorValidationIssue[]
}

export interface ConnectorConflictErrorResponse {
  error: string
  detail: string
}

const requireActiveWorkspaceId = () => {
  const workspaceId = getStoredActiveWorkspaceId()

  if (!workspaceId) {
    throw {
      error: {
        code: "UNAUTHORIZED",
        message: "Sign in again to continue.",
      },
    } satisfies ErrorResponse
  }

  return workspaceId
}

const parseSseEvent = (rawEvent: string) => {
  const normalized = rawEvent.replaceAll('\r', '')
  const lines = normalized.split('\n')
  let eventName = 'message'
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      continue
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }

  return {
    eventName,
    data: dataLines.join('\n'),
  }
}

const streamChatEvents = async (
  response: Response,
  handlers: ChatStreamHandlers,
): Promise<ChatResponse> => {
  if (!response.body) {
    throw new Error('Streaming response body was unavailable.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  let conversationId = ''
  let citations: Citation[] | undefined
  let answerSegments: AnswerSegment[] | undefined
  let conversationMode: ChatResponse['conversationMode'] | undefined
  let conversationModeMetadata: ChatResponse['conversationModeMetadata'] | undefined
  let retrievalInfo: RetrievalInfo | undefined
  let retrievalTrace: RetrievalTrace | undefined

  const flushEvent = (rawEvent: string) => {
    if (!rawEvent.trim()) {
      return
    }

    const { eventName, data } = parseSseEvent(rawEvent)

    if (!data) {
      return
    }

    const payload = JSON.parse(data) as
      | (ChatStreamConversation & { type?: 'conversation' })
      | (ChatStreamChunk & { type?: 'chunk' })
      | (ChatStreamCompletion & { type?: 'done' })

    const normalizedEventName =
      eventName === 'message' && 'type' in payload && typeof payload.type === 'string'
        ? payload.type
        : eventName

    if (normalizedEventName === 'conversation') {
      const conversationPayload = payload as ChatStreamConversation
      conversationId = conversationPayload.conversationId
      handlers.onConversation?.(conversationPayload)
      return
    }

    if (normalizedEventName === 'chunk') {
      const chunkPayload = payload as ChatStreamChunk
      answer = `${answer}${chunkPayload.text}`
      handlers.onChunk?.(chunkPayload)
      return
    }

    if (normalizedEventName === 'done') {
      const completionPayload = payload as ChatStreamCompletion
      conversationId = completionPayload.conversationId ?? conversationId
      answer = completionPayload.answer ?? answer
      citations = completionPayload.citations
      answerSegments = completionPayload.answerSegments
      conversationMode = completionPayload.conversationMode
      conversationModeMetadata = completionPayload.conversationModeMetadata
      retrievalInfo = completionPayload.retrievalInfo
      retrievalTrace = completionPayload.retrievalTrace
      handlers.onDone?.({
        conversationId,
        answer,
        citations,
        answerSegments,
        conversationMode,
        conversationModeMetadata,
        retrievalInfo,
        retrievalTrace,
      })
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })

    let delimiterIndex = buffer.indexOf('\n\n')

    while (delimiterIndex !== -1) {
      flushEvent(buffer.slice(0, delimiterIndex))
      buffer = buffer.slice(delimiterIndex + 2)
      delimiterIndex = buffer.indexOf('\n\n')
    }

    if (done) {
      break
    }
  }

  if (buffer.trim()) {
    flushEvent(buffer)
  }

  return {
    conversationId,
    answer,
    citations,
    answerSegments,
    conversationMode: conversationMode!,
    conversationModeMetadata: conversationModeMetadata!,
    retrievalInfo: retrievalInfo!,
    retrievalTrace: retrievalTrace!,
  }
}

// Workspace types
export interface Workspace {
  id: string
  accountId: string
  name: string
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
}

// Auth API
export const authApi = {
  async register(data: RegisterRequest): Promise<RegisterResponse> {
    return request<RegisterResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withSession: true })
  },

  async login(data: LoginRequest): Promise<LoginResponse> {
    return request<LoginResponse>("/auth/login", {
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
    return request<RetrievalSettings>("/settings/retrieval", {
      method: "GET",
    }, { withApiToken: true })
  },

  async updateRetrievalSettings(data: RetrievalSettings): Promise<RetrievalSettings> {
    const { metadataFieldSuggestions: _metadataFieldSuggestions, ...payload } = data
    return request<RetrievalSettings>("/settings/retrieval", {
      method: "PUT",
      body: JSON.stringify(payload),
    }, { withApiToken: true })
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

export const connectorsApi = {
  async listConnectors(): Promise<ConnectorSummary[]> {
    const response = await request<{ connectors: ConnectorSummary[] }>('/connectors', {
      method: 'GET',
    }, { withApiToken: true })
    return response.connectors
  },

  async getConnector(connectorId: string): Promise<ConnectorDetail> {
    return request<ConnectorDetail>(`/connectors/${connectorId}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async saveConnectorConfig(
    connectorId: string,
    config: Record<string, string | number | boolean>
  ): Promise<ConnectorDetail> {
    return request<ConnectorDetail>(`/connectors/${connectorId}`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }, { withApiToken: true })
  },

  async enableConnector(connectorId: string): Promise<ConnectorDetail> {
    return request<ConnectorDetail>(`/connectors/${connectorId}/enable`, {
      method: 'POST',
    }, { withApiToken: true })
  },

  async disableConnector(connectorId: string): Promise<ConnectorDetail> {
    return request<ConnectorDetail>(`/connectors/${connectorId}/disable`, {
      method: 'POST',
    }, { withApiToken: true })
  },
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
    return request<ChatResponse>("/chat/", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async streamChatResponse(
    data: ChatRequest,
    handlers: ChatStreamHandlers = {},
  ): Promise<ChatResponse> {
    const response = await fetch(STREAMING_API_PATH, {
      method: "POST",
      cache: "no-store",
      credentials: 'include',
      headers: {
        "Content-Type": "application/json",
        [WORKSPACE_HEADER]: requireActiveWorkspaceId(),
      },
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    const contentType = response.headers.get("content-type") ?? ""

    if (!contentType.includes("text/event-stream")) {
      const payload = (await response.json()) as ChatResponse
      handlers.onConversation?.({ conversationId: payload.conversationId })
      if (payload.answer) {
        handlers.onChunk?.({ text: payload.answer })
      }
      handlers.onDone?.({
        conversationId: payload.conversationId,
        answer: payload.answer,
        citations: payload.citations,
        answerSegments: payload.answerSegments,
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
    return request<ChatResponse>('/chat/', {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async listHistory(input?: { limit?: number; offset?: number; cursor?: string }): Promise<ChatHistoryListResponse> {
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
    return request<ChatHistoryListResponse>(`/chat/history${query ? `?${query}` : ''}`, {
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
    return request<ChatConversationDetail>(`/chat/history/${conversationId}${query ? `?${query}` : ''}`, {
      method: 'GET',
    }, { withApiToken: true })
  },
}

export const evalApi = {
  async listDatasets(): Promise<{ datasets: EvalDatasetSummary[] }> {
    return request<{ datasets: EvalDatasetSummary[] }>('/evals/datasets', {
      method: 'GET',
    }, { withApiToken: true })
  },

  async createDataset(data: { name: string; description?: string }): Promise<EvalDatasetSummary> {
    return request<EvalDatasetSummary>('/evals/datasets', {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async getDataset(datasetId: string): Promise<EvalDatasetDetail> {
    return request<EvalDatasetDetail>(`/evals/datasets/${datasetId}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async importChatHistory(data: { conversationId: string; assistantMessageId: string }): Promise<{ importDraft: EvalImportDraft }> {
    return request<{ importDraft: EvalImportDraft }>('/evals/import/chat-history', {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async createCase(
    datasetId: string,
    data: {
      title: string
      query: string
      conversationContext?: EvalCaseConversationMessage[]
      sourceType?: 'manual' | 'conversation_import'
      expectations?: EvalCaseExpectations
      provenance?: Record<string, unknown>
    },
  ): Promise<EvalCase> {
    return request<EvalCase>(`/evals/datasets/${datasetId}/cases`, {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async runDataset(datasetId: string, data?: { label?: string; baselineRunId?: string; runMetadata?: Record<string, unknown> }): Promise<EvalRun> {
    return request<EvalRun>(`/evals/datasets/${datasetId}/runs`, {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    }, { withApiToken: true })
  },

  async getRun(datasetId: string, runId: string): Promise<EvalRun> {
    return request<EvalRun>(`/evals/datasets/${datasetId}/runs/${runId}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async getComparison(datasetId: string, runId: string, baselineRunId?: string): Promise<EvalRunComparison> {
    const searchParams = new URLSearchParams()
    if (baselineRunId) {
      searchParams.set('baselineRunId', baselineRunId)
    }
    const query = searchParams.toString()
    return request<EvalRunComparison>(`/evals/datasets/${datasetId}/runs/${runId}/comparison${query ? `?${query}` : ''}`, {
      method: 'GET',
    }, { withApiToken: true })
  },
}

// General Settings types
export interface GeneralSettings {
  anonymousChatEnabled: boolean
  anonymousChatUrl: string | null
  anonymousRateLimit: number
  assistantName: string
  assistantRole: string
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

export interface PublicEmbedSessionResponse {
  workspaceName: string
  publicChatToken: string
  embedSessionToken: string
  assistantBootstrapActive: boolean
  expiresAt: string
}

export interface WorkspaceTokenResponse {
  token: string
}

export interface RenameOrganizationResponse {
  accountId: string
  organizationName: string
}

// General Settings API
export const generalSettingsApi = {
  async getGeneralSettings(): Promise<GeneralSettings> {
    return request<GeneralSettings>('/settings/general', {
      method: 'GET',
    }, { withApiToken: true })
  },

  async updateGeneralSettings(data: {
    anonymousChatEnabled?: boolean
    anonymousRateLimit?: number
    assistantName?: string
    assistantRole?: string
    greetingInstruction?: string
    assistantDefaultLocale?: string | null
    proactiveGreetingEnabled?: boolean
    websiteEmbedEnabled?: boolean
    websiteEmbedToken?: string | null
    websiteEmbedScriptUrl?: string | null
    websiteEmbedSnippet?: string | null
    websiteEmbedAllowedOrigins?: string[]
    websiteEmbedLauncherLabel?: string
    websiteEmbedLauncherIcon?: 'chat' | 'sparkles' | 'message'
    websiteEmbedLauncherPosition?: 'bottom-right' | 'bottom-left'
  }): Promise<GeneralSettings> {
    return request<GeneralSettings>('/settings/general', {
      method: 'PUT',
      body: JSON.stringify(data),
    }, { withApiToken: true })
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
    return request<WorkspaceTokenResponse>(`/account/workspaces/${workspaceId}/token`, {
      method: 'GET',
    }, { withSession: true })
  },
}

// Public Chat API (anonymous, cookie-based auth)
export const publicChatApi = {
  async sendMessage(token: string, data: { query: string; stream: boolean; conversationId?: string }): Promise<ChatResponse> {
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
    data: { query: string; stream: boolean; conversationId?: string },
    handlers: ChatStreamHandlers = {},
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

    const contentType = response.headers.get('content-type') ?? ''

    if (!contentType.includes('text/event-stream')) {
      const payload = (await response.json()) as ChatResponse
      handlers.onConversation?.({ conversationId: payload.conversationId })
      if (payload.answer) {
        handlers.onChunk?.({ text: payload.answer })
      }
      handlers.onDone?.({
        conversationId: payload.conversationId,
        answer: payload.answer,
        citations: payload.citations,
        answerSegments: payload.answerSegments,
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
    data: Pick<ChatRequest, 'stream' | 'bootstrapGreeting' | 'userExpectedLocale'>,
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
}

export const publicEmbedApi = {
  async bootstrapSession(token: string): Promise<PublicEmbedSessionResponse> {
    return request<PublicEmbedSessionResponse>(`/public/embed/${token}/session`, {
      method: 'POST',
    })
  },
}
