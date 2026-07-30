import type { RoutineState } from "@radioso/conversation-contract";
import type { AgentSnapshot, InternalAgentConfig } from "../../agents/public.js";
import type { AnswerSegment, ChatCitation, TurnTraceEnvelope } from "../../chat/contracts/index.js";
import type { ActivityTrace } from "../../retrieval/public.js";
import type { LlmCapabilityOverride } from "../../../shared/infra/llm/workspaceContext.js";
import type { GroundingSummary } from "../../chat/retrievalSupport.js";
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
  groundingSummary?: GroundingSummary;
  directiveFirings?: string[];
}

export interface EvalSnapshotOriginalRetrievalChunk {
  chunkId: string;
  documentId: string;
  title: string;
  rank: number;
  similarity?: number;
  fusedScore?: number;
  semanticScore?: number;
  lexicalScore?: number;
  lexicalRankScore?: number;
  metadata?: Record<string, unknown>;
}

export interface EvalSnapshotReplayTarget {
  userMessageId: string;
  assistantMessageId: string | null;
}

export interface EvalSnapshot {
  id: string;
  workspaceId: string;
  sourceConversationId: string;
  sourceMessageId: string | null;
  replayTarget: EvalSnapshotReplayTarget | null;
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
  // The rolling conversation summary (#866) frozen at capture time, so a workbench
  // replay or eval run injects the same pre-window context a live turn would receive.
  // This is the summary as of snapshot time — per-turn historical summaries are not
  // persisted, so it is the faithful achievable parity. Absent for short/new
  // conversations and for snapshots captured before the field existed.
  conversationSummary?: string;
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
  | { type: "retrieval_document_order"; documentIds: string[] }
  | { type: "retrieval_chunk_metadata"; documentId: string; metadata: Record<string, string | number | boolean | null> }
  | { type: "answer_cites_document"; documentId: string }
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
  fusedScore?: number;
  semanticScore?: number;
  lexicalScore?: number;
  lexicalRankScore?: number;
  metadata?: Record<string, unknown>;
}

export interface EvalRunObservedOutput {
  retrievedChunks: EvalRunRetrievedChunk[];
  answer?: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  groundingSummary?: GroundingSummary;
  groundingVerdict?: GroundingSummary["verdict"];
  groundingDiagnostics?: Omit<GroundingSummary, "verdict">;
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
  /** The frozen rolling summary (#866) injected into this run's grounded prompt,
   * echoed so an operator can confirm which pre-window context the run saw.
   * full_assistant only — retrieval_only runs inject no summary. */
  conversationSummary?: string;
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

/**
 * The agent a case's replay runs against. A case has no agent column of its
 * own — it pins to an immutable snapshot, and the snapshot carries the agent
 * identity (captured from the source conversation) plus the frozen config the
 * replay actually uses. This ref surfaces "which agent is being tested" in the
 * suite list. It is deliberately labelled as *captured from* an agent, not a
 * live link: replay uses the frozen snapshot config, so a renamed or edited
 * agent is not reflected in what the case exercises.
 */
export interface EvalCaseAgentRef {
  /** `source_agent_id` from the snapshot. Null for legacy thin snapshots
   * captured before full-config capture existed. */
  agentId: string | null;
  /** Display name. Prefers the current agent row (stable identity, current
   * name); falls back to the name frozen on the snapshot when the agent was
   * deleted or was never recorded. Null when nothing is known. */
  name: string | null;
  /** True when `agentId` is known but the agent row no longer exists in the
   * workspace — the shown name is the frozen capture-time name, so the UI can
   * mark it as removed. */
  deleted: boolean;
}

export interface EvalCaseListItem extends EvalCase {
  latestRun: EvalRunSummary | null;
  /** The agent this case was captured from / replays against. Always present:
   * every case pins to a snapshot, though the resolved name may be null. */
  agent: EvalCaseAgentRef;
}

/**
 * The stable link from one source assistant message to its current Eval case.
 * Snapshot and case are returned together so convenience callers never need a
 * second request or a workspace-wide scan to open the linked case.
 */
export interface EvalMessageCaseLookup {
  assistantMessageId: string;
  case: EvalCase;
  snapshot: EvalSnapshot;
  createdBy: string | null;
  createdAt: string;
}

export interface EvalMessageCaseMutationResult extends EvalMessageCaseLookup {
  /** True only for the request that created the association. */
  created: boolean;
}

/**
 * Lightweight Eval-owned projection consumed by Quality. It deliberately
 * excludes snapshot content, assertions, observed output, and run details.
 */
export interface EvalMessageCaseVerification {
  caseId: string;
  caseStatus: EvalCaseStatus;
  latestRunStatus: EvalRunStatus | null;
  latestRunAt: string | null;
}
