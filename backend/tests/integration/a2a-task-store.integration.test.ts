import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { createWorkspaceConversationDataErasure } from "../../src/app/composition/conversationErasure.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import {
  A2aMessageReceiptRepository,
  A2aMessageReceiptRetention,
  A2aTaskExporter,
  A2aTaskRepository,
  A2aTaskRetention,
  type A2aTaskRecord,
} from "../../src/modules/a2a/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const DAY_MS = 24 * 60 * 60 * 1_000;

describeIntegration("A2A task and receipt stores (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const tasks = new A2aTaskRepository(database.kysely);
  const receipts = new A2aMessageReceiptRepository(database.kysely);
  const seededAccountIds: string[] = [];
  let workspaceId: string;
  let agentId: string;

  beforeAll(async () => {
    await runAllTestMigrations(database);
    const account = await new AccountRepository(database.kysely).create({
      name: "A2A",
      email: `a2a-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    workspaceId = (await new WorkspaceRepository(database.kysely).create(account.id, "A2A Workspace")).id;
    agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Support')", [agentId, workspaceId]);
  });

  afterAll(async () => {
    const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());
    for (const accountId of seededAccountIds) {
      await lifecycle.deleteAccount({
        accountId,
        auditEvent: { accountId, eventType: "account.delete", eventStatus: "success", metadata: {} },
      });
    }
    await database.close().catch(() => undefined);
  });

  const seedConversation = async (): Promise<string> => {
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, source_channel) VALUES ($1, $2, $3, 'a2a')",
      [conversationId, workspaceId, agentId],
    );
    return conversationId;
  };

  const newTask = (conversationId: string, overrides: Partial<A2aTaskRecord> = {}): Omit<A2aTaskRecord, "version"> => ({
    id: randomUUID().replaceAll("-", ""),
    workspaceId,
    conversationId,
    contextToken: "sealed-context",
    contextExpiresAt: null,
    routineExecutionId: "exec-1",
    openingMessageId: randomUUID(),
    callerMessageId: null,
    cursor: "cursor-1",
    shownThroughMessageId: randomUUID(),
    statusMessageId: null,
    artifactMessageId: null,
    envelope: { ownership: { state: "ai_owned", suppressed: false }, citations: [] },
    state: "input_required",
    reason: "awaiting_input",
    humanStretch: false,
    stateAt: new Date(),
    ...overrides,
  });

  it("stores references and state, and compares and sets on the version", async () => {
    const conversationId = await seedConversation();
    const task = newTask(conversationId);
    await expect(tasks.commit({ updates: [], insert: task })).resolves.toBe("committed");

    expect(await tasks.findById(task.id)).toEqual({ ...task, version: 1 });
    expect(await tasks.findOpen(conversationId)).toMatchObject({ id: task.id });

    await expect(tasks.commit({ updates: [{ id: task.id, expectedVersion: 1, changes: { state: "working", reason: "human_owned" } }] }))
      .resolves.toBe("committed");
    // A write from the older snapshot loses, and changes nothing.
    await expect(tasks.commit({ updates: [{ id: task.id, expectedVersion: 1, changes: { state: "completed", reason: "handed_back" } }] }))
      .resolves.toBe("conflict");
    expect(await tasks.findById(task.id)).toMatchObject({ state: "working", reason: "human_owned", version: 2 });
  });

  it("keeps one open task per conversation, and rolls a whole write back when any part of it fails", async () => {
    const conversationId = await seedConversation();
    const first = newTask(conversationId);
    await tasks.commit({ updates: [], insert: first });

    await expect(tasks.commit({ updates: [], insert: newTask(conversationId) })).resolves.toBe("conflict");
    // Closing the open one and opening its replacement in one write is allowed...
    const replacement = newTask(conversationId, { routineExecutionId: "exec-2" });
    await expect(tasks.commit({
      updates: [{ id: first.id, expectedVersion: 1, changes: { state: "canceled", reason: "routine_replaced" } }],
      insert: replacement,
    })).resolves.toBe("committed");
    // ...and a write whose update loses leaves its insert undone too.
    await expect(tasks.commit({
      updates: [{ id: replacement.id, expectedVersion: 7, changes: { state: "canceled" } }],
      insert: newTask(conversationId, { state: "completed" }),
    })).resolves.toBe("conflict");

    expect((await tasks.list({ conversationId, state: null, stateAfter: null, before: null, limit: 10 })).total).toBe(2);
    expect(await tasks.findOpen(conversationId)).toMatchObject({ id: replacement.id });
  });

  it("lists one conversation's tasks newest status first, with filters and keyset pages", async () => {
    const conversationId = await seedConversation();
    const base = Date.now();
    const older = newTask(conversationId, { state: "completed", stateAt: new Date(base - 3_000) });
    const middle = newTask(conversationId, { state: "canceled", stateAt: new Date(base - 2_000) });
    const newest = newTask(conversationId, { state: "input_required", stateAt: new Date(base - 1_000) });
    for (const task of [older, middle, newest]) await tasks.commit({ updates: [], insert: task });
    await tasks.commit({ updates: [], insert: newTask(await seedConversation()) });

    const firstPage = await tasks.list({ conversationId, state: null, stateAfter: null, before: null, limit: 2 });
    const secondPage = await tasks.list({ conversationId, state: null, stateAfter: null, before: { stateAt: middle.stateAt, id: middle.id }, limit: 2 });
    const completed = await tasks.list({ conversationId, state: "completed", stateAfter: null, before: null, limit: 10 });
    // Strictly after: a task whose status changed at the instant named is not listed.
    const recent = await tasks.list({ conversationId, state: null, stateAfter: new Date(base - 2_000), before: null, limit: 10 });
    const justBefore = await tasks.list({ conversationId, state: null, stateAfter: new Date(base - 2_001), before: null, limit: 10 });

    expect(firstPage.tasks.map((task) => task.id)).toEqual([newest.id, middle.id]);
    expect(firstPage.total).toBe(3);
    expect(secondPage.tasks.map((task) => task.id)).toEqual([older.id]);
    expect(completed.tasks.map((task) => task.id)).toEqual([older.id]);
    expect(recent.tasks.map((task) => task.id)).toEqual([newest.id]);
    expect(recent.total).toBe(1);
    expect(justBefore.tasks.map((task) => task.id)).toEqual([newest.id, middle.id]);
  });

  it("claims a receipt once, answers a retry in flight, replays a completed one, and takes over a stale claim", async () => {
    const conversationId = await seedConversation();
    const scope = { workspaceId, conversationId, messageKey: "digest-0000000000000001", expiresAt: null };
    const notStale = new Date(Date.now() - 60_000);

    await expect(receipts.claim({ ...scope, claimToken: "claim-1", staleBefore: notStale })).resolves.toEqual({ kind: "claimed" });
    await expect(receipts.claim({ ...scope, claimToken: "claim-2", staleBefore: notStale })).resolves.toEqual({ kind: "in_flight" });
    // A claim older than the stale bound belongs to a send that died with its process.
    await expect(receipts.claim({ ...scope, claimToken: "claim-3", staleBefore: new Date(Date.now() + 60_000) })).resolves.toEqual({ kind: "claimed" });

    await receipts.complete({ ...scope, claimToken: "claim-3", result: { kind: "task", taskId: "task-1" } });
    await expect(receipts.claim({ ...scope, claimToken: "claim-4", staleBefore: new Date(Date.now() + 60_000) }))
      .resolves.toEqual({ kind: "completed", result: { kind: "task", taskId: "task-1" } });

    const failed = { ...scope, messageKey: "digest-0000000000000002" };
    await receipts.claim({ ...failed, claimToken: "claim-5", staleBefore: notStale });
    await receipts.release({ ...failed, claimToken: "claim-5" });
    await expect(receipts.claim({ ...failed, claimToken: "claim-6", staleBefore: notStale })).resolves.toEqual({ kind: "claimed" });
  });

  it("lets only the send holding a claim complete or release it, so a slow send cannot touch its takeover's", async () => {
    const conversationId = await seedConversation();
    const scope = { workspaceId, conversationId, expiresAt: null };
    const stale = new Date(Date.now() + 60_000);
    const notStale = new Date(Date.now() - 60_000);

    // The slow send finishes after its claim was taken over: its result is not recorded.
    const finished = { ...scope, messageKey: "digest-takeover-000001" };
    await receipts.claim({ ...finished, claimToken: "slow", staleBefore: notStale });
    await receipts.claim({ ...finished, claimToken: "takeover", staleBefore: stale });
    await receipts.complete({ ...finished, claimToken: "slow", result: { kind: "task", taskId: "slow-task" } });
    await expect(receipts.claim({ ...finished, claimToken: "retry-1", staleBefore: notStale })).resolves.toEqual({ kind: "in_flight" });
    await receipts.complete({ ...finished, claimToken: "takeover", result: { kind: "task", taskId: "takeover-task" } });
    await expect(receipts.claim({ ...finished, claimToken: "retry-2", staleBefore: notStale }))
      .resolves.toEqual({ kind: "completed", result: { kind: "task", taskId: "takeover-task" } });

    // The slow send fails after its claim was taken over: the takeover's claim stays.
    const failed = { ...scope, messageKey: "digest-stale-release-01" };
    await receipts.claim({ ...failed, claimToken: "slow", staleBefore: notStale });
    await receipts.claim({ ...failed, claimToken: "takeover", staleBefore: stale });
    await receipts.release({ ...failed, claimToken: "slow" });
    await expect(receipts.claim({ ...failed, claimToken: "retry-3", staleBefore: notStale })).resolves.toEqual({ kind: "in_flight" });

    // A context's first send claimed nothing; its result is recorded only where no receipt exists.
    const first = { ...scope, messageKey: "digest-first-send-0001" };
    await receipts.complete({ ...first, claimToken: null, result: { kind: "task", taskId: "first-task" } });
    await receipts.complete({ ...first, claimToken: null, result: { kind: "task", taskId: "other-task" } });
    await expect(receipts.claim({ ...first, claimToken: "retry-4", staleBefore: notStale }))
      .resolves.toEqual({ kind: "completed", result: { kind: "task", taskId: "first-task" } });
  });

  it("keeps a task a stretch of human ownership once it was one, whatever a later write says", async () => {
    const conversationId = await seedConversation();
    const task = newTask(conversationId, { routineExecutionId: null, state: "working", reason: "human_owned", humanStretch: true });
    await tasks.commit({ updates: [], insert: task });

    await tasks.commit({ updates: [{ id: task.id, expectedVersion: 1, changes: { state: "input_required", reason: "agent_message" } }] });

    expect(await tasks.findById(task.id)).toMatchObject({ reason: "agent_message", humanStretch: true, version: 2 });
    const marked = newTask(await seedConversation());
    await tasks.commit({ updates: [], insert: marked });
    await tasks.commit({ updates: [{ id: marked.id, expectedVersion: 1, changes: { reason: "human_message", humanStretch: true } }] });
    expect(await tasks.findById(marked.id)).toMatchObject({ humanStretch: true });
  });

  it("prunes expired walk-in contexts and long-finished tasks and receipts, keeping live ones", async () => {
    const conversationId = await seedConversation();
    const now = new Date();
    const expiredWalkIn = newTask(conversationId, { contextExpiresAt: new Date(now.getTime() - 1_000), state: "completed" });
    const oldFinished = newTask(conversationId, { state: "completed", stateAt: new Date(now.getTime() - 91 * DAY_MS) });
    const liveOpen = newTask(conversationId, { stateAt: new Date(now.getTime() - 120 * DAY_MS) });
    for (const task of [expiredWalkIn, oldFinished, liveOpen]) await tasks.commit({ updates: [], insert: task });
    await receipts.complete({ workspaceId, conversationId, messageKey: "digest-expired-000001", claimToken: null, expiresAt: new Date(now.getTime() - 1_000), result: { kind: "task", taskId: liveOpen.id } });
    await receipts.complete({ workspaceId, conversationId, messageKey: "digest-live-0000000001", claimToken: null, expiresAt: new Date(now.getTime() + DAY_MS), result: { kind: "task", taskId: liveOpen.id } });

    const removedTasks = await new A2aTaskRetention(database.kysely).enforce({ now, limit: 100 });
    const removedReceipts = await new A2aMessageReceiptRetention(database.kysely).enforce({ now, limit: 100 });

    expect(removedTasks).toBeGreaterThanOrEqual(2);
    expect(removedReceipts).toBeGreaterThanOrEqual(1);
    expect(await tasks.findById(expiredWalkIn.id)).toBeNull();
    expect(await tasks.findById(oldFinished.id)).toBeNull();
    expect(await tasks.findById(liveOpen.id)).not.toBeNull();
    const [left] = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM a2a_message_receipts WHERE conversation_id = $1",
      [conversationId],
    );
    expect(Number(left.count)).toBe(1);
  });

  it("exports a subject's tasks by state and reason, without their ids, and goes with the conversation", async () => {
    const conversationId = await seedConversation();
    const task = newTask(conversationId, { state: "completed", reason: "routine_completed" });
    await tasks.commit({ updates: [], insert: task });
    await receipts.complete({ workspaceId, conversationId, messageKey: "digest-export-00000001", claimToken: null, expiresAt: null, result: { kind: "task", taskId: task.id } });

    const exported = await new A2aTaskExporter(database.kysely).export({ workspaceId, conversationIds: [conversationId], visitorIds: [], verifiedCustomerIds: [] });
    expect(exported).toEqual([{
      conversationId,
      state: "completed",
      reason: "routine_completed",
      stateAt: task.stateAt.toISOString(),
      openedAt: expect.any(String),
    }]);
    expect(JSON.stringify(exported)).not.toContain(task.id);

    await database.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
    expect(await tasks.findById(task.id)).toBeNull();
    const [left] = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM a2a_message_receipts WHERE conversation_id = $1",
      [conversationId],
    );
    expect(Number(left.count)).toBe(0);
  });
});
