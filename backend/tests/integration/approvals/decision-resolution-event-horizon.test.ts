import { randomUUID } from "node:crypto";

import type {
  ConversationEngine,
  ConversationRoutineStore,
  Routine,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import { DefaultRoutineRunner, resumeAwaitingDecision } from "@radioso/conversation-engine";
import { afterAll, expect, it, vi } from "vitest";

import { createPostgresConversationErasureUnitOfWork } from "../../../src/app/composition/conversationErasure.js";
import { buildWorkspaceEventLog, withWorkspaceEvents } from "../../../src/app/composition/workspaceEventLog.js";
import { AccountRepository } from "../../../src/db/repositories/accountRepository.js";
import { ApprovalResumeEffectJournalRepository } from "../../../src/db/repositories/approvalResumeEffectJournalRepository.js";
import { ConversationActivityRepository } from "../../../src/db/repositories/conversationActivityRepository.js";
import { ConversationRepository } from "../../../src/db/repositories/conversationRepository.js";
import { MessageRepository } from "../../../src/db/repositories/messageRepository.js";
import { PendingDecisionRepository, type PendingDecisionRecord } from "../../../src/db/repositories/pendingDecisionRepository.js";
import { postgresWorkspaceEventRecorder } from "../../../src/db/repositories/workspaceEventLogRepository.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaceRepository.js";
import { ApprovalDecisionService, type ResumeRunner } from "../../../src/modules/approvals/public.js";
import type { AuditService } from "../../../src/modules/audit/contracts/index.js";
import { PostgresAssistantTurnPersistence } from "../../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import { ApprovalResumeTurn } from "../../../src/modules/chat/services/approvalResumeTurn.js";
import type { ChatAnswerPresenter } from "../../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatTurnLifecycle } from "../../../src/modules/chat/services/chatTurnLifecycle.js";
import { InMemoryConversationTurnRegistry } from "../../../src/modules/chat/services/conversationTurnRegistry.js";
import { DeferredRoutineStore } from "../../../src/modules/chat/services/routines/deferredRoutineStore.js";
import { ConversationErasureService } from "../../../src/modules/privacy/public.js";
import { ApprovalResumeEffectJournalDispatcher } from "../../../src/modules/routines/approvalResumeEffectJournal.js";
import { RoutineSkillExecutorDispatcher } from "../../../src/modules/routines/skillDispatcher.js";
import type { ProductAnalyticsPort } from "../../../src/shared/analytics/productAnalyticsService.js";
import { WORKSPACE_EVENT_TYPES } from "../../../src/shared/domain/workspaceEventLog.js";
import { Database } from "../../../src/shared/infra/database.js";
import { InMemoryAgentRepository } from "../../support/fakes.js";
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
  const messages = new MessageRepository(database.kysely);
  const log = buildWorkspaceEventLog(database.kysely, null);
  const activity = withWorkspaceEvents(new ConversationActivityRepository(database.kysely));
  const actionDrain = { requestDrain: vi.fn(async () => undefined) };
  const persistence = new PostgresAssistantTurnPersistence(database.kysely, activity, recorder, 60_000, undefined, actionDrain);
  const pendingDecisions = new PendingDecisionRepository(database.kysely);
  const journal = new ApprovalResumeEffectJournalRepository(database.kysely);
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

  const approveOrDecline = [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }];
  const approved = { kind: "field" as const, ref: "decision.id", op: "equals" as const, value: "approve" };
  const slots: Routine["slots"] = [
    { id: "slot-name", key: "name", type: "text", required: true },
    { id: "slot-phone", key: "phone", type: "text", required: true, sensitivity: "sensitive" },
  ];

  // A booking for a large party waits on a teammate, then confirms.
  const booking: Routine = {
    id: "booking",
    rootStepId: "approve_size",
    steps: [
      { id: "approve_size", kind: "await", decision: { captureKey: "decision", options: approveOrDecline } },
      { id: "confirmed", kind: "terminal", action: "Confirm the booking." },
    ],
    transitions: [{ from: "approve_size", to: "confirmed", condition: "approved", guard: approved }],
    slots,
  };

  // A refund waits on a teammate, is issued through a webhook, then confirmed. It is parked under the
  // booking's id, so the same pending decision resumes it.
  const refund: Routine = {
    id: "booking",
    rootStepId: "approve_size",
    steps: [
      { id: "approve_size", kind: "await", decision: { captureKey: "decision", options: approveOrDecline } },
      { id: "issue_refund", kind: "skill", skillName: "refund.issue" },
      { id: "confirmed", kind: "terminal", action: "Confirm the refund." },
    ],
    transitions: [
      { from: "approve_size", to: "issue_refund", condition: "approved", guard: approved },
      { from: "issue_refund", to: "confirmed", condition: "issued", guard: { kind: "default" } },
    ],
    slots,
  };

  const parkBooking = async (): Promise<{
    accountId: string;
    workspaceId: string;
    record: PendingDecisionRecord;
    parked: RoutineState;
  }> => {
    const { accountId, workspaceId, agentId } = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    await messages.create({ conversationId: conversation.id, workspaceId, role: "user", content: "A table for ten tonight, please." });
    const record = await pendingDecisions.create({
      handle: `pd_${randomUUID()}`,
      conversationId: conversation.id,
      sessionId: conversation.id,
      workspaceId,
      agentId,
      routineId: booking.id,
      stepId: "approve_size",
      reason: "Bookings for more than eight need a teammate",
      options: approveOrDecline,
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
  const heldModelCall = <T,>(answer: T) => {
    let release!: () => void;
    let markStarted!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let calls = 0;
    return {
      started,
      release,
      calls: () => calls,
      call: async (): Promise<T> => {
        calls += 1;
        markStarted();
        await released;
        return answer;
      },
    };
  };

  const noSelector = { select: async () => { throw new Error("selector_not_expected"); } };

  const capturedSave = async (state: RoutineState) => {
    const inner: ConversationRoutineStore = { loadActive: async () => null, save: async () => {}, clear: async () => {} };
    const store = new DeferredRoutineStore(inner, undefined, [booking]);
    await store.save(state);
    return store.getTransition();
  };

  /**
   * The resumed turn as production runs it, from the chat module's `ApprovalResumeTurn` through the
   * turn lifecycle to its Postgres persistence. The response-language detection is the model call
   * the test holds; the routine's reply renders a fixed answer.
   */
  const productionResume = async (input: {
    workspaceId: string;
    agentId: string;
    parked: RoutineState;
    detectResponseLanguage: () => Promise<string | undefined>;
    analytics: ProductAnalyticsPort;
  }): Promise<ResumeRunner> => {
    const agent = { ...(await new InMemoryAgentRepository().create(input.workspaceId, { name: "Front desk" })), id: input.agentId };
    const audit = { record: async () => undefined } as unknown as AuditService;
    return new ApprovalResumeTurn({
      conversationRepository: conversations,
      messageRepository: messages,
      agentService: { resolve: async () => agent },
      chatGateway: { answer: async () => "unused", streamAnswer: async function* () { yield "unused"; } },
      chatAnswerPresenter: {
        presentRoutineAnswer: (answer: string) => ({ answer, skillName: "routine.answer", skillOutcome: "completed", skillStatus: "completed" }),
      } as unknown as ChatAnswerPresenter,
      turnSkills: [],
      conversationEngine: { resumeAwaitingDecision } as unknown as ConversationEngine,
      chatTurnLifecycle: new ChatTurnLifecycle(conversations, messages, audit, input.analytics, undefined, persistence),
      conversationTurnRegistry: new InMemoryConversationTurnRegistry(),
      routineProvider: {
        describeStartable: async () => [],
        forTurn: async () => ({
          routines: [booking],
          activator: { activate: async () => null },
          runner: new DefaultRoutineRunner([booking], noSelector, { render: async () => ({ answer: "Your table for ten is booked." }) }),
        }),
      },
      suspendedRoutineReader: { loadSuspended: async () => input.parked },
      detectResponseLanguage: input.detectResponseLanguage,
    }).asRunner();
  };

  /**
   * A resumed booking the test drives directly: the routine walks on from the decision and renders
   * its reply with `render`, then the turn commits on the decision's transaction.
   */
  const resumedBooking = (
    parked: RoutineState,
    render: () => Promise<{ answer: string }>,
    options: { persistFails?: () => boolean; routine?: Routine; dispatcherFor?: (approvalResume: NonNullable<Parameters<ResumeRunner["resume"]>[0]["approvalResume"]>) => ApprovalResumeEffectJournalDispatcher } = {},
  ): ResumeRunner => ({
    resume: async ({ record, optionId, commit, approvalResume, skillDispatchIdempotencyKey }) => {
      const routine = options.routine ?? booking;
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
          [routine],
          noSelector,
          { render },
          approvalResume && options.dispatcherFor ? options.dispatcherFor(approvalResume) : undefined,
        ),
        turn,
        sessionId: record.sessionId,
        decision: { handle: record.handle, optionId, ...(skillDispatchIdempotencyKey ? { idempotencyKey: skillDispatchIdempotencyKey } : {}) },
      });
      if (!result.completedState) {
        throw new Error("booking_did_not_end");
      }
      const completedState = result.completedState;
      const committed = await commit(async (transaction) => {
        if (options.persistFails?.()) {
          throw new Error("assistant_turn_persist_failed");
        }
        return persistence.completeAssistantTurn({
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
          actions: [{ type: "contact.send", payload: { name: "Grace" } }],
          routineStateTransition: await capturedSave(completedState),
          transaction,
        });
      });
      return {
        conversationId: record.conversationId,
        resumed: true,
        assistantMessageId: committed.message.id,
        postCommitReceipt: { workspaceId: record.workspaceId, changeKinds: ["conversation.turn_committed"] },
        ...(committed.afterCommit ? { postCommitWake: committed.afterCommit } : {}),
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

  /** The backends holding a decision's claim, read from outside their transactions. */
  const claimHolders = async () => database.query<{ xid: string | null; state: string }>(
    `SELECT a.backend_xid::text AS xid, a.state
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.pid <> pg_backend_pid() AND a.datname = current_database()`,
  );

  /** How many resolvers wait on another's claim. */
  const claimWaiters = async (): Promise<number> => (await database.query<{ waiting: number }>(
    `SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND wait_event = 'advisory'
        AND query LIKE 'select pg_advisory_xact_lock%'`,
  ))[0].waiting;

  const decisionStatus = async (handle: string): Promise<string | undefined> =>
    (await database.query<{ status: string }>("SELECT status FROM pending_decisions WHERE handle = $1", [handle]))[0]?.status;

  const assistantReplies = async (conversationId: string): Promise<string[]> =>
    (await database.query<{ content: string }>(
      "SELECT content FROM messages WHERE conversation_id = $1 AND role = 'assistant' ORDER BY created_at",
      [conversationId],
    )).map((row) => row.content);

  const settled = (pending: Promise<unknown>) => pending.then((result) => result, (error: unknown) => error);

  it("serves another workspace's events while the resumed routine waits on the model, then commits the decision, its events and its reply together", async () => {
    const { accountId, workspaceId, record, parked } = await parkBooking();
    const languageDetection = heldModelCall<string | undefined>(undefined);
    const tracked: Array<{ eventName: string; replyCommitted: boolean }> = [];
    const analytics: ProductAnalyticsPort = {
      track: async (event) => {
        tracked.push({ eventName: event.eventName, replyCommitted: (await assistantReplies(record.conversationId)).length > 0 });
        return null;
      },
    };
    const runner = await productionResume({
      workspaceId,
      agentId: record.agentId,
      parked,
      detectResponseLanguage: languageDetection.call,
      analytics,
    });
    const service = new ApprovalDecisionService(pendingDecisions, runner, activity);
    const before = await servedEventsOf(workspaceId);

    const resolving = settled(service.resolve({
      agentId: record.agentId,
      handle: record.handle,
      optionId: "approve",
      contentHash: record.contentHash,
      caller: { accountId, workspaceId },
    }));
    try {
      await languageDetection.started;

      // The decision's transaction is open and holds no transaction id.
      expect(await claimHolders()).toEqual([{ xid: null, state: "idle in transaction" }]);
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
      languageDetection.release();
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
    // The completed turn is reported once the decision's transaction has committed.
    await expect.poll(() => tracked).toEqual([{ eventName: "chat.completed", replyCommitted: true }]);
  });

  it("pushes the resumed turn's outbox drain once the decision's transaction has committed", async () => {
    const { accountId, workspaceId, record, parked } = await parkBooking();
    const decidedWhenDrained: Array<string | undefined> = [];
    actionDrain.requestDrain.mockImplementationOnce(async () => {
      decidedWhenDrained.push(await decisionStatus(record.handle));
    });
    const service = new ApprovalDecisionService(
      pendingDecisions,
      resumedBooking(parked, async () => ({ answer: "Your table for ten is booked." })),
      activity,
    );

    await service.resolve({ agentId: record.agentId, handle: record.handle, optionId: "approve", contentHash: record.contentHash, caller: { accountId, workspaceId } });

    await expect.poll(() => decidedWhenDrained).toEqual(["resolved"]);
  });

  it("lets one of two teammates deciding the same booking at once resolve it; the other is told it was already decided", async () => {
    const { accountId, workspaceId, record, parked } = await parkBooking();
    const model = heldModelCall({ answer: "Your table for ten is booked." });
    const service = new ApprovalDecisionService(pendingDecisions, resumedBooking(parked, model.call), activity);
    const decide = (optionId: string) => service.resolve({
      agentId: record.agentId,
      handle: record.handle,
      optionId,
      contentHash: record.contentHash,
      caller: { accountId, workspaceId },
    });

    const first = settled(decide("approve"));
    let second: Promise<unknown> | undefined;
    try {
      await model.started;
      second = settled(decide("decline"));
      // The second waits on the first's claim rather than resuming the routine alongside it.
      await expect.poll(claimWaiters, { timeout: 5_000 }).toBe(1);
    } finally {
      model.release();
    }

    await expect(first).resolves.toMatchObject({ status: "resolved", optionId: "approve" });
    await expect(second).resolves.toMatchObject({ reason: "concurrent_resolution" });
    expect(model.calls()).toBe(1);
    expect(await decisionStatus(record.handle)).toBe("resolved");
    expect(await assistantReplies(record.conversationId)).toEqual(["Your table for ten is booked."]);
  });

  it("lets the second teammate resolve the booking when the first one's resume fails to commit", async () => {
    const { accountId, workspaceId, record, parked } = await parkBooking();
    const model = heldModelCall({ answer: "Your table for ten is booked." });
    let commits = 0;
    const service = new ApprovalDecisionService(
      pendingDecisions,
      resumedBooking(parked, model.call, { persistFails: () => (commits += 1) === 1 }),
      activity,
    );
    const decide = () => settled(service.resolve({
      agentId: record.agentId,
      handle: record.handle,
      optionId: "approve",
      contentHash: record.contentHash,
      caller: { accountId, workspaceId },
    }));

    const first = decide();
    let second: Promise<unknown> | undefined;
    try {
      await model.started;
      second = decide();
      await expect.poll(claimWaiters, { timeout: 5_000 }).toBe(1);
    } finally {
      model.release();
    }

    await expect(first).resolves.toMatchObject({ message: "assistant_turn_persist_failed" });
    await expect(second).resolves.toMatchObject({ status: "resolved", optionId: "approve" });
    expect(model.calls()).toBe(2);
    expect(await decisionStatus(record.handle)).toBe("resolved");
    expect(await assistantReplies(record.conversationId)).toEqual(["Your table for ten is booked."]);
  });

  it("reports a booking erased while its refund resumes as not found, with no reply and no journal left behind", async () => {
    const { accountId, workspaceId, record, parked } = await parkBooking();
    const model = heldModelCall({ answer: "Your refund is on its way." });
    const receiver = vi.fn(async () => ({ disposition: "settled", outcome: { status: "completed" } }));
    const dispatcherFor = (approvalResume: { pendingDecisionId: string; optionId: string; payloadDigest: string }) =>
      new ApprovalResumeEffectJournalDispatcher(
        new RoutineSkillExecutorDispatcher(
          { resolve: () => ({ name: "refund.issue", owner: "webhook", execution: { kind: "webhook" } } as never) },
          { resolve: () => ({ dispatch: receiver }) } as never,
        ),
        journal,
        approvalResume,
      );
    const service = new ApprovalDecisionService(
      pendingDecisions,
      resumedBooking(parked, model.call, { routine: refund, dispatcherFor }),
      activity,
      undefined,
      undefined,
      undefined,
      journal,
    );
    const erasure = new ConversationErasureService({
      unitOfWork: createPostgresConversationErasureUnitOfWork({ db: database.kysely, logger: { warn: vi.fn() } }),
      invalidation: { enqueue: vi.fn() },
      auditLog: {},
    });

    const resolving = settled(service.resolve({
      agentId: record.agentId,
      handle: record.handle,
      optionId: "approve",
      contentHash: record.contentHash,
      caller: { accountId, workspaceId },
    }));
    try {
      await model.started;
      // The refund went out and is journaled; the visitor's conversation is erased before the reply.
      expect(receiver).toHaveBeenCalledTimes(1);
      await erasure.eraseConversation({ workspaceId, conversationId: record.conversationId, actor: { accountId, userId: null } });
    } finally {
      model.release();
    }

    await expect(resolving).resolves.toMatchObject({ reason: "not_found" });
    expect(receiver).toHaveBeenCalledTimes(1);
    expect(await assistantReplies(record.conversationId)).toEqual([]);
    expect(await database.query("SELECT 1 FROM approval_resume_effect_decisions WHERE pending_decision_id = $1", [record.id])).toEqual([]);
  });

  it("does not claim a decision whose proposal changed since the teammate saw it", async () => {
    const { record } = await parkBooking();
    const onClaimed = vi.fn(async () => "claimed");

    await expect(pendingDecisions.claimInTransaction({ handle: record.handle, contentHash: "hash-changed" }, onClaimed)).resolves.toBeNull();

    expect(onClaimed).not.toHaveBeenCalled();
    expect(await decisionStatus(record.handle)).toBe("pending");
  });
});
