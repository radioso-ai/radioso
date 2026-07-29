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
  comments: Array<{
    value: QualityFeedbackValue;
    comment: string;
    createdAt: string;
  }>;
}

export interface LowQualityTurn {
  assistantMessageId: string;
  conversationId: string;
  agentId: string | null;
  agentName: string | null;
  channel: string | null;
  question: string | null;
  answerPreview: string;
  skillName: string | null;
  skillOutcome: string | null;
  skillStatus: string | null;
  totalLatencyMs: number | null;
  createdAt: string;
  feedback: QualityFeedbackSummary;
  triage: QualityTriageRecord;
}

export interface QualityTriageRecord {
  state: QualityTriageState;
  reason: string | null;
  updatedAt: string | null;
}

export interface ListLowQualityTurnsInput {
  /**
   * Narrows to one operator signal, resolved server-side from the skill catalog. Layered
   * on top of the explicit filters below rather than replacing them.
   */
  signal?: QualitySignalId;
  actions?: QualityActionFilter[];
  statuses?: QualitySkillStatus[];
  feedbackValues?: QualityFeedbackValue[];
  triageStates?: QualityTriageState[];
  /** true returns turns with written feedback comments; false returns turns without them. */
  hasComment?: boolean;
  minTotalLatencyMs?: number;
  maxTotalLatencyMs?: number;
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
  reason?: string | null;
  updatedBy?: string | null;
}

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
}

export interface QualityStatsServicePort {
  getQualityStats(workspaceId: string, input: QualityStatsInput): Promise<QualityStats>;
}

export interface QualityTurnsServicePort {
  listLowQualityTurns(workspaceId: string, input: ListLowQualityTurnsInput): Promise<LowQualityTurnsPage>;
  /**
   * Upserts the triage state for an assistant turn. Returns the stored record,
   * or null when the turn does not exist in the workspace.
   */
  setTriageState(workspaceId: string, input: SetTriageStateInput): Promise<QualityTriageRecord | null>;
}
