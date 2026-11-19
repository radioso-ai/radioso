import { randomUUID } from "node:crypto";

import type { ConversationRoutineStore, Routine, RoutineState, TurnContext } from "@radioso/conversation-contract";
import { DefaultRoutineRunner, resumeAwaitingDecision } from "@radioso/conversation-engine";
import { sql } from "kysely";
import { afterAll, expect, it } from "vitest";

import { buildWorkspaceEventLog, withWorkspaceEvents } from "../../../src/app/composition/workspaceEventLog.js";
import { AccountRepository } from "../../../src/db/repositories/accountRepository.js";
import { ConversationActivityRepository } from "../../../src/db/repositories/conversationActivityRepository.js";
import { ConversationRepository } from "../../../src/db/repositories/conversationRepository.js";
import {
  PendingDecisionRepository,
  type PendingDecisionRecord,
} from "../../../src/db/repositories/pendingDecisionRepository.js";
import { postgresWorkspaceEventRecorder } from "../../../src/db/repositories/workspaceEventLogRepository.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaceRepository.js";
import { ApprovalDecisionService, type ResumeRunner } from "../../../src/modules/approvals/public.js";
import { PostgresAssistantTurnPersistence } from "../../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import { DeferredRoutineStore } from "../../../src/modules/chat/services/routines/deferredRoutineStore.js";
import { WORKSPACE_EVENT_TYPES } from "../../../src/shared/domain/workspaceEventLog.js";
import { Database } from "../../../src/shared/infra/database.js";
import type { Db } from "../../../src/shared/infra/kysely/types.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/**
 * The workspace event log serves an event only once every transaction older than it has ended
 * (spec 957 §6), so a decision's resolution must not hold a transaction id while its resumed
 * routine waits on a model or a skill.
 */
