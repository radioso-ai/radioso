import { CompiledQuery } from "kysely";

import type { GroundingDiagnosticSnapshot } from "../../shared/domain/groundingDiagnostic.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  LowQualityTurnsPage,
  QualityResolutionReasonOrUnspecified,
  QualityTriageState,
  QualityVerification,
  QualityVerificationSourcePort,
} from "./contracts/index.js";
import type {
  QualityContentPlanningEvidenceSourcePort,
  QualityContentPlanningPopulationCursor,
  QualityContentPlanningPopulationPage,
  QualityContentPlanningPopulationTurn,
  QualityContentPlanningRemediationInactivityReason,
  QualityContentPlanningTurnEvidence,
  QualityContentPlanningWindow,
} from "./contracts/contentPlanningEvidence.js";
export type {
  QualityContentPlanningEvidenceSourcePort,
  QualityContentPlanningPopulationCursor,
  QualityContentPlanningPopulationPage,
  QualityContentPlanningPopulationTurn,
  QualityContentPlanningRemediationInactivityReason,
  QualityContentPlanningTurnEvidence,
  QualityContentPlanningWindow,
} from "./contracts/contentPlanningEvidence.js";
import {
  mapGroundingDiagnostic,
  type GroundingDiagnosticRow,
} from "./groundingDiagnostic.js";
import {
  RESOLVED_LATENCY_EXPRESSION,
  TRIAGE_JOIN,
  TURN_POPULATION_SOURCE,
  bindParam,
  buildEffectiveOpenPredicate,
  buildEffectiveTriageStateExpression,
  buildTurnPopulationFilters,
} from "./turnPopulationSql.js";
import {
  fetchQualityTurnComments,
  mapQualityTurnReadRow,
  serializeQualityDate,
  type QualityTurnReadRow,
} from "./turnReadModel.js";

const MAX_POPULATION_PAGE_SIZE = 500;
const MAX_EVIDENCE_BATCH_SIZE = 500;
const MAX_MEMBER_PAGE_SIZE = 100;

type PopulationRow = {
  assistant_message_id: string;
  user_message_id: string | null;
  conversation_id: string;
  agent_id: string | null;
  source_channel: string | null;
  created_at: Date | string;
};

type EvidenceRow = GroundingDiagnosticRow & {
  assistant_message_id: string;
  conversation_id: string;
  agent_id: string | null;
  source_channel: string | null;
  created_at: Date | string;
  triage_state: QualityTriageState;
  triage_resolution_reason: string | null;
  triage_reopened_by_feedback: boolean;
};

export class QualityContentPlanningEvidenceSource implements QualityContentPlanningEvidenceSourcePort {
  constructor(
    private readonly db: Db,
    private readonly verificationSource?: QualityVerificationSourcePort,
  ) {}

  async countPopulation(
    workspaceId: string,
    input: { window: QualityContentPlanningWindow },
  ): Promise<number> {
    validateWindow(input.window);
    const params: unknown[] = [];
    const filters = buildTurnPopulationFilters({ workspaceId }, params);
    filters.push(`m.created_at >= ${bindParam(params, input.window.from)}::timestamptz`);
    filters.push(`m.created_at < ${bindParam(params, input.window.to)}::timestamptz`);
    const result = await this.db.executeQuery<{ count: string }>(CompiledQuery.raw(
      `SELECT COUNT(*)::text AS count
       ${TURN_POPULATION_SOURCE}
       WHERE ${filters.join("\n         AND ")}`,
      params,
    ));
    return Number(result.rows[0]?.count ?? "0");
  }

