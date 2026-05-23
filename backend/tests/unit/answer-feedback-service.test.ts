import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { AnswerFeedbackService } from "../../src/modules/chat/services/answerFeedbackService.js";
import type { ApplicationDatabasePort } from "../../src/app/composition/applicationModule.js";

type FeedbackRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  conversation_id: string;
  assistant_message_id: string;
  account_id: string | null;
  user_id: string | null;
  anonymous_session_id: string | null;
  actor_type: "authenticated_user" | "api_token" | "anonymous_user";
  actor_id: string;
  value: "up" | "down";
  comment: string | null;
  created_at: Date;
  updated_at: Date;
};

class FakeAnswerFeedbackDatabase implements ApplicationDatabasePort {
  readonly assistantMessages = new Map<string, {
    workspaceId: string;
    conversationId: string;
    anonymousSessionId: string | null;
    agentId: string | null;
    role: "user" | "assistant";
  }>();
  readonly feedback = new Map<string, FeedbackRow>();

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    if (text.includes("SELECT m.conversation_id")) {
      const workspaceId = String(params[0]);
      const assistantMessageId = String(params[1]);
      let nextParamIndex = 2;
      const anonymousSessionId = text.includes("c.anonymous_session_id")
        ? String(params[nextParamIndex++])
        : undefined;
      const agentId = text.includes("c.agent_id")
        ? String(params[nextParamIndex++])
        : undefined;
      const message = this.assistantMessages.get(assistantMessageId);
      if (
        !message ||
        message.workspaceId !== workspaceId ||
        message.role !== "assistant" ||
        (anonymousSessionId !== undefined && message.anonymousSessionId !== anonymousSessionId) ||
        (agentId !== undefined && message.agentId !== agentId)
      ) {
        return [] as T[];
      }
      return [{ conversation_id: message.conversationId }] as unknown as T[];
    }

    if (text.includes("INSERT INTO assistant_answer_feedback")) {
      const assistantMessageId = String(params[3]);
      const actorType = params[7] as FeedbackRow["actor_type"];
      const actorId = String(params[8]);
      const key = `${assistantMessageId}:${actorType}:${actorId}`;
      const existing = this.feedback.get(key);
      const row: FeedbackRow = {
        id: existing?.id ?? String(params[0]),
        workspace_id: String(params[1]),
        conversation_id: String(params[2]),
        assistant_message_id: assistantMessageId,
        account_id: params[4] === null ? null : String(params[4]),
        user_id: params[5] === null ? null : String(params[5]),
        anonymous_session_id: params[6] === null ? null : String(params[6]),
        actor_type: actorType,
        actor_id: actorId,
        value: params[9] as FeedbackRow["value"],
        comment: params[10] === null ? null : String(params[10]),
        created_at: existing?.created_at ?? new Date("2026-05-07T10:00:00.000Z"),
        updated_at: new Date("2026-05-07T10:01:00.000Z"),
      };
      this.feedback.set(key, row);
      return [row] as unknown as T[];
    }

    if (text.includes("DELETE FROM assistant_answer_feedback")) {
      const key = `${String(params[1])}:${String(params[2])}:${String(params[3])}`;
      const row = this.feedback.get(key);
      this.feedback.delete(key);
      return (row ? [{ id: row.id }] : []) as unknown as T[];
    }

    if (text.includes("FROM assistant_answer_feedback") && text.includes("assistant_message_id = ANY")) {
      const workspaceId = String(params[0]);
      const ids = params[1] as string[];
      return ([...this.feedback.values()]
        .filter((row) => row.workspace_id === workspaceId && ids.includes(row.assistant_message_id))
        .sort((left, right) => left.created_at.getTime() - right.created_at.getTime())) as unknown as T[];
    }

    return [] as T[];
  }
}

const seedAssistantMessage = (database: FakeAnswerFeedbackDatabase, input: {
  id?: string;
  workspaceId?: string;
  conversationId?: string;
  anonymousSessionId?: string | null;
  agentId?: string | null;
  role?: "user" | "assistant";
} = {}) => {
  const id = input.id ?? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  database.assistantMessages.set(id, {
    workspaceId: input.workspaceId ?? "workspace-1",
    conversationId: input.conversationId ?? "conversation-1",
    anonymousSessionId: input.anonymousSessionId ?? null,
    agentId: input.agentId ?? null,
    role: input.role ?? "assistant",
  });
  return id;
};

