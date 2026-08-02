import { CompiledQuery } from "kysely";

import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  LowQualityTurn,
  QualityFeedbackValue,
  QualityResolutionReason,
  QualityTriageState,
  QualityVerification,
} from "./contracts/index.js";
import type { GroundingDiagnosticRow } from "./groundingDiagnostic.js";
import { mapGroundingDiagnostic } from "./groundingDiagnostic.js";

export type QualityTurnReadRow = GroundingDiagnosticRow & {
  assistant_message_id: string;
  conversation_id: string;
  agent_id: string | null;
  agent_name: string | null;
  source_channel: string | null;
  answer_content: string;
  skill_name: string | null;
  skill_outcome: string | null;
  skill_status: string | null;
  total_latency_ms: number | string | null;
  user_question: string | null;
  up_count: string | number;
  down_count: string | number;
  latest_down_updated_at: Date | string | null;
  created_at: Date | string;
  triage_state: string;
  triage_version: number | string;
  triage_resolution_reason: string | null;
  triage_resolution_note: string | null;
  triage_legacy_reason: string | null;
  triage_closed_at: Date | string | null;
  triage_updated_at: Date | string | null;
};

type QualityTurnCommentRow = {
  assistant_message_id: string;
  value: QualityFeedbackValue;
  comment: string;
  created_at: Date | string;
  updated_at: Date | string;
};

const PREVIEW_LIMIT = 240;

export const serializeQualityDate = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const buildPreview = (value: string | null): string => {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > PREVIEW_LIMIT
    ? `${normalized.slice(0, PREVIEW_LIMIT - 3)}...`
    : normalized;
};

export const mapQualityTurnReadRow = (input: {
  row: QualityTurnReadRow;
  comments: LowQualityTurn["feedback"]["comments"];
  verification: QualityVerification | null;
}): LowQualityTurn => {
  const { row } = input;
  return {
    assistantMessageId: row.assistant_message_id,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    channel: row.source_channel,
    question: buildPreview(row.user_question) || null,
    answerPreview: buildPreview(row.answer_content),
    skillName: row.skill_name,
    skillOutcome: row.skill_outcome,
    skillStatus: row.skill_status,
    totalLatencyMs: row.total_latency_ms === null ? null : Number(row.total_latency_ms),
    grounding: mapGroundingDiagnostic(row),
    createdAt: serializeQualityDate(row.created_at),
    feedback: {
      upCount: Number(row.up_count),
      downCount: Number(row.down_count),
      latestDownUpdatedAt: row.latest_down_updated_at === null
        ? null
        : serializeQualityDate(row.latest_down_updated_at),
      comments: input.comments,
    },
    triage: {
      state: row.triage_state as QualityTriageState,
      version: Number(row.triage_version),
      resolution: row.triage_resolution_reason === null
        ? null
        : {
            reason: row.triage_resolution_reason as QualityResolutionReason,
            note: row.triage_resolution_note,
          },
      legacyReason: row.triage_legacy_reason,
      closedAt: row.triage_closed_at === null ? null : serializeQualityDate(row.triage_closed_at),
      updatedAt: row.triage_updated_at === null ? null : serializeQualityDate(row.triage_updated_at),
    },
    verification: input.verification,
  };
};

export const fetchQualityTurnComments = async (
  db: Db,
  workspaceId: string,
  assistantMessageIds: string[],
): Promise<Map<string, LowQualityTurn["feedback"]["comments"]>> => {
  const grouped = new Map<string, LowQualityTurn["feedback"]["comments"]>();
  if (assistantMessageIds.length === 0) return grouped;

  const result = await db.executeQuery<QualityTurnCommentRow>(
    CompiledQuery.raw(
      `SELECT assistant_message_id, value, comment, created_at, updated_at
       FROM assistant_answer_feedback
       WHERE workspace_id = $1
         AND assistant_message_id = ANY($2::uuid[])
         AND comment IS NOT NULL
       ORDER BY created_at ASC, id ASC`,
      [workspaceId, assistantMessageIds],
    ),
  );

  for (const row of result.rows) {
    const entries = grouped.get(row.assistant_message_id) ?? [];
    entries.push({
      value: row.value,
      comment: row.comment,
      createdAt: serializeQualityDate(row.created_at),
      updatedAt: serializeQualityDate(row.updated_at),
    });
    grouped.set(row.assistant_message_id, entries);
  }
  return grouped;
};
