import { API_BASE, buildError, getStoredActiveWorkspaceId, request } from './api-client'
import { createClientId } from './client-id'

export type RevisionStatus = 'unpublished' | 'draft_clean' | 'draft_dirty' | 'published_changed_since_draft'
export type EvidenceState = 'current' | 'configuration_changed' | 'environment_changed' | 'comparability_unknown'
export type ExecutionState = 'missing' | 'running' | 'partial' | 'failed' | 'completed'

export interface AgentRevisionSummary {
  id: string
  label: string
  kind: 'candidate' | 'published'
  createdAt: string
  publishedAt?: string
  /** Present only for an immutable revision that has been published. */
  versionNumber: number | null
}

export interface AgentRevisionState {
  agentId: string
  status: RevisionStatus
  draft: {
    generation: number
    basePublishedRevisionId: string | null
    updatedAt: string
  }
  publishedRevision: AgentRevisionSummary | null
  canPublish: boolean
  proactiveGreetingEnabled?: boolean
}

/** Exactly the publish request body; the endpoint rejects any other key. */
export interface PublishRevisionCommand {
  expectedDraftGeneration: number
  expectedPublishedRevisionId: string | null
  idempotencyKey: string
}

export interface AgentRevisionDetail extends AgentRevisionSummary {
  snapshotFormatVersion: number
  scope: {
    customInstructions: true
    directives: true
    routines: true
    contextVariableEnablements: true
  }
  dependencyWarnings: Array<{ code: string; message: string }>
  /** Immutable snapshot selection; never substitute current authoring enablements. */
  enabledContextVariableIds: string[]
  scopedChanges: {
    customInstruction: { before: string | null; after: string | null; changed: boolean }
    directives: Array<{ id: string; change: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown }>
    routines: Array<{ definitionId: string; change: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown }>
    contextVariableEnablements: Array<{ contextVariableId: string; change: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown }>
  }
}

export interface TestExecution {
  id: string
  generation: number
  mode: 'single' | 'compare'
  sides: Array<{
    id: string
    revision: AgentRevisionSummary
    conversationId: string
    state: ExecutionState
    retryable: boolean
    history?: Array<{
      turnId: string
      role: 'user' | 'assistant'
      content: string
      messageId?: string
      attemptId: string
      createdAt: string
    }>
  }>
}

/** The eval API intentionally returns only the revision identity needed by its evidence table. */
export interface RevisionEvalRevisionSummary {
  id: string
  versionNumber: number | null
  label: string
}

export interface TestExecutionHistoryItem extends Omit<TestExecution, 'sides'> {
  state: ExecutionState
  createdAt: string
  sides: Array<Omit<TestExecution['sides'][number], 'state' | 'history'> & { state: ExecutionState | 'ready' }>
}

export interface TestExecutionHistoryDetail extends Omit<TestExecutionHistoryItem, 'sides'> {
  testValues: Array<{ contextVariableId: string; value: unknown }>
  sides: Array<Omit<TestExecution['sides'][number], 'state' | 'history'> & {
    /** `ready` is persisted before the first message; it is not a completed turn. */
    state: ExecutionState | 'ready'
    history: Array<{
      turnId: string
      role: 'user' | 'assistant'
      content: string
      messageId?: string
      attemptId: string
      createdAt: string
    }>
  }>
  attempts: Array<{
    sideId: string
    turnId: string
    attemptId: string
    fence: number
    state: 'running' | 'failed' | 'completed'
    failureCode?: string | null
    createdAt: string
    updatedAt: string
    leaseExpiresAt?: string
  }>
}

export type TestExecutionEvent =
  | { type: 'side_started'; executionId: string; generation: number; sideId: string; turnId: string; attemptId: string }
  | { type: 'message_delta'; executionId: string; generation: number; sideId: string; delta: string; turnId: string; attemptId: string }
  | { type: 'side_completed'; executionId: string; generation: number; sideId: string; messageId: string; turnId: string; attemptId: string }
  | { type: 'side_failed'; executionId: string; generation: number; sideId: string; code: string; retryable: boolean; turnId: string; attemptId: string }
  | { type: 'execution_partial'; executionId: string; generation: number; turnId: string; attemptId: string }
  | { type: 'execution_completed'; executionId: string; generation: number; turnId: string; attemptId: string }

export interface RevisionEvalRun {
  id: string
  state: ExecutionState
  sides: Array<{
    revisionId: string
    revision: RevisionEvalRevisionSummary
    state: ExecutionState
    evidenceState: EvidenceState
    cases: Array<{
      caseId: string
      state: ExecutionState
      outcome: 'pass' | 'fail' | 'partial' | 'unavailable'
    }>
  }>
}

