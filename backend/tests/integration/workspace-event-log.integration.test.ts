import { randomUUID } from "node:crypto";

import type { ConversationRoutineStore, Routine, RoutineState } from "@radioso/conversation-contract";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createPostgresConversationErasureUnitOfWork } from "../../src/app/composition/conversationErasure.js";
import { buildWorkspaceEventLog } from "../../src/app/composition/workspaceEvents.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ConversationActivityRepository } from "../../src/db/repositories/conversationActivityRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import {
  postgresWorkspaceEventRecorder,
  WorkspaceEventRetention,
  WorkspaceEventValueWithholder,
} from "../../src/db/repositories/workspaceEventRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { ContactRequestRecordingOutbox } from "../../src/modules/chat/infra/contactRequestRecordingOutbox.js";
import { PostgresAssistantTurnPersistence } from "../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import { DeferredRoutineStore } from "../../src/modules/chat/services/routines/deferredRoutineStore.js";
import { publishingWorkspaceEvents } from "../../src/modules/conversationActivity/public.js";
import { ConversationErasureService } from "../../src/modules/privacy/public.js";
import { matchableValueTexts } from "../../src/shared/domain/sensitiveTranscript.js";
import { WORKSPACE_EVENT_TYPES, type WorkspaceEventDraft } from "../../src/shared/domain/workspaceEvents.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("workspace event log (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const recorder = postgresWorkspaceEventRecorder;
  const conversations = new ConversationRepository(database.kysely, recorder);
  const log = buildWorkspaceEventLog(database.kysely);
  const persistence = new PostgresAssistantTurnPersistence(
    database.kysely,
    publishingWorkspaceEvents(new ConversationActivityRepository(database.kysely), recorder),
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

  beforeAll(async () => {
    await database.query("SELECT 1");
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

  const eventsOf = async (workspaceId: string, after: string | null = null) =>
    log.list({ workspaceId, readableTypes: [...WORKSPACE_EVENT_TYPES], requestedTypes: null, after, limit: 100 });

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

  it("records a conversation's start once, with the conversation's own fields", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const visitorId = await seedVisitor(workspaceId);

    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed", visitorId });
    await conversations.createIfAbsent({ id: conversation.id, workspaceId, agentId, sourceChannel: "website_embed" });

    const page = await eventsOf(workspaceId);
    expect(page.events).toEqual([
      expect.objectContaining({
        type: "conversation.started",
        version: 1,
        workspaceId,
        data: { conversationId: conversation.id, agentId, channel: "website_embed", callerKind: "human", visitorId },
      }),
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
    const inner: ConversationRoutineStore = { loadActive: async () => null, save: async () => {}, clear: async () => {} };
    const store = new DeferredRoutineStore(inner, undefined, [booking]);
    const ended: RoutineState = {
      sessionId: conversation.id,
      routineId: "booking",
      executionId: randomUUID(),
      path: ["ask_name", "ask_phone", "done"],
      variables: { name: "Ada Lovelace", phone: "+44 20 7946 0000", internalScore: 7 },
      status: "completed",
      metadata: { terminalKind: "complete", terminalStepId: "done" },
    };
    await store.save(ended);

    const committed = { ...turn(workspaceId, conversation.id), routineStateTransition: store.getTransition() };
    await persistence.completeAssistantTurn(committed);
    // A retried turn writes the same run with the same values again.
    await persistence.completeAssistantTurn({ ...committed, assistantMessage: { ...committed.assistantMessage, id: randomUUID() } });

    const page = await eventsOf(workspaceId, start.nextCursor);
    expect(page.events).toEqual([
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

  it("records a contact request a turn queues, and one a notify step queues outside the turn", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const start = await eventsOf(workspaceId);
    const queued = { ...turn(workspaceId, conversation.id), actions: [{ type: "contact.send", payload: { email: "ada@example.com", message: "Please call me" } }] };

    await persistence.completeAssistantTurn(queued);
    // The retried turn's action is already queued, so nothing new is recorded.
    await persistence.completeAssistantTurn({ ...queued, assistantMessage: { ...queued.assistantMessage, id: randomUUID() } });
    await new ContactRequestRecordingOutbox(database.kysely, recorder).enqueue({
      type: "contact.send",
      payload: { email: "grace@example.com", message: "Send the brochure" },
      workspaceId,
      conversationId: conversation.id,
      idempotencyKey: `notify:${randomUUID()}`,
    });

    const page = await eventsOf(workspaceId, start.nextCursor);
    const requestIds = await database.query<{ id: string }>(
      "SELECT id FROM routine_action_requests WHERE conversation_id = $1 AND type = 'contact.send' ORDER BY created_at",
      [conversation.id],
    );
    expect(page.events.map((event) => event.data)).toEqual([
      expect.objectContaining({ contactRequestId: requestIds[0].id, values: { email: "ada@example.com", message: "Please call me" } }),
      expect.objectContaining({ contactRequestId: requestIds[1].id, values: { email: "grace@example.com", message: "Send the brochure" } }),
    ]);
    expect(page.events.every((event) => event.type === "contact_request.created")).toBe(true);
  });

  it("records the handoff a turn requests and the decision its routine waits on", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const start = await eventsOf(workspaceId);

    await persistence.completeAssistantTurn({
      ...turn(workspaceId, conversation.id),
      pendingDecisionTransition: {
        handle: `pd_${randomUUID()}`,
        conversationId: conversation.id,
        sessionId: conversation.id,
        workspaceId,
        agentId,
        routineId: "refund",
        stepId: "approve",
        reason: "Refunds over the limit need a teammate",
        options: [{ id: "approve", label: "Approve", payload: { amount: 120 } }, { id: "decline", label: "Decline" }],
        deciderScope: {},
        contentHash: "hash",
        deadline: null,
      },
    });
    await persistence.completeAssistantTurn({
      ...turn(workspaceId, conversation.id),
      ownershipHandoff: { reason: "routine_handoff" },
    });

    const page = await eventsOf(workspaceId, start.nextCursor);
    expect(page.events.map((event) => [event.type, event.data])).toEqual([
      ["decision.pending", expect.objectContaining({
        routineId: "refund",
        stepId: "approve",
        reason: "Refunds over the limit need a teammate",
        options: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }],
        deadline: null,
      })],
      ["handoff.requested", expect.objectContaining({ conversationId: conversation.id, reason: "routine_handoff" })],
    ]);
  });

  it("misses no event when transactions commit out of order", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const first = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const second = await conversations.create({ workspaceId, agentId, sourceChannel: "website_embed" });
    const start = await eventsOf(workspaceId);

    let releaseSlow!: () => void;
    const slowReleased = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let markRecorded!: () => void;
    const slowRecorded = new Promise<void>((resolve) => { markRecorded = resolve; });
    // The slow transaction writes first, so its event takes the smaller position, and commits last.
    const slow = database.kysely.transaction().execute(async (trx) => {
      await recorder.record(trx, handoff(workspaceId, first.id));
      markRecorded();
      await slowReleased;
    });
    await slowRecorded;
    await database.kysely.transaction().execute((trx) => recorder.record(trx, handoff(workspaceId, second.id)));

    const whileSlowRuns = await eventsOf(workspaceId, start.nextCursor);
    expect(whileSlowRuns.events).toEqual([]);

    releaseSlow();
    await slow;
    const afterCommit = await eventsOf(workspaceId, whileSlowRuns.nextCursor);
    expect(afterCommit.events.map((event) => event.data.conversationId)).toEqual([first.id, second.id]);
    expect((await eventsOf(workspaceId, afterCommit.nextCursor)).events).toEqual([]);
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
    });
    expect(withheld).toBe(1);
    expect((await eventsOf(workspaceId)).events.map((event) => event.type)).toEqual(["conversation.started"]);

    const thirtyOneDaysOn = new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000);
    let removed = 0;
    for (let batch = await new WorkspaceEventRetention(database.kysely).enforce({ now: thirtyOneDaysOn, limit: 500 }); batch > 0;
      batch = await new WorkspaceEventRetention(database.kysely).enforce({ now: thirtyOneDaysOn, limit: 500 })) {
      removed += batch;
    }
    expect(removed).toBeGreaterThan(0);
    expect((await eventsOf(workspaceId)).events).toEqual([]);
  });
});
