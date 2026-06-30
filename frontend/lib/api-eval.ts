import { request } from './api-client'
import type { ActivityTrace, AnswerSegment, Citation, Directive, TurnTraceEnvelope } from './api-types'

// Eval is currently a dashboard-only API surface and is not registered in the
// public OpenAPI/SDK contract. Keep these local request/response types in sync
// with backend/src/modules/eval/domain/types.ts when changing eval payloads.

export type EvalSnapshotFidelity = 'full' | 'messages_only'

export interface EvalSnapshotMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
}

export interface EvalSnapshotOriginalRetrievalChunk {
  chunkId: string
  documentId: string
  title: string
  rank: number
  similarity?: number
}

export interface EvalSnapshotReplayTarget {
  userMessageId: string
  assistantMessageId: string | null
}

export interface EvalSnapshot {
  id: string
  workspaceId: string
  sourceConversationId: string
  sourceMessageId: string | null
  replayTarget: EvalSnapshotReplayTarget | null
  fidelity: EvalSnapshotFidelity
  messages: EvalSnapshotMessage[]
  originalInstructionBlock: string | null
  originalModelId: string | null
  originalRetrievalSettings: Record<string, unknown> | null
  originalRetrievalResult: EvalSnapshotOriginalRetrievalChunk[] | null
  originalAgent: Record<string, unknown> | null
  originalAgentConfig: AgentConfigOverrideInput | null
  sourceAgentId: string | null
  // The agent's active routine position frozen at capture time (mid-routine replay).
  originalRoutineState?: EvalRunRoutineStartStateInput | null
  capturedAt: string
  capturedBy: string | null
}

export type AnswerMatchMode = 'substring' | 'regex'

export type EvalAssertion =
  | { type: 'retrieval_includes_document'; documentId: string }
  | { type: 'retrieval_excludes_document'; documentId: string }
  | { type: 'retrieval_top_k_includes_document'; documentId: string; k: number }
  | { type: 'answer_cites_document'; documentId: string }
  | {
      type: 'answer_contains'
      pattern: string
      matchMode: AnswerMatchMode
      caseSensitive?: boolean
    }
  | {
      type: 'answer_does_not_contain'
      pattern: string
      matchMode: AnswerMatchMode
      caseSensitive?: boolean
    }
  | {
      type: 'llm_judge'
      expectedAnswer: string
      criteria?: string
    }

export type EvalAssertionKind = EvalAssertion['type']

export type AssertionVerdictStatus = 'pass' | 'fail' | 'error'

export interface AssertionVerdict {
  assertion: EvalAssertion
  status: AssertionVerdictStatus
  reason: string | null
}

export type EvalCaseStatus = 'pending' | 'passing' | 'failing' | 'error'
export type EvalRunMode = 'retrieval_only' | 'full_assistant'
export type EvalRunStatus = 'pass' | 'fail' | 'error' | 'recorded'

export interface EvalCase {
  id: string
  workspaceId: string
  snapshotId: string
  name: string
  assertions: EvalAssertion[]
  status: EvalCaseStatus
  lastRunId: string | null
  createdAt: string
  updatedAt: string
}

export interface EvalRunRetrievedChunk {
  chunkId: string
  documentId: string
  title: string
  rank: number
  similarity?: number
}

export interface EvalRunObservedOutput {
  retrievedChunks: EvalRunRetrievedChunk[]
  answer?: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  turnTrace?: TurnTraceEnvelope
  activityTrace?: ActivityTrace
  error?: { message: string; code?: string }
}

export interface EvalRun {
  id: string
  workspaceId: string
  snapshotId: string
  caseId: string | null
  mode: EvalRunMode
  overrides: Record<string, unknown>
  resolvedConfig: Record<string, unknown>
  observedOutput: EvalRunObservedOutput
  assertionVerdicts: AssertionVerdict[]
  status: EvalRunStatus
  outcomeReason: string | null
  startedAt: string
  completedAt: string | null
}

export interface EvalCaseWithRuns extends EvalCase {
  runs: EvalRun[]
}

// Compact view of a run for the suite list's "last run" column. Distinct from
// EvalCase.status: the case status is the configured verdict (reset to pending
// when expectations change), while latestRun reflects the most recent execution.
export interface EvalRunSummary {
  id: string
  status: EvalRunStatus
  mode: EvalRunMode
  startedAt: string
  completedAt: string | null
  modelId: string | null
  outcomeReason: string | null
}

export interface EvalCaseListItem extends EvalCase {
  latestRun: EvalRunSummary | null
}

// Aggregate over the workspace's cases. Only cases with at least one expectation
// are "scored"; the rate is passing / scored.
export interface EvalSuiteSummary {
  total: number
  scored: number
  passing: number
  failing: number
  error: number
  pending: number
  unscored: number
}

export type EvalSuiteCaseStatus = EvalRunStatus | 'skipped'

export interface EvalSuiteCaseResult {
  caseId: string
  name: string
  status: EvalSuiteCaseStatus
  run: EvalRun | null
  error: string | null
}

export interface EvalSuiteRunResult {
  results: EvalSuiteCaseResult[]
  summary: EvalSuiteSummary
}

export interface EvalRunModelOverride {
  provider: 'openai' | 'openai-compatible' | 'gemini' | 'claude'
  model: string
}

