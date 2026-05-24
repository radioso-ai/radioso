import type { QueryResultRow } from "pg";

import type { ApplicationDatabasePort } from "../../app/composition/applicationModule.js";
import type { AssistantTurnOutcome } from "../chat/contracts/index.js";
import type {
  ListLowQualityTurnsInput,
  LowQualityTurn,
  LowQualityTurnsPage,
  QualityFeedbackValue,
  QualityTurnsServicePort,
} from "./contracts/index.js";

type TurnRow = QueryResultRow & {
  assistant_message_id: string;
  conversation_id: string;
  agent_id: string | null;
  agent_name: string | null;
  source_channel: string | null;
  answer_content: string;
  answer_outcome: AssistantTurnOutcome | null;
  user_question: string | null;
  up_count: string;
  down_count: string;
  created_at: Date | string;
};

type CommentRow = QueryResultRow & {
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
  constructor(private readonly database: ApplicationDatabasePort) {}

  async listLowQualityTurns(workspaceId: string, input: ListLowQualityTurnsInput): Promise<LowQualityTurnsPage> {
    const limit = clampLimit(input.limit);
    const offset = clampOffset(input.offset);
    const params: unknown[] = [workspaceId];
    const filters: string[] = ["m.workspace_id = $1", "m.role = 'assistant'"];

    const outcomes = input.outcomes ?? [];
    const feedbackValues = input.feedbackValues ?? [];

    if (outcomes.length > 0) {
      params.push(outcomes);
      filters.push(`m.answer_outcome = ANY($${params.length}::text[])`);
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

    if (input.hasComment) {
      filters.push(
        `EXISTS (
           SELECT 1 FROM assistant_answer_feedback f
           WHERE f.assistant_message_id = m.id
             AND f.comment IS NOT NULL
         )`,
      );
    }

    // No explicit outcome / feedback filter: surface assistant turns that are natural
    // candidates for review — non-grounded outcomes or any feedback at all.
    if (outcomes.length === 0 && feedbackValues.length === 0 && !input.hasComment) {
      filters.push(
        `(
           m.answer_outcome IS DISTINCT FROM 'grounded_success'
           OR EXISTS (
             SELECT 1 FROM assistant_answer_feedback f
             WHERE f.assistant_message_id = m.id
           )
         )`,
      );
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

    const whereClause = filters.join("\n         AND ");

    const [totalRow] = await this.database.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.workspace_id = m.workspace_id
       WHERE ${whereClause}`,
      params,
    );
    const total = Number(totalRow?.total ?? 0);

    params.push(limit);
    const limitParamIndex = params.length;
    params.push(offset);
    const offsetParamIndex = params.length;

    const rows = await this.database.query<TurnRow>(
      `SELECT
         m.id AS assistant_message_id,
         m.conversation_id,
         c.agent_id,
         a.name AS agent_name,
         c.source_channel,
         m.content AS answer_content,
         m.answer_outcome,
         m.created_at,
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
       WHERE ${whereClause}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $${limitParamIndex}
       OFFSET $${offsetParamIndex}`,
      params,
    );

    const commentsByMessageId = await this.fetchComments(workspaceId, rows.map((row) => row.assistant_message_id));

    const items: LowQualityTurn[] = rows.map((row) => ({
      assistantMessageId: row.assistant_message_id,
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      channel: row.source_channel,
      question: buildPreview(row.user_question) || null,
      answerPreview: buildPreview(row.answer_content),
      answerOutcome: row.answer_outcome,
      createdAt: serializeDate(row.created_at),
      feedback: {
        upCount: Number(row.up_count),
        downCount: Number(row.down_count),
        comments: commentsByMessageId.get(row.assistant_message_id) ?? [],
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

  private async fetchComments(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<Map<string, LowQualityTurn["feedback"]["comments"]>> {
    const grouped = new Map<string, LowQualityTurn["feedback"]["comments"]>();
    if (assistantMessageIds.length === 0) {
      return grouped;
    }

    const rows = await this.database.query<CommentRow>(
      `SELECT assistant_message_id, value, comment, created_at
       FROM assistant_answer_feedback
       WHERE workspace_id = $1
         AND assistant_message_id = ANY($2::uuid[])
         AND comment IS NOT NULL
       ORDER BY created_at ASC, id ASC`,
      [workspaceId, assistantMessageIds],
    );

    for (const row of rows) {
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
