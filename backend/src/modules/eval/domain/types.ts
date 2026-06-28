import type { RoutineState } from "@radioso/conversation-contract";
import type { AgentSnapshot, InternalAgentConfig } from "../../agents/public.js";
import type { AnswerSegment, ChatCitation, TurnTraceEnvelope } from "../../chat/contracts/index.js";
import type { ActivityTrace } from "../../retrieval/public.js";
import type { LlmCapabilityOverride } from "../../../shared/infra/llm/workspaceContext.js";
import type {
  RetrievalSettingsRecord,
  RetrievalSettingsSnapshot,
} from "../../settings/contracts/retrieval.js";

export type EvalSnapshotFidelity = "full" | "messages_only";

export interface EvalSnapshotMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
}

export interface EvalSnapshotOriginalRetrievalChunk {
  chunkId: string;
  documentId: string;
  title: string;
  rank: number;
  similarity?: number;
}

export interface EvalSnapshot {
  id: string;
  workspaceId: string;
  sourceConversationId: string;
  sourceMessageId: string | null;
  fidelity: EvalSnapshotFidelity;
  messages: EvalSnapshotMessage[];
  // Composed instruction block (string actually sent to the LLM) at capture
  // time. Captured opportunistically from assistant message metadata.
  originalInstructionBlock: string | null;
  originalModelId: string | null;
  // Settings snapshot is OWNED by the settings module. Eval just references
  // the value type — the same shape is intended to be reused for future
  // per-message retrieval settings persistence, audit trails, etc.
  originalRetrievalSettings: RetrievalSettingsSnapshot | null;
  // Agent snapshot is OWNED by the agents module. Eval just references the
  // value type. Same reuse intent as above.
  originalAgent: AgentSnapshot | null;
  // Full non-redacted internal config captured for replay. Prefer this over
  // originalAgent when present; originalAgent remains readable for legacy rows.
  originalAgentConfig: InternalAgentConfig | null;
  sourceAgentId: string | null;
  // The conversation's routine position at capture time (full RoutineState minus
  // sessionId), captured as reference data alongside the other original* fields. NULL
  // when no routine was active. NOTE: this is the *current* (post-turn) position —
  // routine_states keeps a single current row per conversation — so it is NOT a faithful
  // pre-turn seed for replaying an already-completed assistant turn and is intentionally
  // not auto-applied as a replay seed. Use the explicit routineStartState override to
  // seed a mid-routine replay.
  originalRoutineState: EvalRunRoutineStartState | null;
  originalRetrievalResult: EvalSnapshotOriginalRetrievalChunk[] | null;
  capturedAt: string;
  capturedBy: string | null;
}

// An assertion is one *check* a case makes about a run's observed output.
// A case has 0..N assertions; the run passes iff every assertion passes.
// Adding new types is additive: extend the discriminated union here, handle
// the new variant in evaluateAssertion (domain/outcomes.ts), and add Zod
// parsing in the route schema. No other code needs to change.
export type AnswerMatchMode = "substring" | "regex";

export type EvalAssertion =
  | { type: "retrieval_includes_document"; documentId: string }
  | { type: "retrieval_excludes_document"; documentId: string }
  | { type: "retrieval_top_k_includes_document"; documentId: string; k: number }
  | {
      type: "answer_contains";
      pattern: string;
      matchMode: AnswerMatchMode;
      caseSensitive?: boolean;
    }
  | {
      type: "answer_does_not_contain";
      pattern: string;
      matchMode: AnswerMatchMode;
      caseSensitive?: boolean;
    }
  | {
      type: "llm_judge";
      // The answer the operator considers correct. The judge LLM compares
      // the observed answer against this and returns a structured verdict.
      expectedAnswer: string;
      // Optional extra grading criteria — e.g. "ignore phrasing differences"
      // or "must mention 30-day window." When omitted, the judge uses a
      // generic "semantically equivalent / answers the question" rubric.
      criteria?: string;
    };

export type EvalCaseStatus = "pending" | "passing" | "failing" | "error";

export interface EvalCase {
  id: string;
  workspaceId: string;
  snapshotId: string;
  name: string;
  assertions: EvalAssertion[];
  status: EvalCaseStatus;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EvalRunMode = "retrieval_only" | "full_assistant";
export type EvalRunStatus = "pass" | "fail" | "error" | "recorded";

export type EvalRunModelOverride = LlmCapabilityOverride;

export interface EvalRunOverrides {
  // Per-run override for the chat model. When set, this exact provider+model
  // is used for the full_assistant answer call instead of the workspace's
  // configured chat capability. The judge call still uses the workspace's
  // default chat capability — model overrides apply to "what we're testing",
  // not to the grader.
  modelOverride?: EvalRunModelOverride;
  assistantInstructionsOverride?: {
    customInstruction?: string;
  };
  // Partial overrides applied on top of the workspace's current retrieval
  // settings record at run time. This is a *delta*, not a snapshot — for
  // captured "what was used" values use originalRetrievalSettings on the
  // snapshot or resolvedConfig on the run.
  retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  agentConfigOverride?: Partial<InternalAgentConfig>;
  // Seeds a starting routine position for a full_assistant replay so the agent's
  // routine resumes mid-flight instead of activating fresh. It is the full RoutineState
  // minus sessionId (the replay injects the ephemeral conversation id), so resume is
  // exact — path (step/back-edge history) and attempts (counter guards) are honored.
  routineStartState?: EvalRunRoutineStartState;
}

export type EvalRunRoutineStartState = Omit<RoutineState, "sessionId">;

export interface EvalRunRetrievedChunk {
  chunkId: string;
  documentId: string;
  title: string;
  rank: number;
  similarity?: number;
}

export interface EvalRunObservedOutput {
  retrievedChunks: EvalRunRetrievedChunk[];
  answer?: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  turnTrace?: TurnTraceEnvelope;
  activityTrace?: ActivityTrace;
  error?: { message: string; code?: string };
}

export type AssertionVerdictStatus = "pass" | "fail" | "error";

export interface AssertionVerdict {
  assertion: EvalAssertion;
  status: AssertionVerdictStatus;
  reason: string | null;
}

export interface EvalRunResolvedConfig {
  retrievalSettings?: RetrievalSettingsSnapshot | Partial<RetrievalSettingsRecord>;
  /** Provider/model the chat call actually resolved to. Populated only for
   * full_assistant runs where the assistant actually answered. */
  modelProvider?: string;
  modelId?: string;
  composedInstructions?: string;
}

export interface EvalRun {
  id: string;
  workspaceId: string;
  snapshotId: string;
  caseId: string | null;
  mode: EvalRunMode;
  overrides: EvalRunOverrides;
  resolvedConfig: EvalRunResolvedConfig;
  observedOutput: EvalRunObservedOutput;
  status: EvalRunStatus;
  outcomeReason: string | null;
  assertionVerdicts: AssertionVerdict[];
  startedAt: string;
  completedAt: string | null;
}

export interface EvalCaseWithRuns extends EvalCase {
  runs: EvalRun[];
}

/**
 * Compact view of a run for the suite list's "last run" column. Distinct from
 * {@link EvalCase.status}: the case status is the *configured* verdict (reset to
 * `pending` whenever expectations change), whereas `latestRun` reflects the most
 * recent *execution* regardless of later edits.
 */
export interface EvalRunSummary {
  id: string;
  status: EvalRunStatus;
  mode: EvalRunMode;
  startedAt: string;
  completedAt: string | null;
  modelId: string | null;
  outcomeReason: string | null;
}

export interface EvalCaseListItem extends EvalCase {
  latestRun: EvalRunSummary | null;
}
