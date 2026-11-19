import { randomUUID } from "node:crypto";

import type { ConversationRoutineStore, Routine, RoutineState, SkillInvocation } from "@radioso/conversation-contract";
import { afterAll, expect, it, vi } from "vitest";

import { createPostgresConversationErasureUnitOfWork } from "../../src/app/composition/conversationErasure.js";
import { buildWorkspaceEventLog, withWorkspaceEvents } from "../../src/app/composition/workspaceEventLog.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ConversationActivityRepository } from "../../src/db/repositories/conversationActivityRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { PendingDecisionRepository, type PendingDecisionCreateInput } from "../../src/db/repositories/pendingDecisionRepository.js";
import {
  postgresWorkspaceEventRecorder,
  WorkspaceEventLogRetention,
  WorkspaceEventValueWithholder,
} from "../../src/db/repositories/workspaceEventLogRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { ContactRequestRecordingOutbox } from "../../src/modules/chat/infra/contactRequestRecordingOutbox.js";
import { PostgresAssistantTurnPersistence } from "../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import { DeferredRoutineStore } from "../../src/modules/chat/services/routines/deferredRoutineStore.js";
import { NotifyExecutor } from "../../src/modules/notify/notifyExecutor.js";
import { ConversationErasureService } from "../../src/modules/privacy/public.js";
import { matchableValueTexts } from "../../src/shared/domain/sensitiveTranscript.js";
import {
  WORKSPACE_EVENT_TYPES,
  WORKSPACE_EVENT_VERSIONS,
  workspaceEventDataSchema,
  type WorkspaceEvent,
  type WorkspaceEventDraft,
  type WorkspaceEventType,
} from "../../src/shared/domain/workspaceEventLog.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("workspace event log (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const recorder = postgresWorkspaceEventRecorder;
  const conversations = new ConversationRepository(database.kysely, recorder);
  const log = buildWorkspaceEventLog(database.kysely, null);
  const persistence = new PostgresAssistantTurnPersistence(
    database.kysely,
    withWorkspaceEvents(new ConversationActivityRepository(database.kysely)),
    recorder,
    60_000,
  );
  const seededAccountIds: string[] = [];

  afterAll(async () => {
    if (seededAccountIds.length > 0) {
      await database.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [seededAccountIds]);
    }
    await database.close().catch(() => undefined);
  });

  const seedWorkspace = async (): Promise<{ workspaceId: string; agentId: string }> => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Events",
      email: `events-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Events Workspace");
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Front desk')", [agentId, workspace.id]);
    return { workspaceId: workspace.id, agentId };
  };

  const seedVisitor = async (workspaceId: string): Promise<string> => {
    const [visitor] = await database.query<{ id: string }>(
      "INSERT INTO visitors (workspace_id, visitor_key, conversation_count) VALUES ($1, $2, 0) RETURNING id",
      [workspaceId, `visitor-${randomUUID()}`],
    );
    return visitor.id;
  };

  /**
   * Waits until every transaction that had begun has finished, so the horizon is past what this
   * file wrote even when another session on a shared Postgres holds one open for a moment.
   */
  const settle = async (): Promise<void> => {
    const [{ xmax }] = await database.query<{ xmax: string }>("SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS xmax");
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const [{ passed }] = await database.query<{ passed: boolean }>(
        "SELECT pg_snapshot_xmin(pg_current_snapshot()) >= $1::xid8 AS passed",
        [xmax],
      );
      if (passed) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("The snapshot horizon never passed this file's writes");
  };

  /** Every served event must parse as its type's published schema and version. */
  const conforming = (events: readonly WorkspaceEvent[]): WorkspaceEvent[] => {
    for (const event of events) {
      expect(event.version).toBe(WORKSPACE_EVENT_VERSIONS[event.type]);
      workspaceEventDataSchema(event.type).strict().parse(event.data);
    }
    return [...events];
  };

  const eventsOf = async (
    workspaceId: string,
    after: string | null = null,
    options: { types?: WorkspaceEventType[]; limit?: number; waitForHorizon?: boolean } = {},
  ) => {
    if (options.waitForHorizon !== false) await settle();
    const page = await log.list({
      workspaceId,
      readableTypes: [...WORKSPACE_EVENT_TYPES],
      requestedTypes: options.types ?? null,
      after,
      limit: options.limit ?? 100,
    });
    return { ...page, events: conforming(page.events) };
  };

  const turn = (workspaceId: string, conversationId: string) => ({
    workspaceId,
    conversationId,
    assistantMessage: {
      id: randomUUID(),
      conversationId,
      workspaceId,
      role: "assistant" as const,
      content: "Done.",
    },
    auditEvent: { eventType: "chat.answer", eventStatus: "success" as const, workspaceId, metadata: {} },
  });

  const handoff = (workspaceId: string, conversationId: string): WorkspaceEventDraft => ({
    type: "handoff.requested",
    workspaceId,
    conversationId,
    detail: { reason: "routine_handoff" },
  });

  const booking: Routine = {
    id: "booking",
    rootStepId: "ask_name",
    steps: [],
    transitions: [],
    slots: [
      { id: "slot-name", key: "name", type: "text", required: true },
      { id: "slot-phone", key: "phone", type: "text", required: true, sensitivity: "sensitive" },
    ],
  };

  const capturedSave = async (state: RoutineState) => {
    const inner: ConversationRoutineStore = { loadActive: async () => null, save: async () => {}, clear: async () => {} };
    const store = new DeferredRoutineStore(inner, undefined, [booking]);
    await store.save(state);
    return store.getTransition();
  };

  const decisionFor = (scope: { workspaceId: string; agentId: string; conversationId: string }, stepId: string): PendingDecisionCreateInput => ({
    handle: `pd_${randomUUID()}`,
    conversationId: scope.conversationId,
    sessionId: scope.conversationId,
    workspaceId: scope.workspaceId,
    agentId: scope.agentId,
    routineId: "booking",
    stepId,
    reason: "Bookings for more than eight need a teammate",
    options: [{ id: "approve", label: "Approve", payload: { tables: 2 } }, { id: "decline", label: "Decline" }],
    deciderScope: {},
    contentHash: `hash-${stepId}`,
    deadline: null,
  });

  it("records a conversation's start once, with the conversation's own fields", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const visitorId = await seedVisitor(workspaceId);

    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed", visitorId });
    await conversations.createIfAbsent({ id: conversation.id, workspaceId, agentId, sourceChannel: "website_embed" });

    expect((await eventsOf(workspaceId)).events).toEqual([
      expect.objectContaining({
        type: "conversation.started",
        workspaceId,
        data: { conversationId: conversation.id, agentId, channel: "website_embed", callerKind: "human", visitorId },
      }),
    ]);
  });

  it("records the start of a calling agent's conversation once, however many of its turns ask for it", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const session = { workspaceId, agentId, sourceChannel: "mcp", anonymousSessionId: `session-${randomUUID()}` };

    const first = await conversations.getOrCreateByAnonymousSession(session);
    const again = await conversations.getOrCreateByAnonymousSession(session);

    expect([first.created, again.created]).toEqual([true, false]);
    expect((await eventsOf(workspaceId)).events).toEqual([
      expect.objectContaining({ type: "conversation.started", data: expect.objectContaining({ conversationId: first.record.id, callerKind: "agent" }) }),
    ]);
  });

  it("records nothing for operator testing, which history's lists leave out too", async () => {
    const { workspaceId, agentId } = await seedWorkspace();

    await conversations.create({ workspaceId, agentId, sourceChannel: "authenticated_chat" });
    await conversations.create({ workspaceId, agentId, sourceChannel: "workbench_replay", purpose: "operator_test" });

    expect((await eventsOf(workspaceId)).events).toEqual([]);
  });

  it("records a routine's completion once, with its sensitive slots masked", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const start = await eventsOf(workspaceId);
    const ended: RoutineState = {
      sessionId: conversation.id,
      routineId: "booking",
      executionId: randomUUID(),
      path: ["ask_name", "ask_phone", "done"],
      variables: { name: "Ada Lovelace", phone: "+44 20 7946 0000", internalScore: 7 },
      status: "completed",
      metadata: { terminalKind: "complete", terminalStepId: "done" },
    };

    const committed = { ...turn(workspaceId, conversation.id), routineStateTransition: await capturedSave(ended) };
    await persistence.completeAssistantTurn(committed);
    // A retried turn writes the same run with the same values again.
    await persistence.completeAssistantTurn({ ...committed, assistantMessage: { ...committed.assistantMessage, id: randomUUID() } });

    expect((await eventsOf(workspaceId, start.nextCursor)).events).toEqual([
      expect.objectContaining({
        type: "routine.completed",
        data: {
          conversationId: conversation.id,
          agentId,
          channel: "website_embed",
          callerKind: "human",
          visitorId: null,
          routineId: "booking",
          executionId: ended.executionId,
          outcome: "complete",
          values: { name: "Ada Lovelace", phone: "[redacted]" },
          sensitiveSlotKeys: ["phone"],
        },
      }),
    ]);
  });

  it("records what a decision's resolution commits: the ended run, and the next decision it waits on", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const scope = { workspaceId, agentId, conversationId: conversation.id };
    const parked = decisionFor(scope, "approve_size");
    await persistence.completeAssistantTurn({ ...turn(workspaceId, conversation.id), pendingDecisionTransition: parked });
    const start = await eventsOf(workspaceId);
    const chained = decisionFor(scope, "approve_deposit");
    const resumed: RoutineState = {
      sessionId: conversation.id,
      routineId: "booking",
      executionId: randomUUID(),
      path: ["ask_name", "approve_size", "done"],
      variables: { name: "Grace", phone: "+44 20 7946 0001" },
      status: "completed",
      metadata: { terminalKind: "complete", terminalStepId: "done" },
    };

    const decisions = new PendingDecisionRepository(database.kysely);
    await decisions.claimInTransaction({ handle: parked.handle, contentHash: parked.contentHash }, async (_record, trx) => {
      await decisions.resolve(
        { handle: parked.handle, status: "resolved", decision: { optionId: "approve" }, decidedBy: null, contentHash: parked.contentHash },
        trx,
      );
      return persistence.completeAssistantTurn({
        ...turn(workspaceId, conversation.id),
        transaction: trx,
        routineStateTransition: await capturedSave(resumed),
        pendingDecisionTransition: chained,
      });
    });

    expect((await eventsOf(workspaceId, start.nextCursor)).events.map((event) => [event.type, event.data])).toEqual([
      ["decision.pending", expect.objectContaining({ decisionHandle: chained.handle, stepId: "approve_deposit" })],
      ["routine.completed", expect.objectContaining({ executionId: resumed.executionId, values: { name: "Grace", phone: "[redacted]" } })],
    ]);
  });

  it("records a turn's contact request with its routine's slots only, and a notify step's with its sensitive input masked", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const start = await eventsOf(workspaceId);
    const queued = {
      ...turn(workspaceId, conversation.id),
      actions: [{ type: "contact.send", payload: { name: "Ada", phone: "[redacted]", lookupResult: { tier: "gold" } } }],
      routineStateTransition: await capturedSave({ sessionId: conversation.id, routineId: "booking", path: ["send"], variables: {}, status: "active" }),
    };

    await persistence.completeAssistantTurn(queued);
    // The retried turn's action is already queued, so nothing new is recorded.
    await persistence.completeAssistantTurn({ ...queued, assistantMessage: { ...queued.assistantMessage, id: randomUUID() } });
    // A notify step whose message input is bound to a sensitive slot: the skill gets the value, the log does not.
    const outbox = new ContactRequestRecordingOutbox(database.kysely, recorder);
    const enqueue = vi.spyOn(outbox, "enqueue");
    const notify = new NotifyExecutor({
      skills: { findByName: async () => ({ kind: "notify", enabled: true, skillName: "front_desk" }) as never },
      outbox,
    });
    await notify.dispatch({
      skill: { name: "front_desk" },
      collected: { message: "My knee is still swollen", email: "grace@example.com" },
      context: { workspaceId, agentId, conversationId: conversation.id, sensitiveInputKeys: ["message"] },
      emit: { emit: () => undefined },
    } as unknown as SkillInvocation);

    expect(enqueue.mock.calls[0]?.[0].payload).toEqual({ message: "My knee is still swollen", email: "grace@example.com" });
    const page = await eventsOf(workspaceId, start.nextCursor);
    const requestIds = await database.query<{ id: string }>(
      "SELECT id FROM routine_action_requests WHERE conversation_id = $1 AND type = 'contact.send' ORDER BY created_at",
      [conversation.id],
    );
    expect(page.events.map((event) => [event.type, event.data.contactRequestId, event.data.values])).toEqual([
      ["contact_request.created", requestIds[0].id, { name: "Ada", phone: "[redacted]" }],
      ["contact_request.created", requestIds[1].id, { message: "[redacted]", email: "grace@example.com" }],
    ]);
  });

  it("records the handoff a turn requests and the decision its routine waits on", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const start = await eventsOf(workspaceId);

    await persistence.completeAssistantTurn({
      ...turn(workspaceId, conversation.id),
      pendingDecisionTransition: decisionFor({ workspaceId, agentId, conversationId: conversation.id }, "approve_size"),
    });
    await persistence.completeAssistantTurn({ ...turn(workspaceId, conversation.id), ownershipHandoff: { reason: "routine_handoff" } });

    expect((await eventsOf(workspaceId, start.nextCursor)).events.map((event) => [event.type, event.data])).toEqual([
      ["decision.pending", expect.objectContaining({
        routineId: "booking",
        stepId: "approve_size",
        reason: "Bookings for more than eight need a teammate",
        options: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }],
        deadline: null,
      })],
      ["handoff.requested", expect.objectContaining({ conversationId: conversation.id, reason: "routine_handoff" })],
    ]);
  });

  it("orders by transaction, holding a later transaction's event back while an earlier one is still open", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const slowConversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const fastConversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const start = await eventsOf(workspaceId);

    const signal = () => {
      let done!: () => void;
      const reached = new Promise<void>((resolve) => { done = resolve; });
      return { done, reached };
    };
    const slowHasXid = signal();
    const fastCommitted = signal();
    const slowRecorded = signal();
    const slowMayCommit = signal();
    // The slow transaction takes its transaction id first, then writes after the fast one has
    // committed: its id is the smaller and its position the larger.
    const slow = database.kysely.transaction().execute(async (trx) => {
      await trx.selectNoFrom((eb) => eb.fn<string>("pg_current_xact_id", []).as("xid")).execute();
      slowHasXid.done();
      await fastCommitted.reached;
      await recorder.record(trx, handoff(workspaceId, slowConversation.id));
      slowRecorded.done();
      await slowMayCommit.reached;
    });
    await slowHasXid.reached;
    await database.kysely.transaction().execute((trx) => recorder.record(trx, handoff(workspaceId, fastConversation.id)));
    fastCommitted.done();
    await slowRecorded.reached;

    const whileSlowIsOpen = await eventsOf(workspaceId, start.nextCursor, { waitForHorizon: false });
    expect(whileSlowIsOpen.events).toEqual([]);

    slowMayCommit.done();
    await slow;
    const afterCommit = await eventsOf(workspaceId, whileSlowIsOpen.nextCursor);
    expect(afterCommit.events.map((event) => event.data.conversationId)).toEqual([slowConversation.id, fastConversation.id]);
    expect((await eventsOf(workspaceId, afterCommit.nextCursor)).events).toEqual([]);
  });

  it("pages one transaction's events across a page boundary without losing one", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const start = await eventsOf(workspaceId);
    await database.kysely.transaction().execute(async (trx) => {
      for (let index = 0; index < 3; index += 1) await recorder.record(trx, handoff(workspaceId, conversation.id));
    });

    const first = await eventsOf(workspaceId, start.nextCursor, { limit: 2 });
    const second = await eventsOf(workspaceId, first.nextCursor, { limit: 2 });

    expect([first.events.length, first.hasMore, second.events.length, second.hasMore]).toEqual([2, true, 1, false]);
    const ids = [...first.events, ...second.events].map((event) => event.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("moves a narrow filter's cursor to the horizon on a short page, then serves the next event of its type", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const handoffs = await eventsOf(workspaceId, null, { types: ["handoff.requested"] });
    await database.kysely.transaction().execute((trx) => recorder.record(trx, {
      type: "contact_request.created",
      workspaceId,
      conversationId: conversation.id,
      detail: { contactRequestId: randomUUID(), values: { email: "ada@example.com" } },
    }));

    const quiet = await eventsOf(workspaceId, handoffs.nextCursor, { types: ["handoff.requested"] });
    expect(quiet.events).toEqual([]);
    expect(quiet.nextCursor).not.toBe(handoffs.nextCursor);

    await database.kysely.transaction().execute((trx) => recorder.record(trx, handoff(workspaceId, conversation.id)));
    const next = await eventsOf(workspaceId, quiet.nextCursor, { types: ["handoff.requested"] });
    expect(next.events.map((event) => event.type)).toEqual(["handoff.requested"]);
  });

  it("removes a visitor's events with the visitor, and leaves other visitors' alone", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const erased = await seedVisitor(workspaceId);
    const kept = await seedVisitor(workspaceId);
    await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed", visitorId: erased });
    const keptConversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed", visitorId: kept });
    const erasure = new ConversationErasureService({
      unitOfWork: createPostgresConversationErasureUnitOfWork({ db: database.kysely, logger: { warn: vi.fn() } }),
      invalidation: { enqueue: vi.fn() },
      auditLog: {},
    });

    await erasure.eraseVisitor({ workspaceId, visitorId: erased, actor: { accountId: seededAccountIds.at(-1)!, userId: null } });

    expect((await eventsOf(workspaceId)).events.map((event) => event.data.conversationId)).toEqual([keptConversation.id]);
  });

  it("removes events past the retention window, and a withdrawn consent's values", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    await database.kysely.transaction().execute((trx) => recorder.record(trx, {
      type: "contact_request.created",
      workspaceId,
      conversationId: conversation.id,
      detail: { contactRequestId: randomUUID(), values: { name: "Ada Lovelace" } },
    }));

    const withheld = await new WorkspaceEventValueWithholder(database.kysely).withhold({
      workspaceId,
      conversationId: conversation.id,
      messageIds: [],
      valueTexts: matchableValueTexts(["Ada Lovelace"]),
      withdrawnRoutineSlots: [],
    });
    expect(withheld).toBe(1);
    expect((await eventsOf(workspaceId)).events.map((event) => event.type)).toEqual(["conversation.started"]);

    const thirtyOneDaysOn = new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000);
    let removed = 0;
    for (let batch = await new WorkspaceEventLogRetention(database.kysely).enforce({ now: thirtyOneDaysOn, limit: 500 }); batch > 0;
      batch = await new WorkspaceEventLogRetention(database.kysely).enforce({ now: thirtyOneDaysOn, limit: 500 })) {
      removed += batch;
    }
    expect(removed).toBeGreaterThan(0);
    expect((await eventsOf(workspaceId)).events).toEqual([]);
  });
});