describeIntegration("resolving a decision while its resumed routine waits on the model", () => {
  const database = new Database(integrationDatabaseUrl);
  const recorder = postgresWorkspaceEventRecorder;
  const conversations = new ConversationRepository(database.kysely, recorder);
  const log = buildWorkspaceEventLog(database.kysely, null);
  const activity = withWorkspaceEvents(new ConversationActivityRepository(database.kysely));
  const persistence = new PostgresAssistantTurnPersistence(database.kysely, activity, recorder, 60_000);
  const pendingDecisions = new PendingDecisionRepository(database.kysely);
  const seededAccountIds: string[] = [];

  afterAll(async () => {
    if (seededAccountIds.length > 0) {
      await database.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [seededAccountIds]);
    }
    await database.close().catch(() => undefined);
  });

  const seedWorkspace = async (): Promise<{ accountId: string; workspaceId: string; agentId: string }> => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Front desk team",
      email: `decisions-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Bookings");
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Front desk')", [agentId, workspace.id]);
    return { accountId: account.id, workspaceId: workspace.id, agentId };
  };

  // A booking for a large party waits on a teammate, then confirms.
  const booking: Routine = {
    id: "booking",
    rootStepId: "approve_size",
    steps: [
      {
        id: "approve_size",
        kind: "await",
        decision: { captureKey: "size_decision", options: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }] },
      },
      { id: "confirmed", kind: "terminal", action: "Confirm the booking." },
    ],
    transitions: [
      {
        from: "approve_size",
        to: "confirmed",
        condition: "approved",
        guard: { kind: "field", ref: "size_decision.id", op: "equals", value: "approve" },
      },
    ],
    slots: [
      { id: "slot-name", key: "name", type: "text", required: true },
      { id: "slot-phone", key: "phone", type: "text", required: true, sensitivity: "sensitive" },
    ],
  };

  const parkBooking = async (): Promise<{
    accountId: string;
    workspaceId: string;
    record: PendingDecisionRecord;
    parked: RoutineState;
  }> => {
    const { accountId, workspaceId, agentId } = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const record = await pendingDecisions.create({
      handle: `pd_${randomUUID()}`,
      conversationId: conversation.id,
      sessionId: conversation.id,
      workspaceId,
      agentId,
      routineId: booking.id,
      stepId: "approve_size",
      reason: "Bookings for more than eight need a teammate",
      options: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }],
      deciderScope: {},
      contentHash: "hash-approve-size",
      deadline: null,
    });
    const parked: RoutineState = {
      sessionId: conversation.id,
      routineId: booking.id,
      executionId: randomUUID(),
      path: ["approve_size"],
      variables: { name: "Grace", phone: "+44 20 7946 0001" },
      status: "suspended",
    };
    return { accountId, workspaceId, record, parked };
  };

  /** A model call the test holds open until it lets it answer. */
  const heldModelCall = () => {
    let release!: () => void;
    let markStarted!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let calls = 0;
    return {
      started,
      release,
      calls: () => calls,
      render: async () => {
        calls += 1;
        markStarted();
        await released;
        return { answer: "Your table for ten is booked." };
      },
    };
  };

  const capturedSave = async (state: RoutineState) => {
    const inner: ConversationRoutineStore = { loadActive: async () => null, save: async () => {}, clear: async () => {} };
    const store = new DeferredRoutineStore(inner, undefined, [booking]);
    await store.save(state);
    return store.getTransition();
  };

  /**
   * The resumed turn as the chat module runs it: the routine walks on from the decision and renders
   * its reply with the model, then the decision's resolution and the turn are written in the
   * decision's transaction.
   */
  const resumedBooking = (
    parked: RoutineState,
    model: ReturnType<typeof heldModelCall>,
    seen: { transaction?: Db } = {},
  ): ResumeRunner => ({
    resume: async ({ record, optionId, transaction, writeResolution }) => {
      seen.transaction = transaction;
      const turn: TurnContext = {
        agent: { id: record.agentId, name: "Front desk" },
        sessionId: record.sessionId,
        inputEvent: { id: "message-before-approval", kind: "message", content: "A table for ten tonight, please." },
        history: [],
        stagedContext: [],
        steering: [],
      };
      const result = await resumeAwaitingDecision({
        suspendedReader: { loadSuspended: async () => parked },
        routineRunner: new DefaultRoutineRunner(
          [booking],
          { select: async () => { throw new Error("selector_not_expected"); } },
          { render: model.render },
        ),
        turn,
        sessionId: record.sessionId,
        decision: { handle: record.handle, optionId },
      });
      if (!result.completedState) {
        throw new Error("booking_did_not_end");
      }
      await writeResolution();
      const committed = await persistence.completeAssistantTurn({
        workspaceId: record.workspaceId,
        conversationId: record.conversationId,
        assistantMessage: {
          id: randomUUID(),
          conversationId: record.conversationId,
          workspaceId: record.workspaceId,
          role: "assistant",
          content: result.response.answer,
        },
        auditEvent: { eventType: "chat.answer", eventStatus: "success", workspaceId: record.workspaceId, metadata: {} },
        routineStateTransition: await capturedSave(result.completedState),
        transaction,
      });
      return {
        conversationId: record.conversationId,
        resumed: true,
        assistantMessageId: committed.message.id,
        postCommitReceipt: { workspaceId: record.workspaceId, changeKinds: ["conversation.turn_committed"] },
      };
    },
  });

  const listEvents = (workspaceId: string) => log.list({
    workspaceId,
    readableTypes: [...WORKSPACE_EVENT_TYPES],
    requestedTypes: null,
    after: null,
    limit: 100,
  });

  /** Polls the log until `workspaceId` serves an event, failing if it never does in `withinMs`. */
  const servedEventsOf = async (workspaceId: string, withinMs = 5_000) => {
    const deadline = Date.now() + withinMs;
    for (;;) {
      const page = await listEvents(workspaceId);
      if (page.events.length > 0 || Date.now() > deadline) return page.events;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const decisionStatus = async (handle: string): Promise<string | undefined> =>
    (await database.query<{ status: string }>("SELECT status FROM pending_decisions WHERE handle = $1", [handle]))[0]?.status;

  const assistantReplies = async (conversationId: string): Promise<string[]> =>
    (await database.query<{ content: string }>(
      "SELECT content FROM messages WHERE conversation_id = $1 AND role = 'assistant' ORDER BY created_at",
      [conversationId],
    )).map((row) => row.content);

  it("serves another workspace's events while the resumed routine waits on the model, then commits the decision, its events and its reply together", async () => {
    const { accountId, workspaceId, record, parked } = await parkBooking();
    const model = heldModelCall();
    const seen: { transaction?: Db } = {};
    const service = new ApprovalDecisionService(pendingDecisions, resumedBooking(parked, model, seen), activity);
    const before = await servedEventsOf(workspaceId);

    const resolving = service.resolve({
      agentId: record.agentId,
      handle: record.handle,
      optionId: "approve",
      contentHash: record.contentHash,
      caller: { accountId, workspaceId },
    }).then((result) => result, (error: unknown) => error);
    try {
      await model.started;

      // The decision's transaction is open and holds no transaction id.
      const [{ xid }] = (await sql<{ xid: string | null }>`SELECT pg_current_xact_id_if_assigned()::text AS xid`
        .execute(seen.transaction!)).rows;
      expect(xid).toBeNull();
      // Another workspace's conversation starts and commits; the log serves it without waiting on the decision.
      const other = await seedWorkspace();
      const started = await conversations.create({ workspaceId: other.workspaceId, agentId: other.agentId, sourceChannel: "website_embed" });
      expect(await servedEventsOf(other.workspaceId)).toEqual([
        expect.objectContaining({ type: "conversation.started", data: expect.objectContaining({ conversationId: started.id }) }),
      ]);
      // Nothing of the decision's outcome is visible yet.
      expect(await decisionStatus(record.handle)).toBe("pending");
      expect(await assistantReplies(record.conversationId)).toEqual([]);
    } finally {
      model.release();
    }
    await expect(resolving).resolves.toMatchObject({ status: "resolved", optionId: "approve", resumed: true });

    expect(await decisionStatus(record.handle)).toBe("resolved");
    expect(await assistantReplies(record.conversationId)).toEqual(["Your table for ten is booked."]);
    const after = await servedEventsOf(workspaceId);
    expect(after.slice(before.length)).toEqual([
      expect.objectContaining({ type: "routine.completed", data: expect.objectContaining({ executionId: parked.executionId }) }),
    ]);
    // Who decided is recorded in the same transaction, dated before the reply it led to.
    const [decided] = await database.query<{ decided_before_reply: boolean }>(
      `SELECT a.created_at < m.created_at AS decided_before_reply
         FROM conversation_activity a
         JOIN messages m ON m.conversation_id = a.conversation_id AND m.role = 'assistant'
        WHERE a.conversation_id = $1 AND a.kind = 'approval_decided'`,
      [record.conversationId],
    );
    expect(decided).toEqual({ decided_before_reply: true });
  });

  it("lets one of two teammates deciding the same booking at once resolve it; the other is told it was already decided", async () => {
    const { accountId, workspaceId, record, parked } = await parkBooking();
    const model = heldModelCall();
    const service = new ApprovalDecisionService(pendingDecisions, resumedBooking(parked, model), activity);
    const decide = (optionId: string) => service.resolve({
      agentId: record.agentId,
      handle: record.handle,
      optionId,
      contentHash: record.contentHash,
      caller: { accountId, workspaceId },
    });

    const settled = (pending: Promise<unknown>) => pending.then((result) => result, (error: unknown) => error);

    const first = settled(decide("approve"));
    let second: Promise<unknown> | undefined;
    try {
      await model.started;
      second = settled(decide("decline"));
      // The second waits on the first's claim rather than resuming the routine alongside it.
      await expect.poll(async () => (await database.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
      ))[0].waiting, { timeout: 5_000 }).toBeGreaterThan(0);
    } finally {
      model.release();
    }

    await expect(first).resolves.toMatchObject({ status: "resolved", optionId: "approve" });
    await expect(second).resolves.toMatchObject({ reason: "concurrent_resolution" });
    expect(model.calls()).toBe(1);
    expect(await decisionStatus(record.handle)).toBe("resolved");
    expect(await assistantReplies(record.conversationId)).toEqual(["Your table for ten is booked."]);
  });
});
