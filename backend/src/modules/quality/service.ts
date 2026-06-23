import { CompiledQuery } from "kysely";

import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  ListLowQualityTurnsInput,
  LowQualityTurn,
  LowQualityTurnsPage,
  QualityFeedbackValue,
  QualityTriageRecord,
  QualityTriageState,
  QualityTurnsServicePort,
  SetTriageStateInput,
} from "./contracts/index.js";

type TurnRow = {
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
  created_at: Date | string;
  triage_state: string;
  triage_reason: string | null;
  triage_updated_at: Date | string | null;
};

type CommentRow = {
  assistant_message_id: string;
  value: QualityFeedbackValue;
  comment: string;
  created_at: Date | string;
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

export class QualityTurnsService implements QualityTurnsServicePort {
  constructor(private readonly db: Db) {}

  async listLowQualityTurns(workspaceId: string, input: ListLowQualityTurnsInput): Promise<LowQualityTurnsPage> {
    const limit = clampLimit(input.limit);
    const offset = clampOffset(input.offset);
    const params: unknown[] = [workspaceId];
    const filters: string[] = ["m.workspace_id = $1", "m.role = 'assistant'"];

    const actions = input.actions ?? [];
    const statuses = input.statuses ?? [];
    const feedbackValues = input.feedbackValues ?? [];
    const triageStates = input.triageStates ?? [];

    if (actions.length > 0) {
      params.push(actions.map((action) => action.skillName));
      const skillsParam = params.length;
      params.push(actions.map((action) => action.outcome));
      const outcomesParam = params.length;
      filters.push(
        `EXISTS (
           SELECT 1
           FROM unnest($${skillsParam}::text[], $${outcomesParam}::text[]) AS t(skill_name, outcome)
           WHERE t.skill_name = m.skill_name AND t.outcome = m.skill_outcome
         )`,
      );
    }

    if (statuses.length > 0) {
      params.push(statuses);
      filters.push(`m.skill_status = ANY($${params.length}::text[])`);
    }

    if (triageStates.length > 0) {
      params.push(triageStates);
      filters.push(`COALESCE(tr.state, 'open') = ANY($${params.length}::text[])`);
    }

    if (feedbackValues.length > 0) {
      params.push(feedbackValues);
      filters.push(
        `EXISTS (
           SELECT 1 FROM assistant_answer_feedback f
           WHERE f.assistant_message_id = m.id
             AND f.value = ANY($${params.length}::text[])
         )`,
      );
    }

    if (input.hasComment === true) {
      filters.push(
        `EXISTS (
           SELECT 1 FROM assistant_answer_feedback f
           WHERE f.assistant_message_id = m.id
             AND f.comment IS NOT NULL
         )`,
      );
    } else if (input.hasComment === false) {
      filters.push(
        `NOT EXISTS (
           SELECT 1 FROM assistant_answer_feedback f
           WHERE f.assistant_message_id = m.id
             AND f.comment IS NOT NULL
         )`,
      );
    }

    if (input.minTotalLatencyMs !== undefined) {
      params.push(input.minTotalLatencyMs);
      filters.push(`turn_event.total_latency_ms >= $${params.length}`);
    }

    if (input.maxTotalLatencyMs !== undefined) {
      params.push(input.maxTotalLatencyMs);
      filters.push(`turn_event.total_latency_ms <= $${params.length}`);
    }

    if (input.agentId) {
      params.push(input.agentId);
      filters.push(`c.agent_id = $${params.length}`);
    }

    if (input.channel) {
      params.push(input.channel);
      filters.push(`c.source_channel = $${params.length}`);
    }

    if (input.from) {
      params.push(input.from);
      filters.push(`m.created_at >= $${params.length}::timestamptz`);
    }

    if (input.to) {
      params.push(input.to);
      filters.push(`m.created_at <= $${params.length}::timestamptz`);
    }

    const needsLatency = input.minTotalLatencyMs !== undefined || input.maxTotalLatencyMs !== undefined;

    const whereClause = filters.join("\n         AND ");

    // The audit-event lateral join is only needed to project per-turn latency.
    // The count query can skip it unless a latency filter is set, since the
    // count itself doesn't need the latency value. The list query always reads
    // latency for the row.
    // TODO(#follow-up): store totalLatencyMs on `messages` at write time so the
    // dashboard read path stops scanning audit_events.metadata_json.
    const countLatencyJoin = needsLatency
      ? `LEFT JOIN LATERAL (
         SELECT
           CASE
             WHEN jsonb_typeof(ae.metadata_json #> '{activityTrace,totalDurationMs}') = 'number'
               THEN ((ae.metadata_json #>> '{activityTrace,totalDurationMs}')::numeric)::int
             ELSE NULL
           END AS total_latency_ms
         FROM audit_events ae
         WHERE ae.workspace_id = m.workspace_id
           AND ae.event_type = 'chat.answer'
           AND ae.metadata_json ->> 'assistantMessageId' = m.id::text
         ORDER BY ae.created_at DESC, ae.id DESC
         LIMIT 1
       ) turn_event ON TRUE`
      : "";

    // The list query always projects triage state, so it joins unconditionally
    // below. The count query only needs the join when a triage filter is set.
    const triageJoin =
      `LEFT JOIN assistant_answer_triage tr
         ON tr.workspace_id = m.workspace_id AND tr.assistant_message_id = m.id`;
    const countTriageJoin = triageStates.length > 0 ? triageJoin : "";

    const totalResult = await this.db.executeQuery<{ total: string }>(
      CompiledQuery.raw(
        `SELECT COUNT(*)::text AS total
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.workspace_id = m.workspace_id
       ${countLatencyJoin}
       ${countTriageJoin}
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
         turn_event.total_latency_ms,
         m.created_at,
         COALESCE(tr.state, 'open') AS triage_state,
         tr.reason AS triage_reason,
         tr.updated_at AS triage_updated_at,
         (
           SELECT um.content
           FROM messages um
           WHERE um.conversation_id = m.conversation_id
             AND um.role = 'user'
             AND um.created_at <= m.created_at
           ORDER BY um.created_at DESC, um.id DESC
           LIMIT 1
         ) AS user_question,
         COALESCE((
           SELECT COUNT(*) FILTER (WHERE f.value = 'up')
           FROM assistant_answer_feedback f
           WHERE f.assistant_message_id = m.id
         ), 0)::text AS up_count,
         COALESCE((
           SELECT COUNT(*) FILTER (WHERE f.value = 'down')
           FROM assistant_answer_feedback f
           WHERE f.assistant_message_id = m.id
         ), 0)::text AS down_count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.workspace_id = m.workspace_id
       LEFT JOIN agents a ON a.id = c.agent_id
       ${triageJoin}
       LEFT JOIN LATERAL (
         SELECT
           CASE
             WHEN jsonb_typeof(ae.metadata_json #> '{activityTrace,totalDurationMs}') = 'number'
               THEN ((ae.metadata_json #>> '{activityTrace,totalDurationMs}')::numeric)::int
             ELSE NULL
           END AS total_latency_ms
         FROM audit_events ae
         WHERE ae.workspace_id = m.workspace_id
           AND ae.event_type = 'chat.answer'
           AND ae.metadata_json ->> 'assistantMessageId' = m.id::text
         ORDER BY ae.created_at DESC, ae.id DESC
         LIMIT 1
       ) turn_event ON TRUE
       WHERE ${whereClause}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $${limitParamIndex}
       OFFSET $${offsetParamIndex}`,
        params,
      ),
    );
    const rows = rowsResult.rows;

    const commentsByMessageId = await this.fetchComments(workspaceId, rows.map((row) => row.assistant_message_id));

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
      createdAt: serializeDate(row.created_at),
      feedback: {
        upCount: Number(row.up_count),
        downCount: Number(row.down_count),
        comments: commentsByMessageId.get(row.assistant_message_id) ?? [],
      },
      triage: {
        state: row.triage_state as QualityTriageState,
        reason: row.triage_reason,
        updatedAt: row.triage_updated_at === null ? null : serializeDate(row.triage_updated_at),
      },
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

  async setTriageState(
    workspaceId: string,
    input: SetTriageStateInput,
  ): Promise<QualityTriageRecord | null> {
    // Scope the upsert to assistant turns in this workspace: the SELECT yields
    // no row (and the insert is a no-op) when the turn is missing or foreign,
    // which we surface as a 404 at the route.
    const result = await this.db.executeQuery<{
      state: string;
      reason: string | null;
      updated_at: Date | string;
    }>(
      CompiledQuery.raw(
        `INSERT INTO assistant_answer_triage (workspace_id, assistant_message_id, state, reason, updated_by, updated_at)
       SELECT m.workspace_id, m.id, $3, $4, $5, NOW()
       FROM messages m
       WHERE m.id = $2 AND m.workspace_id = $1 AND m.role = 'assistant'
       ON CONFLICT (workspace_id, assistant_message_id)
       DO UPDATE SET
         state = EXCLUDED.state,
         reason = EXCLUDED.reason,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING state, reason, updated_at`,
        [workspaceId, input.assistantMessageId, input.state, input.reason ?? null, input.updatedBy ?? null],
      ),
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      state: row.state as QualityTriageState,
      reason: row.reason,
      updatedAt: serializeDate(row.updated_at),
    };
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
        `SELECT assistant_message_id, value, comment, created_at
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
      });
      grouped.set(row.assistant_message_id, entries);
    }

    return grouped;
  }
}
