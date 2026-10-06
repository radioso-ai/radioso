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
  const database = new Database(integrationDatabaseUrl);
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

  it("round-trips a routine invocation's input metadata and drops an unknown input method on read", async () => {
    const invocation = await repository.create({
      conversationId,
      workspaceId,
      role: "user",
      content: 'start_return {"orderId":"A-1001","reason":"Wrong size"}',
      inputMetadata: {
        method: "routine_invocation",
        routine: { toolName: "start_return", input: { orderId: "A-1001", reason: "Wrong size" } },
      },
    });
    const unknownMethod = await repository.create({
      conversationId,
      workspaceId,
      role: "user",
      content: "hi",
      metadata: { method: "voice_note", routine: { toolName: "start_return", input: {} } },
    });

    const reloaded = await repository.listByConversationId(workspaceId, conversationId);
    expect(reloaded.find((m) => m.id === invocation.id)?.inputMetadata).toEqual({
      method: "routine_invocation",
      routine: { toolName: "start_return", input: { orderId: "A-1001", reason: "Wrong size" } },
    });
    expect(reloaded.find((m) => m.id === unknownMethod.id)?.inputMetadata).toBeUndefined();
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

  it("lists the newest messages before a (created_at, id) boundary, oldest first, ignoring later ones before limiting", async () => {
    const created = [];
    for (let i = 0; i < 7; i += 1) {
      created.push(await repository.create({ conversationId, workspaceId, role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));
    }
    for (const [index, message] of created.entries()) {
      await setTime(message.id, `2026-06-01T00:00:0${index}.000Z`);
    }
    // A message sharing the boundary's timestamp orders by id: one sorting before it is earlier, one after it later.
    const tied = await repository.create({ conversationId, workspaceId, role: "user", content: "tied" });
    const boundary = created[4];
    await setTime(tied.id, "2026-06-01T00:00:04.000Z");
    const tiedIsEarlier = tied.id < boundary.id;

    const window = await repository.listBeforeByConversationId(workspaceId, conversationId, {
      beforeMessageId: boundary.id,
      limit: 3,
    });

    const expected = tiedIsEarlier
      ? [created[2].id, created[3].id, tied.id]
      : [created[1].id, created[2].id, created[3].id];
    expect(window.map((message) => message.id)).toEqual(expected);
    expect(await repository.listBeforeByConversationId(workspaceId, conversationId, {
      beforeMessageId: boundary.id,
      limit: 0,
    })).toEqual([]);
    expect(await repository.listBeforeByConversationId(randomUUID(), conversationId, {
      beforeMessageId: boundary.id,
      limit: 3,
    })).toEqual([]);
    // A boundary that is not a message of the conversation has nothing before it.
    expect(await repository.listBeforeByConversationId(workspaceId, conversationId, {
      beforeMessageId: randomUUID(),
      limit: 3,
    })).toEqual([]);
  });

  it("keeps a predecessor recorded within the same millisecond as the boundary, at full Postgres precision", async () => {
    const earlier = await repository.create({ conversationId, workspaceId, role: "user", content: "earlier" });
    const boundary = await repository.create({ conversationId, workspaceId, role: "user", content: "boundary" });
    // Both read back as .123 in a JavaScript Date; only the microseconds order them.
    await setTime(earlier.id, "2026-06-02T00:00:00.123100Z");
    await setTime(boundary.id, "2026-06-02T00:00:00.123900Z");
    // A later message within the same millisecond, sorting before the boundary by id or not, stays out.
    const later = await repository.create({ conversationId, workspaceId, role: "user", content: "later" });
    await setTime(later.id, "2026-06-02T00:00:00.123950Z");

    const window = await repository.listBeforeByConversationId(workspaceId, conversationId, {
      beforeMessageId: boundary.id,
      limit: 1,
    });

    expect(window.map((message) => message.id)).toEqual([earlier.id]);
  });

  it("filters the newest messages by role before limiting, so a filtered-out row takes no place", async () => {
    const roles = ["user", "assistant", "system", "system", "user"] as const;
    const created = [];
    for (const [index, role] of roles.entries()) {
      const message = await repository.create({ conversationId, workspaceId, role, content: `m${index}` });
      await setTime(message.id, `2026-06-01T00:00:0${index}.000Z`);
      created.push(message);
    }

    const window = await repository.listRecentByConversationId(workspaceId, conversationId, 2, { roles: ["user", "assistant"] });

    expect(window.map((message) => message.id)).toEqual([created[1].id, created[4].id]);
    expect(await repository.listRecentByConversationId(workspaceId, conversationId, 2, { roles: [] })).toEqual([]);
    expect((await repository.listRecentByConversationId(workspaceId, conversationId, 2)).map((message) => message.id))
      .toEqual([created[3].id, created[4].id]);
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
