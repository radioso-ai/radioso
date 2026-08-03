import type {
  GroundingDiagnosticSnapshot,
  GroundingVerdict,
} from "../../../shared/domain/groundingDiagnostic.js";

export type { GroundingDiagnosticSnapshot, GroundingVerdict };

export type QualitySkillStatus =
  | "active"
  | "paused"
  | "awaiting_confirmation"
  | "awaiting_tool"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";
export type QualityFeedbackValue = "up" | "down";

/**
 * Operator triage lifecycle for an assistant turn. Shared across all quality
 * signals; `open` is the implicit default when no triage row exists.
 * `resolved`/`dismissed` are the closed states that drain the active backlog.
 */
export type QualityTriageState = "open" | "acknowledged" | "resolved" | "dismissed";

export const QUALITY_TRIAGE_STATES: readonly QualityTriageState[] = [
  "open",
  "acknowledged",
  "resolved",
  "dismissed",
];

export type QualityResolvedReason =
  | "knowledge_gap"
  | "retrieval_issue"
  | "agent_behavior"
  | "platform_bug"
  | "other";

export type QualityDismissedReason =
  | "expected_behavior"
  | "out_of_scope"
  | "invalid_feedback"
  | "other";

export type QualityResolutionReason = QualityResolvedReason | QualityDismissedReason;
export type QualityResolutionReasonOrUnspecified = QualityResolutionReason | "unspecified";

export interface QualityResolution {
  reason: QualityResolutionReason;
  note: string | null;
}

export interface QualityVerification {
  caseId: string;
  caseStatus: "pending" | "passing" | "failing" | "error";
  latestRunStatus: "pass" | "fail" | "error" | "recorded" | null;
  latestRunAt: string | null;
}

/**
 * Eval implements this batch projection. Quality depends only on the neutral
 * evidence it needs for a page and never imports Eval domain or persistence.
 */
