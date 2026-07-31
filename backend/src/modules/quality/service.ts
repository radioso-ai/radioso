import { CompiledQuery } from "kysely";

import { systemClock, type Clock } from "../../shared/domain/clock.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  ListLowQualityTurnsInput,
  LowQualityTurn,
  LowQualityTurnsPage,
  QualityFeedbackValue,
  QualityResolutionReason,
  QualitySignalId,
  QualityStats,
  QualityStatsInput,
  QualityStatsServicePort,
  QualityTriageState,
  QualityTurnsServicePort,
  QualityVerificationSourcePort,
  SetTriageStateResult,
  SetTriageStateInput,
} from "./contracts/index.js";
import { QUALITY_SIGNAL_IDS } from "./contracts/index.js";
import {
  resolveGroundedOutcomeTuples,
  resolveQualitySignalPredicate,
  type GroundedOutcomeTuples,
  type QualityOutcomeCatalogPort,
} from "./domain/qualitySignals.js";
import {
  buildEmptyQualityStatsBuckets,
  buildQualityResolutionBreakdownQuery,
  buildQualityStatsBacklogQuery,
  buildQualityStatsDailyQuery,
  mergeQualityStatsBuckets,
  resolveQualityStatsWindows,
  summarizeQualityStatsWindow,
  type QualityBacklogRow,
  type QualityResolutionBreakdownRow,
  type QualityStatsAggregateRow,
} from "./statsQuery.js";
import {
  RESOLVED_LATENCY_EXPRESSION,
  TRIAGE_JOIN,
  TURN_POPULATION_SOURCE,
  bindParam,
  buildActionTuplePredicate,
  buildAnySignalPredicate,
  buildEffectiveOpenPredicate,
  buildEffectiveTriageStateExpression,
  buildFeedbackExistsPredicate,
  buildTurnPopulationFilters,
  type SqlQuery,
} from "./turnPopulationSql.js";
import {
  buildGroundingCountPresencePredicate,
  buildGroundingVerdictPredicate,
  mapGroundingDiagnostic,
  type GroundingDiagnosticRow,
} from "./groundingDiagnostic.js";
import { validateQualityTriageUpdate } from "./domain/resolution.js";
import { QualityTriageStore } from "./triageStore.js";