  async listPopulationPage(
    workspaceId: string,
    input: {
      window: QualityContentPlanningWindow;
      cursor?: QualityContentPlanningPopulationCursor;
      limit: number;
    },
  ): Promise<QualityContentPlanningPopulationPage> {
    validateWindow(input.window);
    const limit = boundedInteger(input.limit, 1, MAX_POPULATION_PAGE_SIZE, "population page limit");
    if (input.cursor && (
      input.cursor.windowFrom !== input.window.from
      || input.cursor.windowTo !== input.window.to
    )) {
      throw new Error("population cursor window does not match the requested window");
    }

    const params: unknown[] = [];
    const filters = buildTurnPopulationFilters({ workspaceId }, params);
    filters.push(`m.created_at >= ${bindParam(params, input.window.from)}::timestamptz`);
    filters.push(`m.created_at < ${bindParam(params, input.window.to)}::timestamptz`);
    if (input.cursor) {
      const createdAtParam = bindParam(params, input.cursor.createdAt);
      const messageIdParam = bindParam(params, input.cursor.assistantMessageId);
      filters.push(`(
           m.created_at > ${createdAtParam}::timestamptz
           OR (m.created_at = ${createdAtParam}::timestamptz AND m.id > ${messageIdParam}::uuid)
         )`);
    }
    const limitParam = bindParam(params, limit + 1);

    const result = await this.db.executeQuery<PopulationRow>(CompiledQuery.raw(
      `SELECT
         m.id AS assistant_message_id,
         m.conversation_id,
         c.agent_id,
         c.source_channel,
         m.created_at,
         (
           SELECT um.id
           FROM messages um
           WHERE um.workspace_id = m.workspace_id
             AND um.conversation_id = m.conversation_id
             AND um.role = 'user'
             AND um.created_at <= m.created_at
           ORDER BY um.created_at DESC, um.id DESC
           LIMIT 1
         ) AS user_message_id
       ${TURN_POPULATION_SOURCE}
       WHERE ${filters.join("\n         AND ")}
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT ${limitParam}`,
      params,
    ));

    const hasNext = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map(mapPopulationRow);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasNext && last
        ? {
            createdAt: last.createdAt,
            assistantMessageId: last.assistantMessageId,
            windowFrom: input.window.from,
            windowTo: input.window.to,
          }
        : null,
    };
  }

  async getEvidenceByAssistantMessageIds(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<ReadonlyMap<string, QualityContentPlanningTurnEvidence>> {
    const ids = uniqueBoundedIds(assistantMessageIds, MAX_EVIDENCE_BATCH_SIZE, "evidence batch");
    if (ids.length === 0) return new Map();

    const params: unknown[] = [];
    const filters = buildTurnPopulationFilters({ workspaceId }, params);
    filters.push(`m.id = ANY(${bindParam(params, ids)}::uuid[])`);
    const feedbackFreshnessExpression = "quality_feedback.latest_down_updated_at";
    const effectiveTriageOptions = {
      latestDownUpdatedAtExpression: feedbackFreshnessExpression,
    };
    const effectiveOpen = buildEffectiveOpenPredicate(effectiveTriageOptions);
    const feedbackFreshnessJoin = `LEFT JOIN LATERAL (
         SELECT MAX(feedback.updated_at) AS latest_down_updated_at
         FROM assistant_answer_feedback feedback
         WHERE feedback.workspace_id = m.workspace_id
           AND feedback.assistant_message_id = m.id
           AND feedback.value = 'down'
       ) quality_feedback ON TRUE`;
    const result = await this.db.executeQuery<EvidenceRow>(CompiledQuery.raw(
      `SELECT
         m.id AS assistant_message_id,
         m.conversation_id,
         c.agent_id,
         c.source_channel,
         m.created_at,
         m.grounding_verdict,
         m.grounding_claim_count,
         m.grounding_sourced_claim_count,
         m.grounding_unsourced_claim_count,
         m.grounding_invalid_source_count,
         ${buildEffectiveTriageStateExpression(effectiveTriageOptions)} AS triage_state,
         CASE
           WHEN ${effectiveOpen} THEN NULL
           WHEN tr.state IN ('resolved', 'dismissed') THEN tr.resolution_reason
           ELSE NULL
         END AS triage_resolution_reason,
         (${effectiveOpen}) AS triage_reopened_by_feedback
       ${TURN_POPULATION_SOURCE}
       ${TRIAGE_JOIN}
       ${feedbackFreshnessJoin}
       WHERE ${filters.join("\n         AND ")}
       ORDER BY m.created_at ASC, m.id ASC`,
      params,
    ));

    const eligibleIds = result.rows.map((row) => row.assistant_message_id);
    const verifications = this.verificationSource
      ? await this.verificationSource.getByAssistantMessageIds(workspaceId, eligibleIds)
      : new Map<string, QualityVerification>();

    return new Map(result.rows.map((row) => {
      const verification = verifications.get(row.assistant_message_id) ?? null;
      const grounding = mapGroundingDiagnostic(row);
      return [row.assistant_message_id, mapEvidenceRow(row, grounding, verification)] as const;
    }));
  }

  async mapMemberTurnPage(
    workspaceId: string,
    input: {
      assistantMessageIds: string[];
      total: number;
      page: number;
      pageSize: number;
    },
  ): Promise<LowQualityTurnsPage> {
    const page = boundedInteger(input.page, 1, Number.MAX_SAFE_INTEGER, "member page");
    const pageSize = boundedInteger(input.pageSize, 1, MAX_MEMBER_PAGE_SIZE, "member page size");
    const total = boundedInteger(input.total, 0, Number.MAX_SAFE_INTEGER, "member total");
    const ids = uniqueBoundedIds(input.assistantMessageIds, pageSize, "member page ids");
    if (ids.length === 0) {
      return {
        items: [],
        total,
        page: total === 0 ? 1 : page,
        pageSize,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      };
    }

    const params: unknown[] = [];
    const filters = buildTurnPopulationFilters({ workspaceId }, params);
    const idsParam = bindParam(params, ids);
    filters.push(`m.id = ANY(${idsParam}::uuid[])`);
    const effectiveOpen = buildEffectiveOpenPredicate({
      latestDownUpdatedAtExpression: "feedback_activity.latest_down_updated_at",
    });
    const feedbackActivityJoin = `LEFT JOIN LATERAL (
         SELECT
           COUNT(*) FILTER (WHERE f.value = 'up')::text AS up_count,
           COUNT(*) FILTER (WHERE f.value = 'down')::text AS down_count,
           MAX(f.updated_at) FILTER (WHERE f.value = 'down') AS latest_down_updated_at
         FROM assistant_answer_feedback f
         WHERE f.workspace_id = m.workspace_id
           AND f.assistant_message_id = m.id
       ) feedback_activity ON TRUE`;

    const result = await this.db.executeQuery<QualityTurnReadRow>(CompiledQuery.raw(
      `SELECT
         m.id AS assistant_message_id,
         m.conversation_id,
         c.agent_id,
         a.name AS agent_name,
         c.source_channel,
         m.content AS answer_content,
         m.skill_name,
         m.skill_outcome,
         m.skill_status,
         m.grounding_verdict,
         m.grounding_claim_count,
         m.grounding_sourced_claim_count,
         m.grounding_unsourced_claim_count,
         m.grounding_invalid_source_count,
         ${RESOLVED_LATENCY_EXPRESSION} AS total_latency_ms,
         m.created_at,
         ${buildEffectiveTriageStateExpression({
           latestDownUpdatedAtExpression: "feedback_activity.latest_down_updated_at",
         })} AS triage_state,
         COALESCE(tr.version, 0) AS triage_version,
         CASE WHEN ${effectiveOpen} THEN NULL ELSE tr.resolution_reason END AS triage_resolution_reason,
         CASE WHEN ${effectiveOpen} THEN NULL ELSE tr.resolution_note END AS triage_resolution_note,
         CASE WHEN ${effectiveOpen} THEN NULL ELSE tr.reason END AS triage_legacy_reason,
         CASE WHEN ${effectiveOpen} THEN NULL ELSE tr.closed_at END AS triage_closed_at,
         CASE WHEN ${effectiveOpen} THEN NULL ELSE tr.updated_at END AS triage_updated_at,
         (
           SELECT um.content
           FROM messages um
           WHERE um.workspace_id = m.workspace_id
             AND um.conversation_id = m.conversation_id
             AND um.role = 'user'
             AND um.created_at <= m.created_at
           ORDER BY um.created_at DESC, um.id DESC
           LIMIT 1
         ) AS user_question,
         COALESCE(feedback_activity.up_count, '0') AS up_count,
         COALESCE(feedback_activity.down_count, '0') AS down_count,
         feedback_activity.latest_down_updated_at
       ${TURN_POPULATION_SOURCE}
       LEFT JOIN agents a ON a.id = c.agent_id
       ${TRIAGE_JOIN}
       ${feedbackActivityJoin}
       WHERE ${filters.join("\n         AND ")}
       ORDER BY array_position(${idsParam}::uuid[], m.id) ASC`,
      params,
    ));

    const eligibleIds = result.rows.map((row) => row.assistant_message_id);
    const [comments, verifications] = await Promise.all([
      fetchQualityTurnComments(this.db, workspaceId, eligibleIds),
      this.verificationSource
        ? this.verificationSource.getByAssistantMessageIds(workspaceId, eligibleIds)
        : Promise.resolve(new Map<string, QualityVerification>()),
    ]);
    return {
      items: result.rows.map((row) => mapQualityTurnReadRow({
        row,
        comments: comments.get(row.assistant_message_id) ?? [],
        verification: verifications.get(row.assistant_message_id) ?? null,
      })),
      total,
      page: total === 0 ? 1 : page,
      pageSize,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    };
  }
}