export interface QualityVerificationSourcePort {
  getByAssistantMessageIds(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<ReadonlyMap<string, QualityVerification>>;
}

export interface QualityActionFilter {
  skillName: string;
  outcome: string;
}

/**
 * The operator signals surfaced above the assistant-answers table. Each one names a
 * class of turn worth reviewing; `backend/src/modules/quality/domain/qualitySignals.ts`
 * owns what each means.
 */
export const QUALITY_SIGNAL_IDS = [
  "negative_feedback",
  "grounding_gaps",
  "slow_responses",
  "skill_failures",
] as const;

export type QualitySignalId = (typeof QUALITY_SIGNAL_IDS)[number];

export interface QualityFeedbackSummary {
  upCount: number;
  downCount: number;
  /** Latest creation or edit time among thumbs-down feedback entries. */
  latestDownUpdatedAt: string | null;
  comments: Array<{
    value: QualityFeedbackValue;
    comment: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface LowQualityTurn {
  assistantMessageId: string;
  conversationId: string;
  agentId: string | null;
  agentName: string | null;
  agentInternalName: string | null;
  channel: string | null;
  question: string | null;
  answerPreview: string;
  skillName: string | null;
  skillOutcome: string | null;
  skillStatus: string | null;
  totalLatencyMs: number | null;
  grounding: GroundingDiagnosticSnapshot | null;
  createdAt: string;
  feedback: QualityFeedbackSummary;
  triage: QualityTriageRecord;
  verification: QualityVerification | null;
}

export interface QualityTriageRecord {
  state: QualityTriageState;
  version: number;
  resolution: QualityResolution | null;
  legacyReason: string | null;
  closedAt: string | null;
  updatedAt: string | null;
}

export interface ListLowQualityTurnsInput {
  /**
   * Narrows to the turns carrying **any** of these operator signals, resolved server-side
   * from the skill catalog. One entry expresses a single chip, several express "anything
   * worth reviewing" — the queue's default — without a second vocabulary for the two.
   *
   * OR across the list, AND with the explicit filters below: a signal narrows the
   * population, it never replaces a filter the operator set.
   */
  signals?: QualitySignalId[];
  actions?: QualityActionFilter[];
  statuses?: QualitySkillStatus[];
  feedbackValues?: QualityFeedbackValue[];
  triageStates?: QualityTriageState[];
  resolutionReasons?: QualityResolutionReasonOrUnspecified[];
  /** Inclusive latest terminal-transition timestamp. */
  resolutionFrom?: string;
  /** Exclusive latest terminal-transition timestamp. */
  resolutionTo?: string;
  /** Defaults to answer creation time; feedback inboxes use latest thumbs-down activity. */
  sort?: "turn_created_at" | "negative_feedback_updated_at";
  /**
   * Returns thumbs-down feedback that has not been handled since its latest
   * creation or edit. A feedback event newer than resolved/dismissed triage is
   * exposed as open until an operator triages the turn again.
   */
  activeNegativeFeedbackOnly?: boolean;
  /** true returns turns with written feedback comments; false returns turns without them. */
  hasComment?: boolean;
  minTotalLatencyMs?: number;
  maxTotalLatencyMs?: number;
  groundingVerdicts?: GroundingVerdict[];
  hasUnsourcedClaims?: boolean;
  hasInvalidSources?: boolean;
  agentId?: string;
  channel?: string;
  from?: string;
  to?: string;
  offset?: number;
  limit: number;
}

export interface LowQualityTurnsPage {
  items: LowQualityTurn[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SetTriageStateInput {
  assistantMessageId: string;
  state: QualityTriageState;
  expectedVersion: number;
  resolution?: QualityResolution | null;
  /** Deprecated opaque compatibility text. Never interpreted as a reason code. */
  legacyReason?: string | null;
  updatedBy?: string | null;
}

export interface ValidatedQualityTriageUpdate {
  state: QualityTriageState;
  expectedVersion: number;
  resolution: QualityResolution | null;
  legacyReason: string | null;
}

export type SetTriageStateResult =
  | { kind: "updated"; record: QualityTriageRecord }
  | { kind: "conflict"; current: QualityTriageRecord }
  | { kind: "not_found" };

export type QualityStatsRange = "7d" | "30d";

export const QUALITY_STATS_RANGES: readonly QualityStatsRange[] = ["7d", "30d"];

/**
 * A rate and the population it is defined over. The denominator ships with the count so
 * the caller can tell "no failures out of 500 turns" from "no failures out of 2".
 */
export interface QualityStatsMetric {
  count: number;
  denominator: number;
  /** `count / denominator`, or null when the denominator is zero. */
  rate: number | null;
}

export interface QualityStatsWindow {
  /** ISO 8601, inclusive. */
  from: string;
  /** ISO 8601, exclusive. */
  to: string;
  turnCount: number;
  /** Grounded answers over turns that attempted one (grounded + grounding gaps). */
  grounded: QualityStatsMetric;
  /** Down-voted turns over rated turns. */
  negativeFeedback: QualityStatsMetric;
  /** Failed skill dispatches over all turns. */
  skillFailures: QualityStatsMetric;
}

export interface QualityStatsBucket {
  /** UTC day, `YYYY-MM-DD`. Present for every day in the window, zero-filled. */
  date: string;
  turnCount: number;
  grounded: QualityStatsMetric;
  negativeFeedback: QualityStatsMetric;
  skillFailures: QualityStatsMetric;
}

export interface QualityStatsInput {
  range: QualityStatsRange;
  agentId?: string;
  channel?: string;
}

export interface QualityStats {
  range: QualityStatsRange;
  filters: { agentId?: string; channel?: string };
  current: QualityStatsWindow;
  /** Equal length, immediately preceding the current window. */
  previous: QualityStatsWindow;
  /** Current window only, one entry per UTC day. */
  buckets: QualityStatsBucket[];
  /**
   * Active-triage counts per signal. All-time and range-independent, so an untriaged
   * turn older than the window is never silently hidden from the operator.
   */
  backlog: Record<QualitySignalId, number>;
  resolutionBreakdown: QualityResolutionBreakdownEntry[];
}

export interface QualityResolutionBreakdownEntry {
  state: "resolved" | "dismissed";
  reason: QualityResolutionReasonOrUnspecified;
  count: number;
}

export interface QualityStatsServicePort {
  getQualityStats(workspaceId: string, input: QualityStatsInput): Promise<QualityStats>;
}

export interface QualityTurnsServicePort {
  listLowQualityTurns(workspaceId: string, input: ListLowQualityTurnsInput): Promise<LowQualityTurnsPage>;
  /** Conditionally transitions triage using the caller's observed version. */
  setTriageState(workspaceId: string, input: SetTriageStateInput): Promise<SetTriageStateResult>;
}
