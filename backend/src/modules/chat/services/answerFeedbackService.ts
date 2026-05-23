import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { ApplicationDatabasePort } from "../../../app/composition/applicationModule.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type {
  AnswerFeedbackHistoryProviderPort,
  ChatAnswerFeedbackEntry,
  ChatAnswerFeedbackValue,
} from "./answerFeedbackHistoryProvider.js";

export type AnswerFeedbackActorType = "authenticated_user" | "api_token" | "anonymous_user";

export interface AnswerFeedbackActor {
  type: AnswerFeedbackActorType;
  id: string;
  accountId?: string | null;
  userId?: string | null;
  anonymousSessionId?: string | null;
}

type FeedbackRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  conversation_id: string;
  assistant_message_id: string;
  account_id: string | null;
  user_id: string | null;
  anonymous_session_id: string | null;
  actor_type: AnswerFeedbackActorType;
  actor_id: string;
  value: ChatAnswerFeedbackValue;
  comment: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const COMMENT_MAX_LENGTH = 2000;

const serializeDate = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const normalizeComment = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > COMMENT_MAX_LENGTH) {
    throw badRequest("Feedback comment must be 2000 characters or less");
  }
  return trimmed;
};

const mapFeedbackRow = (row: FeedbackRow): ChatAnswerFeedbackEntry => ({
  id: row.id,
  value: row.value,
  comment: row.comment,
  actorType: row.actor_type,
  actorId: row.actor_id,
  accountId: row.account_id,
  userId: row.user_id,
  anonymousSessionId: row.anonymous_session_id,
  createdAt: serializeDate(row.created_at),
  updatedAt: serializeDate(row.updated_at),
});

export class AnswerFeedbackService implements AnswerFeedbackHistoryProviderPort {
  constructor(private readonly database: ApplicationDatabasePort) {}

  async upsert(input: {
    workspaceId: string;
    agentId?: string | null;
    assistantMessageId: string;
    value: ChatAnswerFeedbackValue;
    comment?: string | null;
    actor: AnswerFeedbackActor;
  }): Promise<ChatAnswerFeedbackEntry> {
    const target = await this.findAssistantMessage({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      assistantMessageId: input.assistantMessageId,
      anonymousSessionId: input.actor.type === "anonymous_user" ? input.actor.anonymousSessionId : null,
    });
    if (!target) {
      throw notFound("Assistant message not found");
    }

    const comment = input.value === "down" ? normalizeComment(input.comment) : null;
    const [row] = await this.database.query<FeedbackRow>(
      `INSERT INTO assistant_answer_feedback (
         id,
         workspace_id,
         conversation_id,
         assistant_message_id,
         account_id,
         user_id,
         anonymous_session_id,
         actor_type,
         actor_id,
         value,
         comment
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (assistant_message_id, actor_type, actor_id)
       DO UPDATE SET
         value = EXCLUDED.value,
         comment = EXCLUDED.comment,
         account_id = EXCLUDED.account_id,
         user_id = EXCLUDED.user_id,
         anonymous_session_id = EXCLUDED.anonymous_session_id,
         updated_at = NOW()
       RETURNING id, workspace_id, conversation_id, assistant_message_id, account_id, user_id,
                 anonymous_session_id, actor_type, actor_id, value, comment, created_at, updated_at`,
      [
        randomUUID(),
        input.workspaceId,
        target.conversationId,
        input.assistantMessageId,
        input.actor.accountId ?? null,
        input.actor.userId ?? null,
        input.actor.anonymousSessionId ?? null,
        input.actor.type,
        input.actor.id,
        input.value,
        comment,
      ],
    );

    return mapFeedbackRow(row!);
  }

  async clear(input: {
    workspaceId: string;
    agentId?: string | null;
    assistantMessageId: string;
    actor: AnswerFeedbackActor;
  }): Promise<{ cleared: boolean }> {
    const target = await this.findAssistantMessage({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      assistantMessageId: input.assistantMessageId,
      anonymousSessionId: input.actor.type === "anonymous_user" ? input.actor.anonymousSessionId : null,
    });
    if (!target) {
      throw notFound("Assistant message not found");
    }

    const rows = await this.database.query<{ id: string }>(
      `DELETE FROM assistant_answer_feedback
       WHERE workspace_id = $1
         AND assistant_message_id = $2
         AND actor_type = $3
         AND actor_id = $4
       RETURNING id`,
      [input.workspaceId, input.assistantMessageId, input.actor.type, input.actor.id],
    );

    return { cleared: rows.length > 0 };
  }

  async listByAssistantMessageIds(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<Map<string, ChatAnswerFeedbackEntry[]>> {
    const feedback = new Map<string, ChatAnswerFeedbackEntry[]>();
    if (assistantMessageIds.length === 0) {
      return feedback;
    }

    const rows = await this.database.query<FeedbackRow>(
      `SELECT id, workspace_id, conversation_id, assistant_message_id, account_id, user_id,
              anonymous_session_id, actor_type, actor_id, value, comment, created_at, updated_at
       FROM assistant_answer_feedback
       WHERE workspace_id = $1
         AND assistant_message_id = ANY($2::uuid[])
       ORDER BY created_at ASC, id ASC`,
      [workspaceId, assistantMessageIds],
    );

    for (const row of rows) {
      const entries = feedback.get(row.assistant_message_id) ?? [];
      entries.push(mapFeedbackRow(row));
      feedback.set(row.assistant_message_id, entries);
    }

    return feedback;
  }

  private async findAssistantMessage(input: {
    workspaceId: string;
    agentId?: string | null;
    assistantMessageId: string;
    anonymousSessionId?: string | null;
  }): Promise<{ conversationId: string } | null> {
    const params: unknown[] = [input.workspaceId, input.assistantMessageId];
    let nextParamIndex = 3;
    const anonymousSessionClause = input.anonymousSessionId
      ? `AND c.anonymous_session_id = $${nextParamIndex++}`
      : "";
    if (input.anonymousSessionId) {
      params.push(input.anonymousSessionId);
    }
    const agentClause = input.agentId
      ? `AND c.agent_id = $${nextParamIndex++}`
      : "";
    if (input.agentId) {
      params.push(input.agentId);
    }

    const rows = await this.database.query<{ conversation_id: string }>(
      `SELECT m.conversation_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.workspace_id = $1
         AND m.id = $2
         AND m.role = 'assistant'
         AND c.workspace_id = $1
         ${anonymousSessionClause}
         ${agentClause}
       LIMIT 1`,
      params,
    );

    const row = rows[0];
    return row ? { conversationId: row.conversation_id } : null;
  }
}