const mapPopulationRow = (row: PopulationRow): QualityContentPlanningPopulationTurn => ({
  assistantMessageId: row.assistant_message_id,
  userMessageId: row.user_message_id,
  conversationId: row.conversation_id,
  agentId: row.agent_id,
  channel: row.source_channel,
  createdAt: serializeQualityDate(row.created_at),
});

const mapEvidenceRow = (
  row: EvidenceRow,
  grounding: GroundingDiagnosticSnapshot | null,
  verification: QualityVerification | null,
): QualityContentPlanningTurnEvidence => {
  const state = row.triage_state;
  const inactiveReasons = resolveRemediationInactivityReasons({ grounding, state, verification });
  return {
    assistantMessageId: row.assistant_message_id,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    channel: row.source_channel,
    createdAt: serializeQualityDate(row.created_at),
    grounding,
    triage: {
      state,
      resolutionReason: state === "resolved" || state === "dismissed"
        ? (row.triage_resolution_reason as QualityResolutionReasonOrUnspecified | null) ?? "unspecified"
        : null,
      reopenedByNewerNegativeFeedback: Boolean(row.triage_reopened_by_feedback),
    },
    verification,
    remediation: {
      active: inactiveReasons.length === 0,
      inactiveReasons,
    },
  };
};

const resolveRemediationInactivityReasons = (input: {
  grounding: GroundingDiagnosticSnapshot | null;
  state: QualityTriageState;
  verification: QualityVerification | null;
}): QualityContentPlanningRemediationInactivityReason[] => {
  if (!input.grounding) return ["not_evaluated"];
  if (input.grounding.verdict === "grounded") return ["grounded_answer"];

  const reasons: QualityContentPlanningRemediationInactivityReason[] = [];
  if (input.state === "resolved") reasons.push("triage_resolved");
  if (input.state === "dismissed") reasons.push("triage_dismissed");
  if (input.verification?.caseStatus === "passing") reasons.push("passing_eval");
  return reasons;
};

const uniqueBoundedIds = (ids: string[], maximum: number, label: string): string[] => {
  const unique = [...new Set(ids)];
  if (unique.length > maximum) throw new RangeError(`${label} exceeds ${maximum}`);
  return unique;
};

const boundedInteger = (value: number, minimum: number, maximum: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const validateWindow = (window: QualityContentPlanningWindow): void => {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new RangeError("population window must contain valid increasing instants");
  }
};