type TurnRow = GroundingDiagnosticRow & {
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
  up_count: string;
  down_count: string;
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

type CommentRow = {
  assistant_message_id: string;
  value: QualityFeedbackValue;
  comment: string;
  created_at: Date | string;
  updated_at: Date | string;
};

const MAX_LIMIT = 100;
const PREVIEW_LIMIT = 240;
const DEFAULT_LIMIT = 25;

const serializeDate = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const buildPreview = (value: string | null): string => {
  if (!value) {
    return "";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > PREVIEW_LIMIT ? `${normalized.slice(0, PREVIEW_LIMIT - 3)}...` : normalized;
};

const clampLimit = (limit: number): number => {
  if (!Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.trunc(limit));
};

const clampOffset = (offset: number | undefined): number => {
  if (offset === undefined || !Number.isFinite(offset) || offset < 0) {
    return 0;
  }
  return Math.trunc(offset);
};

export class QualityTurnsService implements QualityTurnsServicePort, QualityStatsServicePort {
  constructor(
    private readonly db: Db,
    private readonly outcomeCatalog: QualityOutcomeCatalogPort,
    private readonly clock: Clock = systemClock,
    private readonly verificationSource?: QualityVerificationSourcePort,
  ) {}

  async listLowQualityTurns(workspaceId: string, input: ListLowQualityTurnsInput): Promise<LowQualityTurnsPage> {
    const limit = clampLimit(input.limit);
    const offset = clampOffset(input.offset);
    const params: unknown[] = [];
    // The shared turn population: assistant turns in this workspace, minus operator-test
    // traffic and human-authored replies. `/quality/stats` selects from the same predicate,
    // so a signal's count always matches the rows behind it.
    const filters = buildTurnPopulationFilters(
      { workspaceId, agentId: input.agentId, channel: input.channel },
      params,
    );

    const actions = input.actions ?? [];
    const statuses = input.statuses ?? [];
    const feedbackValues = input.feedbackValues ?? [];
    const triageStates = input.triageStates ?? [];
    const resolutionReasons = [...new Set(input.resolutionReasons ?? [])];
    const sort = input.sort ?? "turn_created_at";
    const activeNegativeFeedbackOnly = input.activeNegativeFeedbackOnly ?? false;
    const effectiveOpenExpression = buildEffectiveOpenPredicate({
      latestDownUpdatedAtExpression: "feedback_activity.latest_down_updated_at",
    });
    const effectiveTriageStateExpression = buildEffectiveTriageStateExpression({
      latestDownUpdatedAtExpression: "feedback_activity.latest_down_updated_at",
    });

    // Signals are server-resolved predicates layered on top of the explicit filters, never
    // a replacement for them: OR within the signal list, AND with everything else. The list
    // is de-duplicated so a repeated id costs no extra clause.
    const signals = [...new Set(input.signals ?? [])];
    if (signals.length > 0) {
      const tuples = await this.loadGroundedOutcomeTuples(workspaceId);
      filters.push(
        buildAnySignalPredicate(
          signals.map((signal) => resolveQualitySignalPredicate(signal, tuples)),
          params,
        ),
      );
    }

    if (actions.length > 0) {
      filters.push(buildActionTuplePredicate(actions, params));
    }

    if (statuses.length > 0) {
      filters.push(`m.skill_status = ANY(${bindParam(params, statuses)}::text[])`);
    }

    const groundingVerdicts = [...new Set(input.groundingVerdicts ?? [])];
    if (groundingVerdicts.length > 0) {
      filters.push(buildGroundingVerdictPredicate(groundingVerdicts, params));
    }
    if (input.hasUnsourcedClaims !== undefined) {
      filters.push(buildGroundingCountPresencePredicate(
        "grounding_unsourced_claim_count",
        input.hasUnsourcedClaims,
      ));
    }
    if (input.hasInvalidSources !== undefined) {
      filters.push(buildGroundingCountPresencePredicate(
        "grounding_invalid_source_count",
        input.hasInvalidSources,
      ));
    }

    if (triageStates.length > 0) {
      filters.push(`${effectiveTriageStateExpression} = ANY(${bindParam(params, triageStates)}::text[])`);
    }

    const hasResolutionFilter = resolutionReasons.length > 0
      || input.resolutionFrom !== undefined
      || input.resolutionTo !== undefined;
    if (hasResolutionFilter) {
      filters.push(`NOT (${effectiveOpenExpression})`);
    }

    if (resolutionReasons.length > 0) {
      const typedReasons = resolutionReasons.filter((reason) => reason !== "unspecified");
      const predicates: string[] = [];
      if (typedReasons.length > 0) {
        predicates.push(`tr.resolution_reason = ANY(${bindParam(params, typedReasons)}::text[])`);
      }
      if (resolutionReasons.includes("unspecified")) {
        predicates.push(
          `(tr.state IN ('resolved', 'dismissed') AND tr.resolution_reason IS NULL)`,
        );
      }
      filters.push(`(${predicates.join(" OR ")})`);
    }

    if (feedbackValues.length > 0) {
      filters.push(buildFeedbackExistsPredicate(feedbackValues, params));
    }

    if (input.hasComment !== undefined) {
      const commentFeedbackConstraint = feedbackValues.length > 0
        ? `\n             AND f.value = ANY(${bindParam(params, feedbackValues)}::text[])`
        : "";
      if (input.hasComment) {
        filters.push(
          `EXISTS (
           SELECT 1 FROM assistant_answer_feedback f
           WHERE f.assistant_message_id = m.id
             AND f.comment IS NOT NULL${commentFeedbackConstraint}
         )`,
        );
      } else {
        filters.push(
          `NOT EXISTS (
           SELECT 1 FROM assistant_answer_feedback f
           WHERE f.assistant_message_id = m.id
             AND f.comment IS NOT NULL${commentFeedbackConstraint}
         )`,
        );
      }
    }

    if (input.minTotalLatencyMs !== undefined) {
      filters.push(`${RESOLVED_LATENCY_EXPRESSION} >= ${bindParam(params, input.minTotalLatencyMs)}`);
    }

    if (input.maxTotalLatencyMs !== undefined) {
      filters.push(`${RESOLVED_LATENCY_EXPRESSION} <= ${bindParam(params, input.maxTotalLatencyMs)}`);
    }

    if (input.from) {
      filters.push(`m.created_at >= ${bindParam(params, input.from)}::timestamptz`);
    }

    if (input.to) {
      filters.push(`m.created_at <= ${bindParam(params, input.to)}::timestamptz`);
    }

    if (input.resolutionFrom) {
      filters.push(`tr.closed_at >= ${bindParam(params, input.resolutionFrom)}::timestamptz`);
    }

    if (input.resolutionTo) {
      filters.push(`tr.closed_at < ${bindParam(params, input.resolutionTo)}::timestamptz`);
    }

    if (activeNegativeFeedbackOnly) {
      filters.push(
        `feedback_activity.latest_down_updated_at IS NOT NULL
         AND ${effectiveTriageStateExpression} IN ('open', 'acknowledged')`,
      );
    }

    const whereClause = filters.join("\n         AND ");

    // The list query always projects triage state, so it joins unconditionally
    // below. The count query only needs the join when a triage filter is set.
    const countUsesEffectiveTriage = triageStates.length > 0
      || resolutionReasons.length > 0
      || input.resolutionFrom !== undefined
      || input.resolutionTo !== undefined
      || activeNegativeFeedbackOnly;
    const countTriageJoin = countUsesEffectiveTriage
      ? TRIAGE_JOIN
      : "";
    const feedbackActivityJoin =
      `LEFT JOIN LATERAL (
         SELECT
           COUNT(*) FILTER (WHERE f.value = 'up')::text AS up_count,
           COUNT(*) FILTER (WHERE f.value = 'down')::text AS down_count,
           MAX(f.updated_at) FILTER (WHERE f.value = 'down') AS latest_down_updated_at
         FROM assistant_answer_feedback f
         WHERE f.workspace_id = m.workspace_id
           AND f.assistant_message_id = m.id
       ) feedback_activity ON TRUE`;
    const countFeedbackActivityJoin = countUsesEffectiveTriage
      ? feedbackActivityJoin
      : "";

    const totalResult = await this.db.executeQuery<{ total: string }>(
      CompiledQuery.raw(
        `SELECT COUNT(*)::text AS total
       ${TURN_POPULATION_SOURCE}
       ${countTriageJoin}
       ${countFeedbackActivityJoin}
       WHERE ${whereClause}`,
        // Pass a copy: CompiledQuery.raw freezes the parameter array, and the
        // list query below extends `params` with limit/offset.
        [...params],
      ),
    );
    const total = Number(totalResult.rows[0]?.total ?? 0);

    params.push(limit);
    const limitParamIndex = params.length;
    params.push(offset);
    const offsetParamIndex = params.length;

    const orderByClause = sort === "negative_feedback_updated_at"
      ? "feedback_activity.latest_down_updated_at DESC NULLS LAST, m.created_at DESC, m.id DESC"
      : "m.created_at DESC, m.id DESC";

    const rowsResult = await this.db.executeQuery<TurnRow>(
      CompiledQuery.raw(
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
         ${effectiveTriageStateExpression} AS triage_state,
         COALESCE(tr.version, 0) AS triage_version,
         CASE WHEN ${effectiveOpenExpression} THEN NULL ELSE tr.resolution_reason END AS triage_resolution_reason,
         CASE WHEN ${effectiveOpenExpression} THEN NULL ELSE tr.resolution_note END AS triage_resolution_note,
         CASE WHEN ${effectiveOpenExpression} THEN NULL ELSE tr.reason END AS triage_legacy_reason,
         CASE WHEN ${effectiveOpenExpression} THEN NULL ELSE tr.closed_at END AS triage_closed_at,
         CASE WHEN ${effectiveOpenExpression} THEN NULL ELSE tr.updated_at END AS triage_updated_at,
         (
           SELECT um.content
           FROM messages um
           WHERE um.conversation_id = m.conversation_id
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
       WHERE ${whereClause}
       ORDER BY ${orderByClause}
       LIMIT $${limitParamIndex}
       OFFSET $${offsetParamIndex}`,
        params,
      ),
    );
    const rows = rowsResult.rows;

    const assistantMessageIds = rows.map((row) => row.assistant_message_id);
    const [commentsByMessageId, verificationByMessageId] = await Promise.all([
      this.fetchComments(workspaceId, assistantMessageIds),
      this.verificationSource
        ? this.verificationSource.getByAssistantMessageIds(workspaceId, assistantMessageIds)
        : Promise.resolve(new Map()),
    ]);

    const items: LowQualityTurn[] = rows.map((row) => ({
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
      createdAt: serializeDate(row.created_at),
      feedback: {
        upCount: Number(row.up_count),
        downCount: Number(row.down_count),
        latestDownUpdatedAt: row.latest_down_updated_at === null
          ? null
          : serializeDate(row.latest_down_updated_at),
        comments: commentsByMessageId.get(row.assistant_message_id) ?? [],
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
        closedAt: row.triage_closed_at === null ? null : serializeDate(row.triage_closed_at),
        updatedAt: row.triage_updated_at === null ? null : serializeDate(row.triage_updated_at),
      },
      verification: verificationByMessageId.get(row.assistant_message_id) ?? null,
    }));

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const page = total === 0 ? 1 : Math.floor(offset / limit) + 1;

    return {
      items,
      total,
      page,
      pageSize: limit,
      totalPages,
    };
  }

  async getQualityStats(workspaceId: string, input: QualityStatsInput): Promise<QualityStats> {
    const windows = resolveQualityStatsWindows(input.range, this.clock());
    const tuples = await this.loadGroundedOutcomeTuples(workspaceId);
    const scope = { workspaceId, agentId: input.agentId, channel: input.channel, tuples };

    // One daily-bucket query spans both windows, and the two window totals are summed from
    // its rows. Every turn falls in exactly one UTC day and every column is a per-turn
    // count, so this is exactly equivalent to querying each window — and it makes `current`,
    // `previous` and `buckets` consistent by construction. Four independent statements would
    // each read their own READ COMMITTED snapshot, letting one response report a turn count
    // its own buckets do not sum to. A REPEATABLE READ transaction would fix that too, at
    // the price of serialising every round trip of a polled endpoint onto one connection.
    //
    // `backlog` stays a separate statement and is deliberately NOT made consistent with the
    // windowed numbers: it answers a different question — all-time active triage, with no
    // date bound at all — so there is no shared total for it to agree with.
    const [dailyRows, backlogRows, resolutionRows] = await Promise.all([
      this.runStatsQuery<QualityStatsAggregateRow>(
        buildQualityStatsDailyQuery({ ...scope, window: windows.span }),
      ),
      this.runStatsQuery<QualityBacklogRow>(buildQualityStatsBacklogQuery(scope)),
      this.runStatsQuery<QualityResolutionBreakdownRow>(
        buildQualityResolutionBreakdownQuery({
          workspaceId,
          agentId: input.agentId,
          channel: input.channel,
          window: windows.current,
        }),
      ),
    ]);

    const backlogRow = backlogRows[0];
    const backlog = Object.fromEntries(
      QUALITY_SIGNAL_IDS.map((signal) => [signal, Number(backlogRow?.[signal] ?? 0)]),
    ) as Record<QualitySignalId, number>;

    return {
      range: input.range,
      filters: {
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.channel ? { channel: input.channel } : {}),
      },
      current: summarizeQualityStatsWindow(windows.current, dailyRows),
      previous: summarizeQualityStatsWindow(windows.previous, dailyRows),
      // Buckets stay scoped to the current window per the contract; the previous window's
      // days are queried only so its totals can be summed.
      buckets: mergeQualityStatsBuckets(buildEmptyQualityStatsBuckets(windows), dailyRows),
      backlog,
      resolutionBreakdown: resolutionRows.map((row) => ({
        state: row.state,
        reason: row.reason as QualityStats["resolutionBreakdown"][number]["reason"],
        count: Number(row.count),
      })),
    };
  }

  private async runStatsQuery<Row>(query: SqlQuery): Promise<Row[]> {
    const result = await this.db.executeQuery<Row>(CompiledQuery.raw(query.text, query.params));
    return result.rows;
  }

  private async loadGroundedOutcomeTuples(workspaceId: string): Promise<GroundedOutcomeTuples> {
    return resolveGroundedOutcomeTuples(await this.outcomeCatalog.listOutcomeCatalog(workspaceId));
  }

  async setTriageState(
    workspaceId: string,
    input: SetTriageStateInput,
  ): Promise<SetTriageStateResult> {
    const update = validateQualityTriageUpdate({
      state: input.state,
      expectedVersion: input.expectedVersion,
      resolution: input.resolution,
      legacyReason: input.legacyReason,
    });
    return new QualityTriageStore(this.db).transition(workspaceId, {
      assistantMessageId: input.assistantMessageId,
      ...update,
      updatedBy: input.updatedBy ?? null,
    });
  }

  private async fetchComments(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<Map<string, LowQualityTurn["feedback"]["comments"]>> {
    const grouped = new Map<string, LowQualityTurn["feedback"]["comments"]>();
    if (assistantMessageIds.length === 0) {
      return grouped;
    }

    const result = await this.db.executeQuery<CommentRow>(
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
        createdAt: serializeDate(row.created_at),
        updatedAt: serializeDate(row.updated_at),
      });
      grouped.set(row.assistant_message_id, entries);
    }

    return grouped;
  }
}
