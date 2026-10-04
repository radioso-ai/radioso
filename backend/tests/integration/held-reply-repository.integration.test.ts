import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { HeldReplyRepository } from "../../src/db/repositories/heldReplyRepository.js";
import type { HeldReplyInsert, HeldReplyRecord } from "../../src/modules/handoff/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const UNIQUE_VIOLATION = "23505";

describeIntegration("held replies (Postgres)", () => {
  const testDatabaseName = `held_replies_${randomUUID().replaceAll("-", "")}_test`;
  let database: Database;
  let heldReplies: HeldReplyRepository;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`CREATE DATABASE "${testDatabaseName}" TEMPLATE template0`);
    } finally {
      await admin.end();
    }
    const url = new URL(integrationDatabaseUrl);
    url.pathname = `/${testDatabaseName}`;
    url.searchParams.delete("options");
    database = new Database(url.toString());
    await runAllTestMigrations(database);
    heldReplies = new HeldReplyRepository(database.kysely);
  }, 60_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  const seedWorkspace = async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    await database.execute("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')", [
      accountId,
      `held-replies-${accountId}@example.test`,
    ]);
    await database.execute("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)", [
      workspaceId,
      accountId,
      `rk-${workspaceId}`,
    ]);
    await database.execute("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Agent')", [agentId, workspaceId]);
    return { workspaceId, agentId };
  };

  const seedConversation = async (workspaceId: string) => {
    const conversationId = randomUUID();
    await database.execute("INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'email')", [
      conversationId,
      workspaceId,
    ]);
    const inboundId = await addMessage(workspaceId, conversationId, "user");
    return { conversationId, inboundId };
  };

  const addMessage = async (workspaceId: string, conversationId: string, role: "user" | "assistant") => {
    const messageId = randomUUID();
    await database.execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at)
       VALUES ($1, $2, $3, $4, 'Text', clock_timestamp())`,
      [messageId, conversationId, workspaceId, role],
    );
    return messageId;
  };

  const holdInput = (
    scope: { workspaceId: string; agentId: string; conversationId: string; inboundId: string },
    overrides: Partial<HeldReplyInsert> = {},
  ): HeldReplyInsert => ({
    workspaceId: scope.workspaceId,
    conversationId: scope.conversationId,
    agentId: scope.agentId,
    answersMessageId: scope.inboundId,
    ownershipVersion: 0,
    policy: { ref: `email_mailbox:${randomUUID()}`, version: 3 },
    reviewRef: `email:${scope.conversationId}:${randomUUID()}`,
    holdReason: "draft_mode",
    facts: {
      outcome: "answered",
      grounding: "grounded",
      coverage: "partial",
      handoff: { requested: true, reason: "billing_dispute" },
      suppressedEffects: [{ skillName: "issue_refund" }],
      citationCount: 2,
    },
    draft: { text: "Your refund was issued.", presentation: { citations: [{ documentId: "doc-1" }] } },
    born: { state: "pending" },
    ...overrides,
  });

  const seedScope = async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const { conversationId, inboundId } = await seedConversation(workspaceId);
    return { workspaceId, agentId, conversationId, inboundId };
  };

  const errorCode = async (work: Promise<unknown>): Promise<string | undefined> => {
    try {
      await work;
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return undefined;
  };

  it("records a held reply with its binding, facts and draft, and reads it back", async () => {
    const scope = await seedScope();
    const input = holdInput(scope);

    const { record, created } = await heldReplies.insert(input);

    expect(created).toBe(true);
    expect(record).toMatchObject({
      workspaceId: scope.workspaceId,
      conversationId: scope.conversationId,
      agentId: scope.agentId,
      state: "pending",
      releaseKind: null,
      reviewRef: input.reviewRef,
      answersMessageId: scope.inboundId,
      ownershipVersion: 0,
      policy: input.policy,
      holdReason: "draft_mode",
      facts: input.facts,
      draft: input.draft,
      attentionClearedAt: null,
      decidedAt: null,
    });
    // To the millisecond, so a list cursor carries it exactly through a JavaScript Date.
    expect((await database.queryOne<{ truncated: boolean }>(
      "SELECT created_at = date_trunc('milliseconds', created_at) AS truncated FROM held_replies WHERE id = $1",
      [record.id],
    )).truncated).toBe(true);
    expect(await heldReplies.findInConversation(scope.conversationId, record.id)).toEqual(record);
    expect(await heldReplies.findInConversation(randomUUID(), record.id)).toBeNull();
  });

  it("keeps one live draft per conversation", async () => {
    const scope = await seedScope();
    const first = (await heldReplies.insert(holdInput(scope))).record;

    expect(await errorCode(heldReplies.insert(holdInput(scope)))).toBe(UNIQUE_VIOLATION);
    // A superseded result is not live, so it records beside the live draft.
    const born = await heldReplies.insert(holdInput(scope, { born: { state: "superseded", reason: "newer_inbound" } }));
    expect(born.record).toMatchObject({
      state: "superseded",
      supersededReason: "newer_inbound",
      attentionClearedReason: "superseded",
      attentionClearedAt: expect.any(Date),
      decidedAt: expect.any(Date),
    });

    expect(await heldReplies.supersedePendingForConversation(scope.conversationId, "newer_inbound")).toBe(1);
    const next = await heldReplies.insert(holdInput(scope));
    expect(next.created).toBe(true);
    expect((await heldReplies.findInConversation(scope.conversationId, first.id))?.state).toBe("superseded");
  });

  it("holds each review ref once per conversation: holding it again finds the first", async () => {
    const scope = await seedScope();
    const reviewRef = `email:${scope.conversationId}:7`;
    const first = await heldReplies.insert(holdInput(scope, { reviewRef }));

    const again = await heldReplies.insert(holdInput(scope, { reviewRef, draft: { text: "Other", presentation: {} } }));

    expect(again).toEqual({ record: first.record, created: false });
    expect(await heldReplies.findByReviewRef(scope.conversationId, reviewRef)).toEqual(first.record);
    expect(await heldReplies.findByReviewRef(scope.conversationId, `email:${scope.conversationId}:8`)).toBeNull();

    // Even once the first is decided, the ref still finds it rather than holding a second draft.
    await heldReplies.discard({ id: first.record.id, conversationId: scope.conversationId, userId: randomUUID() });
    expect((await heldReplies.insert(holdInput(scope, { reviewRef }))).created).toBe(false);

    const other = await seedConversation(scope.workspaceId);
    expect((await heldReplies.insert(holdInput({ ...scope, ...other }, { reviewRef }))).created).toBe(true);
  });

  it("releases a pending draft once: the conditional update gives a concurrent loser nothing", async () => {
    const scope = await seedScope();
    const { record } = await heldReplies.insert(holdInput(scope));
    const release = (userId: string) => database.kysely.transaction().execute((trx) =>
      new HeldReplyRepository(trx).release({
        id: record.id,
        conversationId: scope.conversationId,
        ownershipVersion: 0,
        editedText: null,
        userId,
      }));

    const outcomes = await Promise.all([release(randomUUID()), release(randomUUID())]);

    const winners = outcomes.filter((outcome): outcome is HeldReplyRecord => outcome !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      state: "released",
      releaseKind: "operator",
      editedText: null,
      editorUserId: null,
      attentionClearedReason: "released",
      decidedAt: expect.any(Date),
    });
    expect(await heldReplies.release({
      id: record.id, conversationId: scope.conversationId, ownershipVersion: 0, editedText: null, userId: randomUUID(),
    })).toBeNull();
    expect(await heldReplies.discard({ id: record.id, conversationId: scope.conversationId, userId: randomUUID() })).toBeNull();
  });

  it("releases only at the ownership version it was bound to, and records an edit beside the draft", async () => {
    const scope = await seedScope();
    const { record } = await heldReplies.insert(holdInput(scope, { ownershipVersion: 2 }));
    const userId = randomUUID();

    expect(await heldReplies.release({
      id: record.id, conversationId: scope.conversationId, ownershipVersion: 3, editedText: null, userId,
    })).toBeNull();
    const edited = await heldReplies.release({
      id: record.id, conversationId: scope.conversationId, ownershipVersion: 2, editedText: "Edited reply", userId,
    });
    const messageId = await addMessage(scope.workspaceId, scope.conversationId, "assistant");
    const linked = await heldReplies.attachReleasedMessage(record.id, messageId);

    expect(edited).toMatchObject({
      state: "edited",
      releaseKind: "operator",
      editedText: "Edited reply",
      editorUserId: userId,
      releaserUserId: userId,
      draft: { text: "Your refund was issued." },
    });
    expect(linked.releasedMessageId).toBe(messageId);
  });

  it("supersedes a conversation's live drafts, and a policy's, and nothing decided", async () => {
    const scope = await seedScope();
    const policy = { ref: `email_mailbox:${randomUUID()}`, version: 1 };
    const pending = (await heldReplies.insert(holdInput(scope, { policy }))).record;
    const other = await seedConversation(scope.workspaceId);
    const queued = (await heldReplies.insert(holdInput({ ...scope, ...other }, { policy }))).record;
    await database.execute("UPDATE held_replies SET state = 'queued_auto' WHERE id = $1", [queued.id]);
    const unrelated = await seedConversation(scope.workspaceId);
    const elsewhere = (await heldReplies.insert(holdInput({ ...scope, ...unrelated }))).record;

    expect(await heldReplies.supersedePendingForPolicy(policy.ref, "policy_changed")).toBe(2);
    expect(await heldReplies.supersedePendingForPolicy(policy.ref, "policy_changed")).toBe(0);
    expect(await heldReplies.findInConversation(other.conversationId, queued.id)).toMatchObject({
      state: "superseded", supersededReason: "policy_changed", attentionClearedReason: "superseded",
    });
    expect((await heldReplies.findInConversation(scope.conversationId, pending.id))?.state).toBe("superseded");
    expect((await heldReplies.findInConversation(unrelated.conversationId, elsewhere.id))?.state).toBe("pending");

    expect(await heldReplies.supersedePendingForConversation(unrelated.conversationId, "takeover")).toBe(1);
    expect(await heldReplies.findInConversation(unrelated.conversationId, elsewhere.id)).toMatchObject({
      state: "superseded", supersededReason: "takeover", attentionClearedReason: "takeover",
    });
  });

  it("keeps a discarded draft's attention open until a teammate replies or takes over", async () => {
    const scope = await seedScope();
    const { record } = await heldReplies.insert(holdInput(scope));
    const userId = randomUUID();

    const discarded = await heldReplies.discard({ id: record.id, conversationId: scope.conversationId, userId });
    expect(discarded).toMatchObject({ state: "discarded", discardedByUserId: userId, attentionClearedAt: null });
    expect(await heldReplies.supersedePendingForConversation(scope.conversationId, "operator_reply")).toBe(0);

    expect(await heldReplies.clearDiscardedAttention(scope.conversationId, "operator_reply")).toBe(1);
    expect(await heldReplies.clearDiscardedAttention(scope.conversationId, "takeover")).toBe(0);
    expect(await heldReplies.findInConversation(scope.conversationId, record.id)).toMatchObject({
      state: "discarded", attentionClearedReason: "operator_reply", attentionClearedAt: expect.any(Date),
    });
  });

  it("lists the drafts waiting for a teammate newest first, leaving queued automatic sends out", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const otherAgentId = randomUUID();
    await database.execute("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Other')", [otherAgentId, workspaceId]);
    const records: HeldReplyRecord[] = [];
    for (const variant of ["pending", "queued_auto", "discarded", "released", "other_agent"] as const) {
      const conversation = await seedConversation(workspaceId);
      const scope = { workspaceId, agentId: variant === "other_agent" ? otherAgentId : agentId, ...conversation };
      const { record } = await heldReplies.insert(holdInput(scope));
      if (variant === "queued_auto") {
        await database.execute("UPDATE held_replies SET state = 'queued_auto' WHERE id = $1", [record.id]);
      } else if (variant === "discarded") {
        await heldReplies.discard({ id: record.id, conversationId: record.conversationId, userId: randomUUID() });
      } else if (variant === "released") {
        await heldReplies.release({
          id: record.id, conversationId: record.conversationId, ownershipVersion: 0, editedText: null, userId: randomUUID(),
        });
      }
      records.push(record);
    }
    const [pending, queued, discarded, released, otherAgents] = records;
    const ids = (rows: HeldReplyRecord[]) => rows.map((row) => row.id);
    const everything = { agentId: undefined, after: null, limit: 10 };

    expect(ids(await heldReplies.listOpen(workspaceId, everything))).toEqual([otherAgents.id, discarded.id, pending.id]);
    expect(ids(await heldReplies.listAll(workspaceId, everything)))
      .toEqual([otherAgents.id, released.id, discarded.id, queued.id, pending.id]);
    expect(ids(await heldReplies.listOpen(workspaceId, { ...everything, agentId }))).toEqual([discarded.id, pending.id]);

    const firstPage = await heldReplies.listOpen(workspaceId, { ...everything, limit: 2 });
    const last = firstPage.at(-1)!;
    expect(ids(await heldReplies.listOpen(workspaceId, { ...everything, after: { createdAt: last.createdAt, id: last.id } })))
      .toEqual([pending.id]);
    expect(await heldReplies.listOpen(randomUUID(), everything)).toEqual([]);
  });

  it("finds the conversation's current held reply and its newest customer message", async () => {
    const scope = await seedScope();
    expect(await heldReplies.current(scope.workspaceId, scope.conversationId)).toBeNull();
    expect(await heldReplies.latestCustomerMessageId(scope.conversationId)).toBe(scope.inboundId);

    const first = (await heldReplies.insert(holdInput(scope))).record;
    await heldReplies.supersedePendingForConversation(scope.conversationId, "newer_inbound");
    await addMessage(scope.workspaceId, scope.conversationId, "assistant");
    const newerInbound = await addMessage(scope.workspaceId, scope.conversationId, "user");
    await addMessage(scope.workspaceId, scope.conversationId, "assistant");
    const second = (await heldReplies.insert(holdInput({ ...scope, inboundId: newerInbound }))).record;

    expect(await heldReplies.latestCustomerMessageId(scope.conversationId)).toBe(newerInbound);
    expect((await heldReplies.current(scope.workspaceId, scope.conversationId))?.id).toBe(second.id);
    expect(await heldReplies.current(randomUUID(), scope.conversationId)).toBeNull();
    expect(first.id).not.toBe(second.id);
  });

  it("goes with its conversation, and a deleted released message only clears the link", async () => {
    const scope = await seedScope();
    const { record } = await heldReplies.insert(holdInput(scope));
    await heldReplies.release({
      id: record.id, conversationId: scope.conversationId, ownershipVersion: 0, editedText: null, userId: randomUUID(),
    });
    const messageId = await addMessage(scope.workspaceId, scope.conversationId, "assistant");
    await heldReplies.attachReleasedMessage(record.id, messageId);

    await database.execute("DELETE FROM messages WHERE id = $1", [messageId]);
    expect((await heldReplies.findInConversation(scope.conversationId, record.id))?.releasedMessageId).toBeNull();

    await database.execute("DELETE FROM conversations WHERE id = $1", [scope.conversationId]);
    expect(await heldReplies.findInConversation(scope.conversationId, record.id)).toBeNull();
  });
});