describe("answer feedback service", () => {
  it("upserts, switches, and clears one active feedback entry per actor and message", async () => {
    const database = new FakeAnswerFeedbackDatabase();
    const messageId = seedAssistantMessage(database);
    const service = new AnswerFeedbackService(database);

    const first = await service.upsert({
      workspaceId: "workspace-1",
      assistantMessageId: messageId,
      value: "down",
      comment: "This missed the source.",
      actor: {
        type: "authenticated_user",
        id: "user-1",
        accountId: "account-1",
        userId: "user-1",
      },
    });
    const switched = await service.upsert({
      workspaceId: "workspace-1",
      assistantMessageId: messageId,
      value: "up",
      comment: "ignored for upvotes",
      actor: {
        type: "authenticated_user",
        id: "user-1",
        accountId: "account-1",
        userId: "user-1",
      },
    });

    expect(switched.id).toBe(first.id);
    expect(switched.value).toBe("up");
    expect(switched.comment).toBeNull();
    expect(database.feedback.size).toBe(1);

    await expect(service.clear({
      workspaceId: "workspace-1",
      assistantMessageId: messageId,
      actor: {
        type: "authenticated_user",
        id: "user-1",
        accountId: "account-1",
        userId: "user-1",
      },
    })).resolves.toEqual({ cleared: true });
    expect(database.feedback.size).toBe(0);
  });

  it("rejects non-assistant, wrong-workspace, wrong-session, and wrong-agent messages", async () => {
    const database = new FakeAnswerFeedbackDatabase();
    const userMessageId = seedAssistantMessage(database, { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", role: "user" });
    const publicMessageId = seedAssistantMessage(database, {
      id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      anonymousSessionId: "session-1",
      agentId: "agent-1",
    });
    const service = new AnswerFeedbackService(database);

    await expect(service.upsert({
      workspaceId: "workspace-1",
      assistantMessageId: userMessageId,
      value: "up",
      actor: { type: "api_token", id: "account-1", accountId: "account-1" },
    })).rejects.toMatchObject({ statusCode: 404 });

    await expect(service.upsert({
      workspaceId: "other-workspace",
      assistantMessageId: publicMessageId,
      value: "up",
      actor: { type: "api_token", id: "account-1", accountId: "account-1" },
    })).rejects.toMatchObject({ statusCode: 404 });

    await expect(service.upsert({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      assistantMessageId: publicMessageId,
      value: "up",
      actor: { type: "anonymous_user", id: "session-2", anonymousSessionId: "session-2" },
    })).rejects.toMatchObject({ statusCode: 404 });

    await expect(service.upsert({
      workspaceId: "workspace-1",
      agentId: "agent-2",
      assistantMessageId: publicMessageId,
      value: "up",
      actor: { type: "anonymous_user", id: "session-1", anonymousSessionId: "session-1" },
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns feedback entries grouped by assistant message for history detail", async () => {
    const database = new FakeAnswerFeedbackDatabase();
    const messageId = seedAssistantMessage(database, { anonymousSessionId: "session-1" });
    const service = new AnswerFeedbackService(database);

    await service.upsert({
      workspaceId: "workspace-1",
      assistantMessageId: messageId,
      value: "down",
      comment: "Needs more detail.",
      actor: { type: "anonymous_user", id: "session-1", anonymousSessionId: "session-1" },
    });

    const grouped = await service.listByAssistantMessageIds("workspace-1", [messageId]);

    expect(grouped.get(messageId)).toEqual([
      expect.objectContaining({
        value: "down",
        comment: "Needs more detail.",
        actorType: "anonymous_user",
        anonymousSessionId: "session-1",
      }),
    ]);
  });

  it("limits free-form comments to 2000 characters", async () => {
    const database = new FakeAnswerFeedbackDatabase();
    const messageId = seedAssistantMessage(database);
    const service = new AnswerFeedbackService(database);

    await expect(service.upsert({
      workspaceId: "workspace-1",
      assistantMessageId: messageId,
      value: "down",
      comment: "x".repeat(2001),
      actor: { type: "api_token", id: "account-1", accountId: "account-1" },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "bad_request",
    });
  });
});
