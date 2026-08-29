import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Characterization for MessageRepository against Postgres. Covers behavior the deleted
// SQL-string mock unit tests asserted (source derivation, operator-provenance metadata,
// nested metadata round-trip) plus cursor windowing and conversation summaries.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("MessageRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new MessageRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Msg Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Msg Workspace",
      `route-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1,$2)`, [conversationId, workspaceId]);
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM messages WHERE conversation_id = $1`, [conversationId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const setTime = (id: string, iso: string) =>
    database.query(`UPDATE messages SET created_at = $2::timestamptz WHERE id = $1`, [id, iso]);

  it("derives source from role and persists explicit source + operator metadata", async () => {
    const ai = await repository.create({ conversationId, workspaceId, role: "assistant", content: "Done." });
    expect(ai.source).toBe("ai_agent");

    const human = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      source: "human_agent",
      content: "A human answered.",
      operatorAccountId: "account-1",
      operatorDisplayName: "Dana Operator",
    });
    expect(human.source).toBe("human_agent");
    expect(human.metadata).toEqual({ humanAgent: { accountId: "account-1", displayName: "Dana Operator" } });
  });

  it("round-trips nested metadata through jsonb", async () => {
    const nested = { activityTrace: { traceId: "t1", stages: [{ kind: "intake", outputs: { nested: { a: [1, 2] } } }] } };
    const created = await repository.create({ conversationId, workspaceId, role: "assistant", content: "x", metadata: nested });
    const reloaded = (await repository.listByConversationId(workspaceId, conversationId)).find((m) => m.id === created.id);
    expect(reloaded?.metadata).toEqual(nested);
  });

  it("windows newest-first with a stable cursor and total", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m = await repository.create({ conversationId, workspaceId, role: "user", content: `m${i}` });
      await setTime(m.id, `2026-06-01T00:00:0${i}.000Z`);
      ids.push(m.id);
    }
    // newest-first window of 2
    const page1 = await repository.listWindowByConversationId(workspaceId, conversationId, { limit: 2 });
    expect(page1.total).toBe(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.messages.map((m) => m.id)).toEqual([ids[1], ids[2]]); // returned oldest→newest within the page

    const page2 = await repository.listWindowByConversationId(workspaceId, conversationId, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map((m) => m.id)).toEqual([ids[0]]);
    expect(page2.hasMore).toBe(false);
  });

  it("summarizes counts and previews by conversation", async () => {
    await repository.create({ conversationId, workspaceId, role: "user", content: "question" });
    await repository.create({ conversationId, workspaceId, role: "assistant", content: "the answer" });
    const summaries = await repository.summarizeByConversationIds(workspaceId, [conversationId]);
    const summary = summaries.get(conversationId);
    expect(summary?.messageCount).toBe(2);
    expect(summary?.userMessageCount).toBe(1);
    expect(summary?.assistantMessageCount).toBe(1);
    expect(summary?.preview).toBeTruthy();
  });

  it("previews the visitor's first user message, not the newest agent reply", async () => {
    const greeting = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "Hi, how can I help?",
    });
    await setTime(greeting.id, "2026-06-02T00:00:00.000Z");

    const question = await repository.create({
      conversationId,
      workspaceId,
      role: "user",
      content: "What are your shop hours?",
    });
    await setTime(question.id, "2026-06-02T00:00:01.000Z");

    const reply = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "We're open 9-5",
    });
    await setTime(reply.id, "2026-06-02T00:00:02.000Z");

    const summaries = await repository.summarizeByConversationIds(workspaceId, [conversationId]);
    const summary = summaries.get(conversationId);
    expect(summary?.preview).toBe("What are your shop hours?");
  });

  it("falls back to the newest message preview when a conversation has no user message yet", async () => {
    const greeting = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "Hi, how can I help?",
    });
    await setTime(greeting.id, "2026-06-03T00:00:00.000Z");

    const followUp = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "Still here if you need anything",
    });
    await setTime(followUp.id, "2026-06-03T00:00:01.000Z");

    const summaries = await repository.summarizeByConversationIds(workspaceId, [conversationId]);
    const summary = summaries.get(conversationId);
    expect(summary?.preview).toBe("Still here if you need anything");
  });

  it("skips a whitespace-only first user message and previews the next meaningful one", async () => {
    const blank = await repository.create({
      conversationId,
      workspaceId,
      role: "user",
      content: "   ",
    });
    await setTime(blank.id, "2026-06-04T00:00:00.000Z");

    const greeting = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "Hi, how can I help?",
    });
    await setTime(greeting.id, "2026-06-04T00:00:01.000Z");

    const question = await repository.create({
      conversationId,
      workspaceId,
      role: "user",
      content: "What are your shop hours?",
    });
    await setTime(question.id, "2026-06-04T00:00:02.000Z");

    const reply = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "We're open 9-5",
    });
    await setTime(reply.id, "2026-06-04T00:00:03.000Z");

    const summaries = await repository.summarizeByConversationIds(workspaceId, [conversationId]);
    const summary = summaries.get(conversationId);
    expect(summary?.preview).toBe("What are your shop hours?");
  });
});