export interface AgentConfigAuthoredDirectiveOverride {
  name: string
  condition: Directive['condition']
  action: string
  priority: number | null
  requiredCapabilities: string[]
  dependsOn: string[]
  excludes: string[]
  routes: Directive['routes']
  tags: string[]
  description: string | null
  metadata: Record<string, unknown>
}

export interface EvalRunOverridesInput {
  modelOverride?: EvalRunModelOverride
  assistantInstructionsOverride?: { customInstruction?: string }
  retrievalSettingsOverride?: Record<string, unknown>
  agentConfigOverride?: AgentConfigOverrideInput
  routineStartState?: EvalRunRoutineStartStateInput
}

// A starting routine position for a full_assistant replay (mid-routine resume). The
// full RoutineState minus sessionId; the replay injects the conversation id. Mirrors
// EvalRunRoutineStartState in backend/src/modules/eval/domain/types.ts.
export interface EvalRunRoutineStartStateInput {
  routineId: string
  path: string[]
  variables: Record<string, unknown>
  attempts?: Record<string, number>
  status: 'active' | 'suspended' | 'completed' | 'expired'
  metadata?: Record<string, unknown>
}

export interface AgentConfigOverrideInput {
  name?: string
  customInstruction?: string
  contactRequestsEnabled?: boolean
  contactRequestDelivery?: unknown
  logo?: unknown | null
  theme?: Record<string, unknown>
  branding?: Record<string, unknown>
  greetingInstruction?: string
  assistantDefaultLocale?: string | null
  proactiveGreetingEnabled?: boolean
  surfaceSettings?: Record<string, unknown>
  skillSettings?: Record<string, unknown>
  chatModelOverride?: EvalRunModelOverride | null
  authoredDirectives?: AgentConfigAuthoredDirectiveOverride[]
}

export interface WorkbenchReplayRunResponse {
  run: EvalRun
  case: EvalCase | null
  answer?: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  turnTrace?: TurnTraceEnvelope
  resolvedConfig?: Record<string, unknown>
}

export const evalsApi = {
  async captureSnapshot(input: { conversationId: string; messageId?: string }): Promise<EvalSnapshot> {
    return request<EvalSnapshot>('/evals/snapshots', {
      method: 'POST',
      body: JSON.stringify(input),
    }, { withApiToken: true })
  },

  async getSnapshot(snapshotId: string): Promise<EvalSnapshot> {
    return request<EvalSnapshot>(`/evals/snapshots/${snapshotId}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async createCase(input: {
    snapshotId: string
    name: string
    assertions?: EvalAssertion[]
  }): Promise<EvalCase> {
    return request<EvalCase>('/evals/cases', {
      method: 'POST',
      body: JSON.stringify({ ...input, assertions: input.assertions ?? [] }),
    }, { withApiToken: true })
  },

  async renameCase(caseId: string, name: string): Promise<EvalCase> {
    return request<EvalCase>(`/evals/cases/${caseId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }, { withApiToken: true })
  },

  async deleteCase(caseId: string): Promise<void> {
    await request<void>(`/evals/cases/${caseId}`, {
      method: 'DELETE',
    }, { withApiToken: true })
  },

  async replaceAssertions(caseId: string, assertions: EvalAssertion[]): Promise<EvalCase> {
    return request<EvalCase>(`/evals/cases/${caseId}/assertions`, {
      method: 'PUT',
      body: JSON.stringify({ assertions }),
    }, { withApiToken: true })
  },

  async listCases(): Promise<{ cases: EvalCaseListItem[]; summary: EvalSuiteSummary }> {
    return request<{ cases: EvalCaseListItem[]; summary: EvalSuiteSummary }>('/evals/cases', {
      method: 'GET',
    }, { withApiToken: true })
  },

  // Run a batch of cases — the whole workspace, or a selected subset via
  // caseIds (cost control). Either way the summary covers the whole workspace.
  async runSuite(input: { caseIds?: string[]; mode?: EvalRunMode } = {}): Promise<EvalSuiteRunResult> {
    return request<EvalSuiteRunResult>('/evals/cases/run', {
      method: 'POST',
      body: JSON.stringify({
        mode: input.mode ?? 'full_assistant',
        ...(input.caseIds && input.caseIds.length > 0 ? { caseIds: input.caseIds } : {}),
      }),
    }, { withApiToken: true })
  },

  async getCase(caseId: string): Promise<EvalCaseWithRuns> {
    return request<EvalCaseWithRuns>(`/evals/cases/${caseId}`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async runCase(
    caseId: string,
    input: { mode?: EvalRunMode; overrides?: EvalRunOverridesInput } = {},
  ): Promise<{ run: EvalRun; case: EvalCase | null }> {
    return request<{ run: EvalRun; case: EvalCase | null }>(`/evals/cases/${caseId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ mode: input.mode ?? 'full_assistant', overrides: input.overrides }),
    }, { withApiToken: true })
  },

  async runOneOff(input: {
    snapshotId: string
    mode?: EvalRunMode
    overrides?: EvalRunOverridesInput
    agentConfigOverride?: AgentConfigOverrideInput
  }): Promise<WorkbenchReplayRunResponse> {
    const { agentConfigOverride, ...rest } = input
    return request<WorkbenchReplayRunResponse>('/evals/runs', {
      method: 'POST',
      body: JSON.stringify({
        mode: input.mode ?? 'full_assistant',
        ...rest,
        ...(agentConfigOverride ? { agentConfigOverride } : {}),
      }),
    }, { withApiToken: true })
  },
}
