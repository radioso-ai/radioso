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

export interface QualityTurnsServicePort {
  listLowQualityTurns(workspaceId: string, input: ListLowQualityTurnsInput): Promise<LowQualityTurnsPage>;
  /**
   * Upserts the triage state for an assistant turn. Returns the stored record,
   * or null when the turn does not exist in the workspace.
   */
  setTriageState(workspaceId: string, input: SetTriageStateInput): Promise<QualityTriageRecord | null>;
}
