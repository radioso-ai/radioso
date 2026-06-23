import { randomUUID } from "node:crypto";

import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { anyOf, currentTimestamp } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
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

interface FeedbackRow {
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
}

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

const feedbackColumns = [
  "id",
  "workspace_id",
  "conversation_id",
  "assistant_message_id",
  "account_id",
  "user_id",
  "anonymous_session_id",
  "actor_type",
  "actor_id",
  "value",
  "comment",
  "created_at",
  "updated_at",
] as const;

export class AnswerFeedbackService implements AnswerFeedbackHistoryProviderPort {
  constructor(private readonly db: Db) {}

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
    const row = await this.db
      .insertInto("assistant_answer_feedback")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        conversation_id: target.conversationId,
        assistant_message_id: input.assistantMessageId,
        account_id: input.actor.accountId ?? null,
        user_id: input.actor.userId ?? null,
        anonymous_session_id: input.actor.anonymousSessionId ?? null,
        actor_type: input.actor.type,
        actor_id: input.actor.id,
        value: input.value,
        comment,
      })
      .onConflict((oc) =>
        oc.columns(["assistant_message_id", "actor_type", "actor_id"]).doUpdateSet((eb) => ({
          value: eb.ref("excluded.value"),
          comment: eb.ref("excluded.comment"),
          account_id: eb.ref("excluded.account_id"),
          user_id: eb.ref("excluded.user_id"),
          anonymous_session_id: eb.ref("excluded.anonymous_session_id"),
          updated_at: currentTimestamp(),
        })),
      )
      .returning(feedbackColumns)
      .executeTakeFirstOrThrow();

    return mapFeedbackRow(row as FeedbackRow);
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

    const rows = await this.db
      .deleteFrom("assistant_answer_feedback")
      .where("workspace_id", "=", input.workspaceId)
      .where("assistant_message_id", "=", input.assistantMessageId)
      .where("actor_type", "=", input.actor.type)
      .where("actor_id", "=", input.actor.id)
      .returning("id")
      .execute();

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

    const rows = await this.db
      .selectFrom("assistant_answer_feedback")
      .select(feedbackColumns)
      .where("workspace_id", "=", workspaceId)
      .where((eb) => anyOf(eb.ref("assistant_message_id"), assistantMessageIds, "uuid[]"))
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();

    for (const row of rows as FeedbackRow[]) {
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
    let query = this.db
      .selectFrom("messages as m")
      .innerJoin("conversations as c", "c.id", "m.conversation_id")
      .select("m.conversation_id")
      .where("m.workspace_id", "=", input.workspaceId)
      .where("m.id", "=", input.assistantMessageId)
      .where("m.role", "=", "assistant")
      .where("c.workspace_id", "=", input.workspaceId);

    if (input.anonymousSessionId) {
      query = query.where("c.anonymous_session_id", "=", input.anonymousSessionId);
    }
    if (input.agentId) {
      query = query.where("c.agent_id", "=", input.agentId);
    }

    const row = await query.limit(1).executeTakeFirst();
    return row ? { conversationId: row.conversation_id } : null;
  }
}
