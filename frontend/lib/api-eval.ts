import { request } from './api-client'

export type EvalSnapshotFidelity = 'full' | 'messages_only'

export interface EvalSnapshotMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

export interface EvalSnapshotOriginalRetrievalChunk {
  chunkId: string
  documentId: string
  title: string
  rank: number
  similarity?: number
}

export interface EvalSnapshot {
  id: string
  workspaceId: string
  sourceConversationId: string
  sourceMessageId: string | null
  fidelity: EvalSnapshotFidelity
  messages: EvalSnapshotMessage[]
  originalInstructionBlock: string | null
  originalModelId: string | null
  originalRetrievalSettings: Record<string, unknown> | null
  originalRetrievalResult: EvalSnapshotOriginalRetrievalChunk[] | null
  originalAgent: Record<string, unknown> | null
  capturedAt: string
  capturedBy: string | null
}

export type AnswerMatchMode = 'substring' | 'regex'

export type EvalAssertion =
  | { type: 'retrieval_includes_document'; documentId: string }
  | { type: 'retrieval_excludes_document'; documentId: string }
  | { type: 'retrieval_top_k_includes_document'; documentId: string; k: number }
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

export interface EvalRunModelOverride {
  provider: 'openai' | 'openai-compatible' | 'gemini' | 'claude'
  model: string
}

export interface EvalRunOverridesInput {
  modelOverride?: EvalRunModelOverride
  assistantInstructionsOverride?: { customInstruction?: string }
  retrievalSettingsOverride?: Record<string, unknown>
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

  async replaceAssertions(caseId: string, assertions: EvalAssertion[]): Promise<EvalCase> {
    return request<EvalCase>(`/evals/cases/${caseId}/assertions`, {
      method: 'PUT',
      body: JSON.stringify({ assertions }),
    }, { withApiToken: true })
  },

  async listCases(): Promise<{ cases: EvalCase[] }> {
    return request<{ cases: EvalCase[] }>('/evals/cases', {
      method: 'GET',
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
      body: JSON.stringify({ mode: input.mode ?? 'retrieval_only', overrides: input.overrides }),
    }, { withApiToken: true })
  },

  async runOneOff(input: {
    snapshotId: string
    mode?: EvalRunMode
    overrides?: EvalRunOverridesInput
  }): Promise<{ run: EvalRun; case: EvalCase | null }> {
    return request<{ run: EvalRun; case: EvalCase | null }>('/evals/runs', {
      method: 'POST',
      body: JSON.stringify({ mode: input.mode ?? 'retrieval_only', ...input }),
    }, { withApiToken: true })
  },
}
