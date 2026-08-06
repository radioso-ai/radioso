import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { AuditEventRepository } from "../../src/db/repositories/auditEventRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Characterization for the jsonb-filter / jsonb_set / cursor / id::text logic.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("AuditEventRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new AuditEventRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Audit Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Audit Workspace",
      `route-${workspaceId}`,
    ]);
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM audit_events WHERE workspace_id = $1`, [workspaceId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM audit_events WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const chatAnswer = (assistantMessageId: string, status = "success") =>
    repository.create({
      workspaceId,
      eventType: "chat.answer",
      eventStatus: status,
      metadata: { conversationId, assistantMessageId },
    });

  const chatSuspended = (assistantMessageId: string) =>
    repository.create({
      workspaceId,
      eventType: "chat.suspended",
      eventStatus: "success",
      metadata: { conversationId, assistantMessageId },
    });

  it("filters chat.answer events by conversationId and assistantMessageId via ->>", async () => {
    const a = await chatAnswer("m1");
    const b = await chatAnswer("m2");
    await repository.create({ workspaceId, eventType: "chat.answer", eventStatus: "success", metadata: { conversationId: randomUUID(), assistantMessageId: "other" } });

    const byConv = await repository.listChatAnswerEventsByConversationId(workspaceId, conversationId);
    expect(byConv.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());

    const byMsg = await repository.listChatTurnEventsByAssistantMessageIds(workspaceId, conversationId, ["m2"]);
    expect(byMsg.map((e) => e.id)).toEqual([b.id]);
    expect(await repository.listChatTurnEventsByAssistantMessageIds(workspaceId, conversationId, [])).toEqual([]);
  });

  it("filters unanswered chat.answer diagnostics by visible user message ids", async () => {
    const visibleCancelled = await repository.create({
      workspaceId,
      eventType: "chat.answer",
      eventStatus: "cancelled",
      metadata: { conversationId, userMessageId: "user-visible" },
    });
    const visibleFailure = await repository.create({
      workspaceId,
      eventType: "chat.answer",
      eventStatus: "failure",
      metadata: { conversationId, userMessageId: "user-failed" },
    });
    await repository.create({
      workspaceId,
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: { conversationId, userMessageId: "user-visible" },
    });
    await repository.create({
      workspaceId,
      eventType: "chat.answer",
      eventStatus: "cancelled",
      metadata: { conversationId, userMessageId: "user-visible", assistantMessageId: "assistant-created" },
    });
    await repository.create({
      workspaceId,
      eventType: "chat.answer",
      eventStatus: "cancelled",
      metadata: { conversationId, userMessageId: "user-older" },
    });
    await repository.create({
      workspaceId,
      eventType: "chat.answer",
      eventStatus: "cancelled",
      metadata: { conversationId: randomUUID(), userMessageId: "user-visible" },
    });

    const events = await repository.listUnansweredChatAnswerEventsByUserMessageIds(
      workspaceId,
      conversationId,
      ["user-visible", "user-failed"],
    );

    expect(events.map((event) => event.id).sort()).toEqual([visibleCancelled.id, visibleFailure.id].sort());
    expect(await repository.listUnansweredChatAnswerEventsByUserMessageIds(workspaceId, conversationId, []))
      .toEqual([]);
  });

  it("returns suspended turns too, so the debug panel resolves their turnTrace", async () => {
    const suspended = await chatSuspended("m-suspended");

    const byMsg = await repository.listChatTurnEventsByAssistantMessageIds(workspaceId, conversationId, ["m-suspended"]);
    expect(byMsg.map((e) => e.id)).toEqual([suspended.id]);
  });

  it("sanitizes invalid text characters before writing metadata jsonb", async () => {
    const event = await repository.create({
      workspaceId,
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId,
        assistantMessageId: "m-invalid-text",
        answerPreview: `bad ${String.fromCharCode(0)} preview`,
      },
    });

    expect(event.metadata.answerPreview).toBe("bad \uFFFD preview");
  });

  it("findLatest honors optional status filter", async () => {
    await chatAnswer("m1", "failure");
    const ok = await chatAnswer("m2", "success");
    expect((await repository.findLatestChatAnswerEventByConversationId(workspaceId, conversationId))?.id).toBe(ok.id);
    expect((await repository.findLatestChatAnswerEventByConversationId(workspaceId, conversationId, "success"))?.id).toBe(ok.id);
  });

  it("updateChatAnswerSuggestions sets the nested key via jsonb_set", async () => {
    const event = await chatAnswer("m1");
    const updated = await repository.updateChatAnswerSuggestions({
      workspaceId,
      conversationId,
      assistantMessageId: "m1",
      suggestions: [{ q: "more?" }],
    });
    expect(updated).toBe(true);

    const reloaded = (await repository.listChatAnswerEventsByConversationId(workspaceId, conversationId)).find((e) => e.id === event.id);
    expect(reloaded?.metadata.suggestions).toEqual([{ q: "more?" }]);
    // preserves existing keys
    expect(reloaded?.metadata.conversationId).toBe(conversationId);
  });

  it("document.search cursor pagination + lookup by searchId and id::text", async () => {
    const searchId = randomUUID();
    const first = await repository.create({ workspaceId, eventType: "document.search", eventStatus: "success", metadata: { searchId } });
    const ids: string[] = [first.id];
    for (let i = 0; i < 2; i += 1) {
      const e = await repository.create({ workspaceId, eventType: "document.search", eventStatus: "success", metadata: {} });
      ids.push(e.id);
    }
    // control ordering (newest first)
    for (let i = 0; i < ids.length; i += 1) {
      await database.query(`UPDATE audit_events SET created_at = $2::timestamptz WHERE id = $1`, [ids[i], `2026-06-01T00:00:0${i}.000Z`]);
    }

    const page1 = await repository.listDocumentSearchEventPageByWorkspaceId(workspaceId, { limit: 2 });
    expect(page1.total).toBe(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.events.map((e) => e.id)).toEqual([ids[2], ids[1]]);

    const page2 = await repository.listDocumentSearchEventPageByWorkspaceId(workspaceId, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.events.map((e) => e.id)).toEqual([ids[0]]);
    expect(page2.hasMore).toBe(false);

    expect((await repository.findDocumentSearchEventBySearchId(workspaceId, searchId))?.id).toBe(first.id);
    expect((await repository.findDocumentSearchEventBySearchId(workspaceId, first.id))?.id).toBe(first.id); // id::text branch
  });
});
