import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { createWorkspaceConversationDataErasure } from "../../src/app/composition/conversationErasure.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import {
  A2aMessageReceiptRepository,
  A2aTaskRepository,
  type A2aMessageReceiptStore,
  type A2aTaskStore,
  type A2aTaskWrite,
} from "../../src/modules/a2a/public.js";
import { A2A_CONVERSE_EXTENSION_URI } from "../../src/shared/domain/a2aConverseExtension.js";
import { Database } from "../../src/shared/infra/database.js";
import {
  conversationIdForContext,
  createA2aTestApp,
  openA2aAgent,
  operatorOf,
  rpc,
  sendText,
  supportIntakeDraft,
} from "../support/a2aTestApp.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const extension = { extensions: A2A_CONVERSE_EXTENSION_URI };

describeIntegration("A2A tasks on the Postgres task and receipt stores", () => {
  const database = new Database(integrationDatabaseUrl);
  const accountIds: string[] = [];

  beforeAll(async () => {
    await runAllTestMigrations(database);
    const account = await new AccountRepository(database.kysely).create({
      name: "A2A stores",
      email: `a2a-stores-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    accountIds.push(account.id);
  });

  afterAll(async () => {
    const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());
    for (const accountId of accountIds) {
      await lifecycle.deleteAccount({
        accountId,
        auditEvent: { accountId, eventType: "account.delete", eventStatus: "success", metadata: {} },
      });
    }
    await database.close().catch(() => undefined);
  });

  /**
   * The app keeps workspaces and conversations in memory; their rows are written here under the
   * same ids, so the A2A tables' foreign keys hold. The repositories themselves run unchanged.
   */
  const ensureParents = async (workspaceId: string, conversationId: string): Promise<void> => {
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'A2A stores', $3) ON CONFLICT (id) DO NOTHING",
      [workspaceId, accountIds[0], `a2a-stores-${workspaceId}`],
    );
    await database.query(
      "INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'a2a') ON CONFLICT (id) DO NOTHING",
      [conversationId, workspaceId],
    );
  };

  const postgresStores = () => {
    const repository = new A2aTaskRepository(database.kysely);
    const receiptRepository = new A2aMessageReceiptRepository(database.kysely);
    const hooks: { beforeInsert: ((write: A2aTaskWrite) => Promise<void>) | null } = { beforeInsert: null };
    const tasks: A2aTaskStore = {
      findById: (id) => repository.findById(id),
      findOpen: (conversationId) => repository.findOpen(conversationId),
      list: (query) => repository.list(query),
      async commit(write) {
        if (write.insert) {
          await ensureParents(write.insert.workspaceId, write.insert.conversationId);
          const hook = hooks.beforeInsert;
          hooks.beforeInsert = null;
          await hook?.(write);
        }
        return repository.commit(write);
      },
    };
    const receipts: A2aMessageReceiptStore = {
      async claim(input) {
        await ensureParents(input.workspaceId, input.conversationId);
        return receiptRepository.claim(input);
      },
      async complete(input) {
        await ensureParents(input.workspaceId, input.conversationId);
        return receiptRepository.complete(input);
      },
      release: (input) => receiptRepository.release(input),
    };
    return { stores: { tasks, receipts }, repository, hooks };
  };

  const openTaskCount = async (conversationId: string): Promise<number> => {
    const [row] = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM a2a_tasks WHERE conversation_id = $1 AND state IN ('submitted', 'working', 'input_required', 'auth_required')",
      [conversationId],
    );
    return Number(row?.count ?? 0);
  };

  it("runs a routine from INPUT_REQUIRED to COMPLETED, reading the stored turn report back, and replays a repeated send", async () => {
    const { stores } = postgresStores();
    const ctx = createA2aTestApp({ stores });
    const { session, agent, publicId } = await openA2aAgent(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(session.workspaceId, agent.id, supportIntakeDraft());

    const started = await sendText(ctx, publicId, "I need support intake", {}, extension).expect(200);
    const task = started.body.result.task;
    expect(task.status).toMatchObject({
      state: "TASK_STATE_INPUT_REQUIRED",
      message: { metadata: { [A2A_CONVERSE_EXTENSION_URI]: expect.objectContaining({ routine: expect.objectContaining({ pendingInput: [expect.objectContaining({ key: "topic" })] }) }) } },
    });
    // The read renders the envelope the turn stored as JSONB, unchanged.
    const read = await rpc(ctx, publicId, "GetTask", { id: task.id }, extension).expect(200);
    expect(read.body.result).toEqual(task);

    const completedSend = { taskId: task.id, contextId: task.contextId, messageId: `pg-${randomUUID()}` };
    const completed = await sendText(ctx, publicId, "topic: billing", completedSend, extension).expect(200);
    expect(completed.body.result.task).toMatchObject({
      id: task.id,
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ name: "Support intake", parts: [{ text: expect.any(String) }] }],
      metadata: { [A2A_CONVERSE_EXTENSION_URI]: { reason: "routine_completed" } },
    });
    const replayed = await sendText(ctx, publicId, "topic: billing", completedSend, extension).expect(200);
    expect(replayed.body.result).toEqual(completed.body.result);
    expect((await rpc(ctx, publicId, "GetTask", { id: task.id }, extension).expect(200)).body.result).toEqual(completed.body.result.task);
  });

  it("is WORKING after a handoff, INPUT_REQUIRED on a person's reply, and COMPLETED after the hand-back", async () => {
    const { stores, repository } = postgresStores();
    const ctx = createA2aTestApp({ stores });
    const { session, publicId } = await openA2aAgent(ctx);
    const opened = await sendText(ctx, publicId, "Hello, no routine").expect(200);
    const contextId = opened.body.result.message.contextId as string;
    const operator = operatorOf(ctx, session, await conversationIdForContext(ctx, contextId));

    const takeover = await operator.takeOver();
    const waiting = await sendText(ctx, publicId, "Can a person help?", { contextId }).expect(200);
    const taskId = waiting.body.result.task.id as string;
    expect(waiting.body.result.task.status.state).toBe("TASK_STATE_WORKING");

    const replied = await operator.reply("I can help with that.", takeover.body.ownership.version);
    const read = await rpc(ctx, publicId, "GetTask", { id: taskId }, extension).expect(200);
    expect(read.body.result.status).toMatchObject({ state: "TASK_STATE_INPUT_REQUIRED", message: { parts: [{ text: "I can help with that." }] } });
    expect(await repository.findById(taskId)).toMatchObject({ reason: "human_message", humanStretch: true });

    const answered = await sendText(ctx, publicId, "Order 1042, please.", { taskId, contextId }).expect(200);
    expect(answered.body.result.task.status.state).toBe("TASK_STATE_WORKING");

    await operator.handBack(replied.body.ownership?.version ?? takeover.body.ownership.version);
    const back = await sendText(ctx, publicId, "Thanks, no routine", { taskId, contextId }, extension).expect(200);
    expect(back.body.result.task).toMatchObject({
      id: taskId,
      status: { state: "TASK_STATE_COMPLETED", message: { parts: [{ text: "agent:Thanks, no routine" }] } },
      metadata: { [A2A_CONVERSE_EXTENSION_URI]: { reason: "handed_back" } },
    });
  });

  it("continues the task another instance opened when the unique index refuses a second open task", async () => {
    const { stores, repository, hooks } = postgresStores();
    const ctx = createA2aTestApp({ stores });
    const { session, agent, publicId } = await openA2aAgent(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(session.workspaceId, agent.id, supportIntakeDraft());
    const opened = await sendText(ctx, publicId, "Hello, no routine").expect(200);
    const contextId = opened.body.result.message.contextId as string;
    const conversationId = await conversationIdForContext(ctx, contextId);
    const siblingId = randomBytes(16).toString("base64url");
    // Between this turn's look for an open task and its insert, another instance opens one.
    hooks.beforeInsert = async (write) => {
      await repository.commit({
        updates: [],
        insert: {
          ...(write.insert ?? (() => { throw new Error("expected an insert"); })()),
          id: siblingId,
          routineExecutionId: null,
          openingMessageId: null,
          state: "working",
          reason: "human_owned",
          humanStretch: false,
        },
      });
    };

    const started = await sendText(ctx, publicId, "I need support intake", { contextId }).expect(200);

    expect(started.body.result.task).toMatchObject({ id: siblingId, contextId, status: { state: "TASK_STATE_INPUT_REQUIRED" } });
    expect(await repository.findById(siblingId)).toMatchObject({ state: "input_required", reason: "awaiting_input", routineExecutionId: expect.any(String), version: 2 });
    expect(await openTaskCount(conversationId)).toBe(1);
  });
});