export const agentRevisionsApi = {
  getState(agentId: string): Promise<AgentRevisionState> {
    return request<AgentRevisionState>(`/agents/${agentId}/revision-state`, { method: 'GET' })
  },

  listPublished(agentId: string): Promise<{ revisions: AgentRevisionSummary[] }> {
    return request<{ revisions: AgentRevisionSummary[] }>(`/agents/${agentId}/revisions?include=published`, { method: 'GET' })
  },

  createCandidate(agentId: string, expectedDraftGeneration: number): Promise<{ candidate: AgentRevisionSummary }> {
    return request<{ candidate: AgentRevisionSummary }>(`/agents/${agentId}/revisions/candidates`, {
      method: 'POST',
      body: JSON.stringify({ expectedDraftGeneration }),
    })
  },

  getRevision(agentId: string, revisionId: string): Promise<{ revision: AgentRevisionDetail }> {
    return request<{ revision: AgentRevisionDetail }>(`/agents/${agentId}/revisions/${revisionId}`, { method: 'GET' })
  },

  publish(agentId: string, revisionId: string, input: PublishRevisionCommand): Promise<{ publication: { id: string; revisionId: string; publishedAt: string; idempotentReplay: boolean; revision: AgentRevisionSummary }; state: AgentRevisionState }> {
    return request(`/agents/${agentId}/revisions/${revisionId}/publish`, {
      method: 'POST',
      // The endpoint rejects unknown keys, so the body is picked field by field
      // rather than serialized from whatever wider command a caller holds.
      body: JSON.stringify({
        expectedDraftGeneration: input.expectedDraftGeneration,
        expectedPublishedRevisionId: input.expectedPublishedRevisionId,
        idempotencyKey: input.idempotencyKey,
      }),
    })
  },

  startTest(agentId: string, input: {
    mode: 'single' | 'compare'
    revisionIds: [string] | [string, string]
    testValues: Array<{ contextVariableId: string; value: unknown }>
    expectedDraftGeneration?: number
  }, signal?: AbortSignal): Promise<TestExecution> {
    return request<TestExecution>(`/agents/${agentId}/test-executions`, {
      method: 'POST',
      body: JSON.stringify({ ...input, idempotencyKey: createClientId('test-execution') }),
      signal,
    })
  },

  listTestExecutions(agentId: string, input: { limit?: number; cursor?: string } = {}): Promise<{ executions: TestExecutionHistoryItem[]; nextCursor: string | null; hasMore: boolean }> {
    const query = new URLSearchParams()
    if (input.limit !== undefined) query.set('limit', String(input.limit))
    if (input.cursor) query.set('cursor', input.cursor)
    return request<{ executions: TestExecutionHistoryItem[]; nextCursor: string | null; hasMore: boolean }>(`/agents/${agentId}/test-executions${query.size ? `?${query}` : ''}`, { method: 'GET' })
  },

  getTestExecution(agentId: string, executionId: string): Promise<{ execution: TestExecutionHistoryDetail }> {
    return request<{ execution: TestExecutionHistoryDetail }>(`/agents/${agentId}/test-executions/${executionId}`, { method: 'GET' })
  },

  retainTestSide(agentId: string, executionId: string, sideId: string): Promise<TestExecution> {
    return request<TestExecution>(`/agents/${agentId}/test-executions/${executionId}/sides/${sideId}/retain`, {
      method: 'POST',
    })
  },

  async retryTestSide(agentId: string, executionId: string, sideId: string, input: { executionGeneration: number; turnId: string; attemptId: string }, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers({ 'Content-Type': 'application/json', 'X-Forwarded-Prefix': '/backend' })
    const workspaceId = getStoredActiveWorkspaceId()
    if (workspaceId) headers.set('X-Workspace-Id', workspaceId)
    const response = await fetch(`${API_BASE}/agents/${agentId}/test-executions/${executionId}/sides/${sideId}/retry`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(input),
      signal,
    })
    if (!response.ok) throw await buildError(response)
    return response
  },

  async sendTestMessage(agentId: string, executionId: string, input: { message: string; executionGeneration: number; turnId: string; attemptId: string }, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers({ 'Content-Type': 'application/json', 'X-Forwarded-Prefix': '/backend' })
    const workspaceId = getStoredActiveWorkspaceId()
    if (workspaceId) headers.set('X-Workspace-Id', workspaceId)
    const response = await fetch(`${API_BASE}/agents/${agentId}/test-executions/${executionId}/messages`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(input),
      signal,
    })
    if (!response.ok) throw await buildError(response)
    return response
  },

  startEval(input: {
    revisionIds: [string] | [string, string]
    caseIds: string[]
    testValues: Array<{ contextVariableId: string; value: unknown }>
    mode: 'retrieval_only' | 'full_assistant'
    executionPolicy: 'safe_test'
  }): Promise<RevisionEvalRun> {
    return request<RevisionEvalRun>('/evals/revision-runs', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  getEval(runId: string): Promise<RevisionEvalRun> {
    return request<RevisionEvalRun>(`/evals/revision-runs/${runId}`, { method: 'GET' })
  },

  retryEvalCase(runId: string, revisionId: string, caseId: string): Promise<RevisionEvalRun> {
    return request<RevisionEvalRun>(`/evals/revision-runs/${runId}/sides/${revisionId}/cases/${caseId}/retry`, {
      method: 'POST',
    })
  },
}
