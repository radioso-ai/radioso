import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { ConversationActivityRepository } from "../../src/db/repositories/conversationActivityRepository.js";
import {
  bindDeliveryFailureRecorder,
  ConversationDeliveryFailureRepository,
  DeliveryFailures,
  type DeliveryFailureRecord,
  type DeliveryFailureUnitOfWork,
} from "../../src/modules/customerReplyDelivery/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("conversation delivery failures (Postgres)", () => {
  const testDatabaseName = `delivery_failures_${randomUUID().replaceAll("-", "")}_test`;
  let database: Database;
  let activity: ConversationActivityRepository;
  let writes: DeliveryFailureUnitOfWork;
  let failures: DeliveryFailures;

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
    activity = new ConversationActivityRepository(database.kysely);
    // What composition wires: the failure and its activity in one transaction.
    writes = {
      run: (work) => database.kysely.transaction().execute((trx) => work({
        failures: new ConversationDeliveryFailureRepository(trx),
        activity: { record: (event) => activity.record(trx, event) },
      })),
    };
    failures = new DeliveryFailures({ writes, reads: new ConversationDeliveryFailureRepository(database.kysely) });
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
    const otherAgentId = randomUUID();
    const userId = randomUUID();
    await database.execute("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')", [
      accountId,
      `delivery-failures-${accountId}@example.test`,
    ]);
    await database.execute("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)", [
      workspaceId,
      accountId,
      `rk-${workspaceId}`,
    ]);
    await database.execute("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Agent'), ($3, $2, 'Other')", [
      agentId,
      workspaceId,
      otherAgentId,
    ]);
    await database.execute("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [
      userId,
      `delivery-failures-${userId}@example.test`,
    ]);
    return { workspaceId, agentId, otherAgentId, userId };
  };

  const seedConversation = async (workspaceId: string, agentId: string | null, messages = 1) => {
    const conversationId = randomUUID();
    await database.execute(
      "INSERT INTO conversations (id, workspace_id, agent_id, source_channel) VALUES ($1, $2, $3, 'email')",
      [conversationId, workspaceId, agentId],
    );
    const messageIds: string[] = [];
    for (let index = 0; index < messages; index += 1) {
      const messageId = randomUUID();
      await database.execute(
        "INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'assistant', 'Reply')",
        [messageId, conversationId, workspaceId],
      );
      messageIds.push(messageId);
    }
    return { conversationId, messageIds };
  };

  const openInput = (
    workspaceId: string,
    conversationId: string,
    messageId: string | null,
    kind: DeliveryFailureRecord["kind"] = "bounced",
  ) => ({ workspaceId, conversationId, messageId, provider: "resend", kind, detailCode: null });

  const newestFirst = (left: DeliveryFailureRecord, right: DeliveryFailureRecord): number =>
    right.openedAt.getTime() - left.openedAt.getTime() || (right.id < left.id ? -1 : right.id > left.id ? 1 : 0);

  const failureRows = (conversationId: string) =>
    database.kysely
      .selectFrom("conversation_delivery_failures")
      .select(["id", "message_id", "failure_kind", "detail_code", "cleared_at", "clear_reason", "cleared_by_user_id"])
      .where("conversation_id", "=", conversationId)
      .orderBy("opened_at")
      .orderBy("id")
      .execute();

  const activityRows = (conversationId: string) =>
    database.kysely
      .selectFrom("conversation_activity")
      .select(["kind", "actor_user_id", "detail"])
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();

  it("keeps one open failure per message, so a repeated or concurrent open records it once", async () => {
    const { workspaceId } = await seedWorkspace();
    const { conversationId, messageIds: [messageId] } = await seedConversation(workspaceId, null);

    await Promise.all(Array.from({ length: 5 }, () => failures.open(openInput(workspaceId, conversationId, messageId, "uncertain"))));
    await failures.open(openInput(workspaceId, conversationId, messageId, "failed"));
    await failures.open(openInput(workspaceId, conversationId, null, "halted"));
    await failures.open(openInput(workspaceId, conversationId, null, "halted"));
    const repeated = await new ConversationDeliveryFailureRepository(database.kysely)
      .insertOpen(openInput(workspaceId, conversationId, messageId));

    expect(repeated).toBeNull();
    const rows = await failureRows(conversationId);
    expect(rows.map((row) => [row.message_id, row.failure_kind])).toEqual(expect.arrayContaining([
      [messageId, "uncertain"],
      [null, "halted"],
    ]));
    expect(rows).toHaveLength(2);
    const opened = await activityRows(conversationId);
    expect(opened.map((row) => row.kind)).toEqual(["delivery_failed", "delivery_failed"]);
    expect(opened.map((row) => row.detail)).toEqual(expect.arrayContaining([
      { failureId: rows.find((row) => row.message_id === messageId)!.id, messageId, failureKind: "uncertain" },
    ]));

    await failures.clear({ conversationId, messageIds: [messageId], reason: "provider_evidence" });
    await failures.open(openInput(workspaceId, conversationId, messageId, "failed"));

    const reopened = await failureRows(conversationId);
    const onMessage = reopened.filter((row) => row.message_id === messageId);
    expect(onMessage).toHaveLength(2);
    expect(onMessage.map((row) => [row.failure_kind, row.clear_reason])).toEqual(expect.arrayContaining([
      ["uncertain", "provider_evidence"],
      ["failed", null],
    ]));
  });

  it("retargets the open failure to the settled kind and records it, once", async () => {
    const { workspaceId } = await seedWorkspace();
    const { conversationId, messageIds: [messageId] } = await seedConversation(workspaceId, null);
    await failures.open(openInput(workspaceId, conversationId, messageId, "uncertain"));

    await failures.retarget({ conversationId, messageId, kind: "bounced", detailCode: "suppressed" });
    await failures.retarget({ conversationId, messageId, kind: "bounced", detailCode: "suppressed" });
    await failures.retarget({ conversationId, messageId: randomUUID(), kind: "failed", detailCode: null });

    const [row] = await failureRows(conversationId);
    expect(row).toMatchObject({ failure_kind: "bounced", detail_code: "suppressed", cleared_at: null });
    expect((await activityRows(conversationId)).map((entry) => entry.detail)).toEqual([
      { failureId: row.id, messageId, failureKind: "uncertain" },
      { failureId: row.id, messageId, failureKind: "bounced" },
    ]);
  });

  it("clears exactly the failure a teammate resolved, naming them, or the failures of the messages a delivery vouches for", async () => {
    const { workspaceId, userId } = await seedWorkspace();
    const { conversationId, messageIds: [first, second, third] } = await seedConversation(workspaceId, null, 3);
    const other = await seedConversation(workspaceId, null);
    await failures.open(openInput(workspaceId, conversationId, first, "uncertain"));
    await failures.open(openInput(workspaceId, conversationId, second, "halted"));
    await failures.open(openInput(workspaceId, conversationId, third, "bounced"));
    await failures.open(openInput(workspaceId, other.conversationId, other.messageIds[0]));
    const firstFailure = (await failureRows(conversationId)).find((row) => row.message_id === first)!;

    expect(await failures.clear({ failureId: firstFailure.id, reason: "operator_resolved", userId })).toBe(1);
    expect(await failures.clear({ failureId: firstFailure.id, reason: "operator_resolved", userId })).toBe(0);
    expect(await failures.clear({ conversationId, messageIds: [first, second], reason: "later_delivery" })).toBe(1);
    expect(await failures.clear({ conversationId, messageIds: [second], reason: "later_delivery" })).toBe(0);
    expect(await failures.clear({ conversationId, messageIds: [], reason: "later_delivery" })).toBe(0);

    const rows = await failureRows(conversationId);
    const onFirst = rows.find((row) => row.message_id === first)!;
    const onSecond = rows.find((row) => row.message_id === second)!;
    expect(onFirst).toMatchObject({ clear_reason: "operator_resolved", cleared_by_user_id: userId, cleared_at: expect.any(Date) });
    expect(onSecond).toMatchObject({ clear_reason: "later_delivery", cleared_by_user_id: null, cleared_at: expect.any(Date) });
    const cleared = (await activityRows(conversationId)).filter((entry) => entry.kind === "delivery_failure_cleared");
    expect(cleared).toEqual([
      { kind: "delivery_failure_cleared", actor_user_id: userId, detail: { failureId: onFirst.id, messageId: first, reason: "operator_resolved" } },
      { kind: "delivery_failure_cleared", actor_user_id: null, detail: { failureId: onSecond.id, messageId: second, reason: "later_delivery" } },
    ]);
    // The third message's failure belongs to no message the delivery vouched for.
    expect(rows.find((row) => row.message_id === third)).toMatchObject({ cleared_at: null });
    expect((await failureRows(other.conversationId)).map((row) => row.cleared_at)).toEqual([null]);
  });

  it("locks a workspace's failure for a decision only while it is open, holding off a concurrent clear until the decision commits", async () => {
    const { workspaceId, userId } = await seedWorkspace();
    const elsewhere = await seedWorkspace();
    const { conversationId, messageIds: [messageId] } = await seedConversation(workspaceId, null);
    await failures.open(openInput(workspaceId, conversationId, messageId, "halted"));
    const [failure] = await failureRows(conversationId);
    const decisionLock = (failureWorkspaceId: string) => writes.run((scope) =>
      bindDeliveryFailureRecorder(scope).lockOpen({ workspaceId: failureWorkspaceId, failureId: failure.id }));

    expect(await decisionLock(elsewhere.workspaceId)).toBeNull();

    // A decision holds the failure; a second one names it too and waits until the first commits.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = writes.run(async (scope) => {
      const recorder = bindDeliveryFailureRecorder(scope);
      const locked = await recorder.lockOpen({ workspaceId, failureId: failure.id });
      await held;
      return { locked, cleared: await recorder.clear({ failureId: failure.id, reason: "operator_resolved", userId }) };
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = decisionLock(workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();

    expect(await first).toMatchObject({ locked: { id: failure.id, kind: "halted" }, cleared: 1 });
    expect(await second).toBeNull();
  });

  it("rolls the failure back when its activity cannot be recorded", async () => {
    const { workspaceId } = await seedWorkspace();
    const { conversationId, messageIds: [messageId] } = await seedConversation(workspaceId, null);
    const brokenActivity = new DeliveryFailures({
      writes: {
        run: (work) => database.kysely.transaction().execute((trx) => work({
          failures: new ConversationDeliveryFailureRepository(trx),
          activity: { record: async () => { throw new Error("activity write failed"); } },
        })),
      },
      reads: new ConversationDeliveryFailureRepository(database.kysely),
    });

    await expect(brokenActivity.open(openInput(workspaceId, conversationId, messageId))).rejects.toThrow("activity write failed");

    expect(await failureRows(conversationId)).toEqual([]);
  });

  it("lists a workspace's open failures newest first, filtered by agent, page by page", async () => {
    const { workspaceId, agentId, otherAgentId } = await seedWorkspace();
    const elsewhere = await seedWorkspace();
    const halted = await seedConversation(workspaceId, agentId, 3);
    const later = await seedConversation(workspaceId, agentId);
    const otherAgent = await seedConversation(workspaceId, otherAgentId);
    const cleared = await seedConversation(workspaceId, agentId);
    const foreign = await seedConversation(elsewhere.workspaceId, elsewhere.agentId);
    // A removed domain halts several sends in one transaction: their failures open at the same instant.
    await writes.run(async (scope) => {
      const recorder = bindDeliveryFailureRecorder(scope);
      for (const messageId of halted.messageIds) {
        await recorder.open(openInput(workspaceId, halted.conversationId, messageId, "halted"));
      }
    });
    await failures.open(openInput(workspaceId, later.conversationId, later.messageIds[0]));
    await failures.open(openInput(workspaceId, otherAgent.conversationId, otherAgent.messageIds[0]));
    await failures.open(openInput(workspaceId, cleared.conversationId, cleared.messageIds[0]));
    await failures.clear({ conversationId: cleared.conversationId, messageIds: cleared.messageIds, reason: "later_delivery" });
    await failures.open(openInput(elsewhere.workspaceId, foreign.conversationId, foreign.messageIds[0]));

    const pages: DeliveryFailureRecord[][] = [];
    let cursor: string | undefined;
    do {
      const page = await failures.listOpen(workspaceId, { agentId, cursor, limit: 2 });
      pages.push(page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(pages.map((page) => page.length)).toEqual([2, 2]);
    const listed = pages.flat();
    expect(listed).toEqual([...listed].sort(newestFirst));
    expect(listed.map((failure) => failure.messageId).sort()).toEqual([...halted.messageIds, later.messageIds[0]].sort());
    const haltedTogether = listed.filter((failure) => failure.conversationId === halted.conversationId);
    expect(new Set(haltedTogether.map((failure) => failure.openedAt.getTime())).size).toBe(1);

    const everyAgent = await failures.listOpen(workspaceId, { limit: 10 });
    expect(everyAgent.items).toEqual([...everyAgent.items].sort(newestFirst));
    expect(everyAgent.items.map((failure) => failure.messageId).sort()).toEqual(
      [...halted.messageIds, later.messageIds[0], otherAgent.messageIds[0]].sort(),
    );
    expect(everyAgent.nextCursor).toBeNull();
  });
});
