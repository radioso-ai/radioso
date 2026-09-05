import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { AnswerFeedbackService } from "../../src/modules/chat/services/answerFeedbackService.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of AnswerFeedbackService (replaces the deleted
// SQL-string mock unit test). Covers the behaviour the Kysely migration must preserve:
// one active entry per (message, actor) via ON CONFLICT, comment normalization,
// assistant/workspace/session/agent scoping, clear, and grouped history reads.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("AnswerFeedbackService (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const service = new AnswerFeedbackService(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const anonymousConversationId = randomUUID();
  const assistantMessageId = randomUUID();
  const userMessageId = randomUUID();
  const anonymousAssistantMessageId = randomUUID();
  const anonymousSessionId = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Feedback Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Feedback Workspace",
      `route-${workspaceId.slice(0, 8)}`,
    ]);
    await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1,$2,$3)`, [
      agentId,
      workspaceId,
      "Feedback Bot",
    ]);
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)`, [
      userId,
      `user-${userId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1,$2)`, [conversationId, workspaceId]);
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, anonymous_session_id) VALUES ($1,$2,$3,$4)`,
      [anonymousConversationId, workspaceId, agentId, anonymousSessionId],
    );
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES
         ($1,$2,$3,'assistant','Answer one'),
         ($4,$2,$3,'user','Question one'),
         ($5,$6,$3,'assistant','Public answer')`,
      [assistantMessageId, conversationId, workspaceId, userMessageId, anonymousAssistantMessageId, anonymousConversationId],
    );
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM assistant_answer_feedback WHERE workspace_id = $1`, [workspaceId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const authActor = { type: "authenticated_user" as const, id: userId, accountId, userId };

  it("keeps one active entry per actor and message, switching value and dropping the up-comment", async () => {
    const first = await service.upsert({
      workspaceId,
      assistantMessageId,
      value: "down",
      comment: "  This missed the source.  ",
      actor: authActor,
    });
    expect(first.value).toBe("down");
    expect(first.comment).toBe("This missed the source.");
    expect(first.actorType).toBe("authenticated_user");
    expect(first.userId).toBe(userId);

    const switched = await service.upsert({
      workspaceId,
      assistantMessageId,
      value: "up",
      comment: "ignored for upvotes",
      actor: authActor,
    });
    expect(switched.id).toBe(first.id);
    expect(switched.value).toBe("up");
    expect(switched.comment).toBeNull();

    const rows = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM assistant_answer_feedback WHERE assistant_message_id = $1`,
      [assistantMessageId],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("rejects a comment over 2000 characters", async () => {
    await expect(
      service.upsert({
        workspaceId,
        assistantMessageId,
        value: "down",
        comment: "x".repeat(2001),
        actor: authActor,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects non-assistant, wrong-workspace, wrong-session, and wrong-agent messages", async () => {
    await expect(
      service.upsert({ workspaceId, assistantMessageId: userMessageId, value: "up", actor: authActor }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      service.upsert({ workspaceId: randomUUID(), assistantMessageId, value: "up", actor: authActor }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      service.upsert({
        workspaceId,
        agentId,
        assistantMessageId: anonymousAssistantMessageId,
        value: "up",
        actor: { type: "anonymous_user", id: randomUUID(), anonymousSessionId: randomUUID() },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      service.upsert({
        workspaceId,
        agentId: randomUUID(),
        assistantMessageId: anonymousAssistantMessageId,
        value: "up",
        actor: { type: "anonymous_user", id: anonymousSessionId, anonymousSessionId },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("clears feedback and reports whether a row was removed", async () => {
    await service.upsert({ workspaceId, assistantMessageId, value: "down", comment: "x", actor: authActor });

    await expect(
      service.clear({ workspaceId, assistantMessageId, actor: authActor }),
    ).resolves.toEqual({ cleared: true });

    await expect(
      service.clear({ workspaceId, assistantMessageId, actor: authActor }),
    ).resolves.toEqual({ cleared: false });
  });

  it("publishes only real upsert/clear changes after their database commits", async () => {
    const publisher = { enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })) };
    const serviceWithPublisher = new AnswerFeedbackService(database.kysely, publisher);

    await serviceWithPublisher.upsert({ workspaceId, assistantMessageId, value: "down", comment: "x", actor: authActor });
    await serviceWithPublisher.upsert({ workspaceId, assistantMessageId, value: "down", comment: "x", actor: authActor });
    await serviceWithPublisher.clear({ workspaceId, assistantMessageId, actor: authActor });
    await serviceWithPublisher.clear({ workspaceId, assistantMessageId, actor: authActor });

    expect(publisher.enqueue).toHaveBeenCalledTimes(2);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(1, workspaceId, ["quality.feedback_changed"]);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(2, workspaceId, ["quality.feedback_changed"]);
  });

  it("groups feedback by assistant message id ordered by created_at", async () => {
    await service.upsert({
      workspaceId,
      agentId,
      assistantMessageId: anonymousAssistantMessageId,
      value: "down",
      comment: "Needs more detail.",
      actor: { type: "anonymous_user", id: anonymousSessionId, anonymousSessionId },
    });

    const grouped = await service.listByAssistantMessageIds(workspaceId, [anonymousAssistantMessageId]);
    expect(grouped.get(anonymousAssistantMessageId)).toEqual([
      expect.objectContaining({
        value: "down",
        comment: "Needs more detail.",
        actorType: "anonymous_user",
        anonymousSessionId,
      }),
    ]);

    expect(await service.listByAssistantMessageIds(workspaceId, [])).toEqual(new Map());
  });
});
