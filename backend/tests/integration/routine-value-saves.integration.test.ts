import { randomUUID } from "node:crypto";

import type { ConversationRoutineStore, Routine, RoutineState } from "@radioso/conversation-contract";
import { afterAll, expect, it, vi } from "vitest";

import { bindConsentMessageWithholding, createConsentWithdrawal } from "../../src/app/composition/consentWithdrawal.js";
import { conversationReadSources } from "../../src/app/composition/conversationReadSources.js";
import { withWorkspaceEvents } from "../../src/app/composition/workspaceEventLog.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ContextVariableValueWrites } from "../../src/db/repositories/contextVariableValueWrites.js";
import { readConversationSaveContext } from "../../src/db/repositories/conversationClassifiedVariables.js";
import { ConversationActivityRepository } from "../../src/db/repositories/conversationActivityRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { RoutineConsentRepository } from "../../src/db/repositories/routineConsentRepository.js";
import { RoutineStateRepository } from "../../src/db/repositories/routineStateRepository.js";
import { postgresWorkspaceEventRecorder } from "../../src/db/repositories/workspaceEventLogRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { PostgresAssistantTurnPersistence } from "../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import { DeferredRoutineStore } from "../../src/modules/chat/services/routines/deferredRoutineStore.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import {
  ContextValueSaves,
  ContextVariableResolverService,
  contextScopeLadder,
  projectContextForMatching,
  resolveContextForTurn,
  routineContextRenderer,
  type AgentContextVariableEnablement,
} from "../../src/modules/context-variables/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";
import { classBooking, createRoutineConsentChatHarness } from "./support/routineConsentChatHarness.js";
import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("a routine's slot values saved to attributes at its ending (Postgres, #1884)", () => {
  const database = new Database(integrationDatabaseUrl);
  const recorder = postgresWorkspaceEventRecorder;
  const conversations = new ConversationRepository(database.kysely, recorder);
  const valueWrites = new ContextVariableValueWrites(database.kysely, { recorder, delivery: { requestDelivery: () => undefined } });
  const metrics = new MetricsRegistry();
  const persistence = new PostgresAssistantTurnPersistence(
    database.kysely,
    withWorkspaceEvents(new ConversationActivityRepository(database.kysely)),
    recorder,
    60_000,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    bindConsentMessageWithholding,
    undefined,
    undefined,
    new ContextValueSaves({ store: valueWrites, conversations: { read: (trx, input) => readConversationSaveContext(trx, conversationReadSources(trx), input) }, metrics }),
  );
  const seededAccountIds: string[] = [];

  afterAll(async () => {
    if (seededAccountIds.length > 0) {
      await database.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [seededAccountIds]);
    }
    await database.close().catch(() => undefined);
  });

  const booking: Routine = {
    id: "booking",
    rootStepId: "ask_guests",
    steps: [
      { id: "ask_guests", kind: "chat" },
      { id: "ask_email", kind: "chat" },
      { id: "done", kind: "terminal", metadata: { terminalKind: "complete" } },
    ],
    transitions: [],
    slots: [
      { id: "slot-guests", key: "guests", type: "number", required: true, saveTo: { contextVariable: "party_size", scope: "conversation" } },
      { id: "slot-email", key: "email", type: "email", required: true, saveTo: { contextVariable: "contact_email", scope: "person" } },
      { id: "slot-note", key: "note", type: "text", required: false },
    ],
    // It asks consent for the email, so a turn that saves it checks the conversation's withdrawals (#1544).
    consents: [{ key: "booking", slotKeys: ["email"], onDecline: "continue" }],
  };

  interface Seeded {
    accountId: string;
    workspaceId: string;
    agentId: string;
    revisionId: string;
    variableIds: Record<"party_size" | "contact_email", string>;
  }

  const seedWorkspace = async (): Promise<Seeded> => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Saves",
      email: `saves-${randomUUID()}@bookings.example`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Saves Workspace");
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Front desk')", [agentId, workspace.id]);
    const variable = async (name: string, valueType: string): Promise<string> => (await database.query<{ id: string }>(
      `INSERT INTO context_variables (workspace_id, name, value_type, trust_tier, sensitivity, default_surfacing)
       VALUES ($1, $2, $3, 'unverified', 'normal', 'on_reference') RETURNING id`,
      [workspace.id, name, valueType],
    ))[0].id;
    const variableIds = { party_size: await variable("party_size", "number"), contact_email: await variable("contact_email", "string") };
    const revisionId = await release(workspace.id, agentId, Object.values(variableIds));
    return { accountId: account.id, workspaceId: workspace.id, agentId, revisionId, variableIds };
  };

  /** A published release of the agent keeping `keptVariableIds` as pushed attributes; the id a conversation is pinned to. */
  const release = async (workspaceId: string, agentId: string, keptVariableIds: readonly string[]): Promise<string> => {
    const now = new Date().toISOString();
    const contextVariableEnablements = keptVariableIds.map((variableId) => ({
      id: randomUUID(), agentId, variableId, source: "pushed", resolverSkillId: null, maxAgeSeconds: null,
      resolverTimeoutMs: null, surfacing: "on_reference", enabled: true, createdAt: now, updatedAt: now,
    }));
    return (await database.query<{ id: string }>(
      `INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation, published_at, published_version)
       VALUES ($1, $2, $3, $4::jsonb, 1, now(), (SELECT coalesce(max(published_version), 0) + 1 FROM agent_revisions WHERE agent_id = $2)) RETURNING id`,
      [randomUUID(), agentId, workspaceId, JSON.stringify({ contextVariableEnablements })],
    ))[0].id;
  };

  /** A conversation with the agent, pinned to its release, as a turn's preparation pins a new one. */
  const startConversation = (seeded: Seeded, keys: { verifiedCustomerId?: string; visitorId?: string; agentRevisionId?: string } = {}) =>
    conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, agentRevisionId: seeded.revisionId, sourceChannel: "website_embed", ...keys });

  const ended = (conversationId: string, terminalKind: string, variables: Record<string, unknown> = { guests: 4, email: "ada@guests.example", note: "window seat" }): RoutineState => ({
    sessionId: conversationId,
    routineId: "booking",
    executionId: randomUUID(),
    path: ["ask_guests", "ask_email", "done"],
    variables,
    status: "completed",
    metadata: { terminalKind, terminalStepId: "done" },
  });

  /** The transition a turn captures when it saves `state`, having read `endedBefore` as the conversation's ended runs. */
  const capturedSave = async (state: RoutineState, endedBefore: RoutineState[] = []) => {
    const inner: ConversationRoutineStore = { loadActive: async () => null, loadCompleted: async () => endedBefore, save: async () => {}, clear: async () => {} };
    const store = new DeferredRoutineStore(inner, undefined, [booking]);
    await store.loadCompleted({ sessionId: state.sessionId });
    await store.save(state);
    return store.getTransition();
  };

  const turnEnding = async (
    seeded: Seeded,
    conversation: { id: string },
    state: RoutineState,
    endedBefore: RoutineState[] = [],
  ) => turnCommitting(seeded, conversation, await capturedSave(state, endedBefore));

  /** The turn that commits `routineStateTransition`, as a turn that ended or corrected the booking does. */
  const turnCommitting = (
    seeded: Seeded,
    conversation: { id: string },
    routineStateTransition: Awaited<ReturnType<typeof capturedSave>>,
  ) => ({
    workspaceId: seeded.workspaceId,
    conversationId: conversation.id,
    routineStateTransition,
    assistantMessage: { id: randomUUID(), conversationId: conversation.id, workspaceId: seeded.workspaceId, role: "assistant" as const, content: "Booked." },
    auditEvent: {
      eventType: "chat.answer",
      eventStatus: "success" as const,
      workspaceId: seeded.workspaceId,
      metadata: {
        conversationId: conversation.id,
        turnTrace: {
          version: 1,
          spine: {
            traceId: randomUUID(),
            stages: [{ stage: "routine", outputs: { routineId: "booking" }, subTrace: { namespace: "routine", payload: { routineId: "booking" } } }],
          },
        },
      },
    },
  });

  const valuesOf = async (workspaceId: string) => database.query<{ name: string; scope_type: string; scope_id: string; data: unknown; written_by_kind: string; written_by_ref: string | null }>(
    `SELECT v.name, cv.scope_type, cv.scope_id, cv.data, cv.written_by_kind, cv.written_by_ref
       FROM context_variable_values cv JOIN context_variables v ON v.id = cv.variable_id
      WHERE cv.workspace_id = $1 ORDER BY v.name, cv.scope_type, cv.scope_id`,
    [workspaceId],
  );

  const eventsOf = async (workspaceId: string, type: string) => (await database.query<{ data: Record<string, unknown> }>(
    "SELECT data FROM workspace_events WHERE workspace_id = $1 AND type = $2 ORDER BY position",
    [workspaceId, type],
  )).map((row) => row.data);

  const savesTraced = async (workspaceId: string, conversationId: string) => {
    const [row] = await database.query<{ metadata_json: { turnTrace: { spine: { stages: Array<{ subTrace: { payload: { saves?: unknown } } }> } } } }>(
      "SELECT metadata_json FROM audit_events WHERE workspace_id = $1 AND event_type = 'chat.answer' AND metadata_json->>'conversationId' = $2",
      [workspaceId, conversationId],
    );
    return row.metadata_json.turnTrace.spine.stages[0].subTrace.payload.saves;
  };

  it("saves a completed run's values, and the change event naming the routine, in the turn's transaction, and traces each outcome without its value", async () => {
    const seeded = await seedWorkspace();
    const customerId = `customer-${randomUUID()}`;
    const conversation = await startConversation(seeded, { verifiedCustomerId: customerId });
    const state = ended(conversation.id, "complete");

    await persistence.completeAssistantTurn(await turnEnding(seeded, conversation, state));

    const ref = `booking:${state.executionId}@${conversation.id}`;
    expect(await valuesOf(seeded.workspaceId)).toEqual([
      { name: "contact_email", scope_type: "customer", scope_id: customerId, data: "ada@guests.example", written_by_kind: "routine", written_by_ref: ref },
      { name: "party_size", scope_type: "conversation", scope_id: conversation.id, data: 4, written_by_kind: "routine", written_by_ref: ref },
    ]);
    // A person's value a routine saves is the saving conversation's change too: its event names the scope, never the person.
    const events = await eventsOf(seeded.workspaceId, "context_value.changed");
    expect(events).toEqual([
      expect.objectContaining({ variable: "contact_email", scope: "customer", value: "ada@guests.example", writtenBy: "routine", routineId: "booking" }),
      expect.objectContaining({ variable: "party_size", scope: "conversation", value: 4, writtenBy: "routine", routineId: "booking" }),
    ]);
    expect(JSON.stringify(events)).not.toContain(customerId);
    expect(await eventsOf(seeded.workspaceId, "routine.completed")).toHaveLength(1);
    expect(await savesTraced(seeded.workspaceId, conversation.id)).toEqual([
      { slotKey: "guests", contextVariable: "party_size", scope: "conversation", outcome: "written" },
      { slotKey: "email", contextVariable: "contact_email", scope: "person", outcome: "written" },
    ]);
    expect(metrics.renderPrometheus()).toMatch(/context_value_writes_total\{[^}]*outcome="written"[^}]*\} [1-9]/);
  });

  it("rolls the values and their change event back with a turn that does not commit", async () => {
    const seeded = await seedWorkspace();
    const conversation = await startConversation(seeded);
    const input = await turnEnding(seeded, conversation, ended(conversation.id, "complete"));

    await expect(persistence.completeAssistantTurn({ ...input, commitFence: () => { throw new Error("A newer turn superseded this one"); } }))
      .rejects.toThrow("A newer turn superseded this one");

    expect(await valuesOf(seeded.workspaceId)).toEqual([]);
    expect(await eventsOf(seeded.workspaceId, "context_value.changed")).toEqual([]);
    expect(await eventsOf(seeded.workspaceId, "routine.completed")).toEqual([]);
  });

  it("saves nothing for a run that got stuck, was declined consent, or was abandoned", async () => {
    const seeded = await seedWorkspace();
    const conversation = await startConversation(seeded);
    const scope = conversation;

    await persistence.completeAssistantTurn(await turnEnding(seeded, scope, ended(conversation.id, "stuck")));
    await persistence.completeAssistantTurn(await turnEnding(seeded, scope, ended(conversation.id, "consent_declined")));
    // Abandoned: the visitor left mid-run, so the run never ended and its state is cleared.
    await persistence.completeAssistantTurn({
      ...await turnEnding(seeded, scope, ended(conversation.id, "complete")),
      routineStateTransition: { kind: "clear", sessionId: conversation.id },
    });

    expect(await valuesOf(seeded.workspaceId)).toEqual([]);
    expect(await eventsOf(seeded.workspaceId, "context_value.changed")).toEqual([]);
  });

  it("saves nothing to the person of a conversation with no verified person, says so on the trace, and the routine still completes", async () => {
    const seeded = await seedWorkspace();
    const conversation = await startConversation(seeded);

    await persistence.completeAssistantTurn(await turnEnding(seeded, conversation, ended(conversation.id, "handoff")));

    expect((await valuesOf(seeded.workspaceId)).map((value) => [value.name, value.scope_type])).toEqual([["party_size", "conversation"]]);
    expect(await savesTraced(seeded.workspaceId, conversation.id)).toEqual([
      { slotKey: "guests", contextVariable: "party_size", scope: "conversation", outcome: "written" },
      { slotKey: "email", contextVariable: "contact_email", scope: "person", outcome: "no_person_key" },
    ]);
    expect(await eventsOf(seeded.workspaceId, "routine.completed")).toEqual([expect.objectContaining({ outcome: "handoff" })]);
    expect(metrics.renderPrometheus()).toMatch(/context_value_writes_total\{[^}]*outcome="no_person_key"[^}]*\} [1-9]/);
  });

  it("saves a person value on WhatsApp for the number the turn carries, and for the number the conversation is recorded with when a turn carries none", async () => {
    const seeded = await seedWorkspace();
    // Obviously fake numbers in the reserved 555-01xx range.
    const first = await startConversation(seeded);
    const resumed = await startConversation(seeded);
    await database.query(
      "INSERT INTO connector_whatsapp_conversations (conversation_id, workspace_id, wa_id) VALUES ($1, $2, '15550100102')",
      [resumed.id, seeded.workspaceId],
    );

    await persistence.completeAssistantTurn({
      ...await turnEnding(seeded, first, ended(first.id, "complete")),
      channelPersonKey: { kind: "whatsapp_contact", id: "15550100101" },
    });
    await persistence.completeAssistantTurn(await turnEnding(seeded, resumed, ended(resumed.id, "complete", { guests: 2, email: "bo@guests.example" })));

    expect((await valuesOf(seeded.workspaceId)).filter((value) => value.name === "contact_email").map(({ scope_type, scope_id, data }) => ({ scope_type, scope_id, data })))
      .toEqual([
        { scope_type: "whatsapp_contact", scope_id: "15550100101", data: "ada@guests.example" },
        { scope_type: "whatsapp_contact", scope_id: "15550100102", data: "bo@guests.example" },
      ]);
    expect(await savesTraced(seeded.workspaceId, first.id)).toContainEqual(
      { slotKey: "email", contextVariable: "contact_email", scope: "person", outcome: "written" },
    );
    const events = await eventsOf(seeded.workspaceId, "context_value.changed");
    expect(events.filter((event) => event.scope === "whatsapp_contact")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/1555010010[12]/u);
  });

  it("replaces a classified value, gives way to a teammate's later one, and is not replaced by the classifier", async () => {
    const seeded = await seedWorkspace();
    const conversation = await startConversation(seeded);
    const scope = { type: "conversation" as const, id: conversation.id };
    const partySize = async () => (await valuesOf(seeded.workspaceId)).find((value) => value.name === "party_size");
    await valueWrites.upsertValue(seeded.variableIds.party_size, scope, 2, { kind: "classifier", ref: "classifier" });

    await persistence.completeAssistantTurn(await turnEnding(seeded, conversation, ended(conversation.id, "complete", { guests: 4 })));
    expect(await partySize()).toMatchObject({ data: 4, written_by_kind: "routine" });

    expect(await valueWrites.upsertValue(seeded.variableIds.party_size, scope, 3, { kind: "classifier", ref: "classifier" })).toBeNull();
    expect(await partySize()).toMatchObject({ data: 4, written_by_kind: "routine" });

    await valueWrites.upsertValue(seeded.variableIds.party_size, scope, 6, { kind: "operator", ref: "user-1" });
    expect(await partySize()).toMatchObject({ data: 6, written_by_kind: "operator" });

    // Last writer wins: a later run of the routine replaces the teammate's value.
    await persistence.completeAssistantTurn(await turnEnding(seeded, conversation, ended(conversation.id, "complete", { guests: 5 })));
    expect(await partySize()).toMatchObject({ data: 5, written_by_kind: "routine" });
  });

  it("hands what a routine saved to a later turn's directive condition and {{context.<name>}}, and a person's value to their next conversation", async () => {
    const seeded = await seedWorkspace();
    const customerId = `customer-${randomUUID()}`;
    const booking = await startConversation(seeded, { verifiedCustomerId: customerId });
    await persistence.completeAssistantTurn(await turnEnding(seeded, booking, ended(booking.id, "complete")));
    const repository = new ContextVariableRepository(database.kysely, null);
    const now = new Date().toISOString();
    const enablements = Object.values(seeded.variableIds).map((variableId) => ({
      id: randomUUID(), agentId: seeded.agentId, variableId, source: "pushed", resolverSkillId: null, maxAgeSeconds: null,
      resolverTimeoutMs: null, surfacing: "on_reference", enabled: true, createdAt: now, updatedAt: now,
    }) as unknown as AgentContextVariableEnablement);
    const nextTurn = async (conversationId: string) => resolveContextForTurn(null, await new ContextVariableResolverService({ repository, resolver: { resolve: vi.fn() } })
      .resolveForEnablements(seeded.workspaceId, seeded.agentId, enablements, contextScopeLadder({ conversationId, chatSessionId: null, verifiedCustomerId: customerId, agentId: seeded.agentId, workspaceId: seeded.workspaceId })));

    const sameConversation = await nextTurn(booking.id);
    expect(projectContextForMatching(sameConversation.snapshot).context).toMatchObject({ party_size: 4, contact_email: "ada@guests.example" });
    expect(routineContextRenderer.render({ name: "party_size", stagedContext: sameConversation.staged }))
      .toBe('<context_variable name="party_size">4</context_variable>');

    // The person's value follows them; the conversation's stays with the booking.
    const later = await startConversation(seeded, { verifiedCustomerId: customerId });
    const laterContext = projectContextForMatching((await nextTurn(later.id)).snapshot).context;
    expect(laterContext.contact_email).toBe("ada@guests.example");
    expect(laterContext).not.toHaveProperty("party_size");
  });

  it("deletes the values a routine saved, and their change events, when its consent is withdrawn", async () => {
    const seeded = await seedWorkspace();
    const customerId = `customer-${randomUUID()}`;
    const visitorId = (await database.query<{ id: string }>(
      "INSERT INTO visitors (workspace_id, visitor_key, conversation_count) VALUES ($1, $2, 1) RETURNING id",
      [seeded.workspaceId, `visitor-${randomUUID()}`],
    ))[0].id;
    const conversation = await startConversation(seeded, { verifiedCustomerId: customerId, visitorId });
    await persistence.completeAssistantTurn(await turnEnding(seeded, conversation, ended(conversation.id, "complete")));
    // A teammate's value of another attribute is no routine's, and stays.
    const teammateVariable = (await database.query<{ id: string }>(
      `INSERT INTO context_variables (workspace_id, name, value_type, trust_tier, sensitivity, default_surfacing)
       VALUES ($1, 'table', 'string', 'unverified', 'normal', 'on_reference') RETURNING id`,
      [seeded.workspaceId],
    ))[0].id;
    await valueWrites.upsertValue(teammateVariable, { type: "conversation", id: conversation.id }, "terrace", { kind: "operator", ref: "user-1" });

    const consents = new RoutineConsentRepository(database.kysely);
    const wordingVersionId = await consents.upsertWordingVersion({
      workspaceId: seeded.workspaceId,
      wording: { locale: "en", body: "We keep your booking details with this booking.", agreeLabel: "I agree", declineLabel: "No thanks" },
    });
    await consents.insertRecord({
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      conversationId: conversation.id,
      visitorId,
      routineId: "booking",
      consentKey: "booking",
      slotKeys: ["email"],
      wordingVersionId,
      locale: "en",
      decision: "granted",
      method: "reply",
      defaulted: false,
      channel: "website_embed",
      decisionMessageId: null,
    });
    const [record] = await database.query<{ id: string }>("SELECT id FROM routine_consent_records WHERE conversation_id = $1", [conversation.id]);
    const withdrawal = createConsentWithdrawal({
      db: database.kysely,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      metricsRegistry: metrics,
      auditLog: { logRecorded: () => undefined },
      invalidation: { enqueue: () => ({ accepted: true, coalesced: false }) },
    });

    await withdrawal.withdraw({ workspaceId: seeded.workspaceId, conversationId: conversation.id, recordId: record.id, actor: { accountId: seeded.accountId, userId: randomUUID() } });

    expect((await valuesOf(seeded.workspaceId)).map((value) => [value.name, value.written_by_kind])).toEqual([["table", "operator"]]);
    expect((await eventsOf(seeded.workspaceId, "context_value.changed")).map((event) => event.variable)).toEqual(["table"]);
  });

  /** A conversation with a visitor, which a consent record names, pinned to the agent's release. */
  const consentedConversation = async (seeded: Seeded, verifiedCustomerId: string) => {
    const visitorId = (await database.query<{ id: string }>(
      "INSERT INTO visitors (workspace_id, visitor_key, conversation_count) VALUES ($1, $2, 1) RETURNING id",
      [seeded.workspaceId, `visitor-${randomUUID()}`],
    ))[0].id;
    return startConversation(seeded, { verifiedCustomerId, visitorId });
  };

  /** Records the booking routine's granted consent in `conversation`, then withdraws it as a teammate would. */
  const withdrawBookingConsent = async (seeded: Seeded, conversation: { id: string; visitorId?: string | null }) => {
    const consents = new RoutineConsentRepository(database.kysely);
    const wordingVersionId = await consents.upsertWordingVersion({
      workspaceId: seeded.workspaceId,
      wording: { locale: "en", body: "We keep your booking details with this booking.", agreeLabel: "I agree", declineLabel: "No thanks" },
    });
    await consents.insertRecord({
      workspaceId: seeded.workspaceId, agentId: seeded.agentId, conversationId: conversation.id, visitorId: conversation.visitorId ?? null,
      routineId: "booking", consentKey: "booking", slotKeys: ["email"], wordingVersionId, locale: "en",
      decision: "granted", method: "reply", defaulted: false, channel: "website_embed", decisionMessageId: null,
    });
    const [record] = await database.query<{ id: string }>("SELECT id FROM routine_consent_records WHERE conversation_id = $1", [conversation.id]);
    await createConsentWithdrawal({
      db: database.kysely,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      metricsRegistry: metrics,
      auditLog: { logRecorded: () => undefined },
      invalidation: { enqueue: () => ({ accepted: true, coalesced: false }) },
    }).withdraw({ workspaceId: seeded.workspaceId, conversationId: conversation.id, recordId: record.id, actor: { accountId: seeded.accountId, userId: randomUUID() } });
  };

  const writtenCount = () => Number(/context_value_writes_total\{[^}]*outcome="written"[^}]*\} (\d+)/.exec(metrics.renderPrometheus())?.[1] ?? 0);

  it("saves nothing for a run that goes on after its consent was withdrawn in the conversation, and reports it as withdrawn, not written (B1)", async () => {
    const seeded = await seedWorkspace();
    const conversation = await consentedConversation(seeded, `customer-${randomUUID()}`);
    await withdrawBookingConsent(seeded, conversation);
    const written = writtenCount();

    await persistence.completeAssistantTurn(await turnEnding(seeded, conversation, ended(conversation.id, "complete")));

    expect(await valuesOf(seeded.workspaceId)).toEqual([]);
    expect(await savesTraced(seeded.workspaceId, conversation.id)).toEqual([
      { slotKey: "guests", contextVariable: "party_size", scope: "conversation", outcome: "withdrawn" },
      { slotKey: "email", contextVariable: "contact_email", scope: "person", outcome: "withdrawn" },
    ]);
    expect(writtenCount()).toBe(written);
  });

  it("never takes, on a later turn of the withdrawn conversation, what the same person's run saved in another conversation under its own consent (B1)", async () => {
    const seeded = await seedWorkspace();
    const customerId = `customer-${randomUUID()}`;
    const monday = await consentedConversation(seeded, customerId);
    await persistence.completeAssistantTurn(await turnEnding(seeded, monday, ended(monday.id, "complete")));
    await withdrawBookingConsent(seeded, monday);
    const tuesday = await consentedConversation(seeded, customerId);
    const tuesdayRun = ended(tuesday.id, "complete", { guests: 2, email: "ada.tuesday@guests.example" });
    await persistence.completeAssistantTurn(await turnEnding(seeded, tuesday, tuesdayRun));

    // Wednesday: the booking routine ends again in Monday's conversation, whose consent stays withdrawn.
    await persistence.completeAssistantTurn(await turnEnding(seeded, monday, ended(monday.id, "complete", { guests: 6, email: "ada.wednesday@guests.example" })));

    const tuesdayRef = `booking:${tuesdayRun.executionId}@${tuesday.id}`;
    expect(await valuesOf(seeded.workspaceId)).toEqual([
      { name: "contact_email", scope_type: "customer", scope_id: customerId, data: "ada.tuesday@guests.example", written_by_kind: "routine", written_by_ref: tuesdayRef },
      { name: "party_size", scope_type: "conversation", scope_id: tuesday.id, data: 2, written_by_kind: "routine", written_by_ref: tuesdayRef },
    ]);
  });

  it("withdraws only what runs in the withdrawing conversation saved: another conversation's and another customer's values stay", async () => {
    const seeded = await seedWorkspace();
    const ada = `customer-${randomUUID()}`;
    const grace = `customer-${randomUUID()}`;
    const withdrawn = await consentedConversation(seeded, ada);
    const adaElsewhere = await consentedConversation(seeded, ada);
    const graceBooking = await consentedConversation(seeded, grace);
    await persistence.completeAssistantTurn(await turnEnding(seeded, withdrawn, ended(withdrawn.id, "complete", { guests: 4, email: "ada@guests.example" })));
    await persistence.completeAssistantTurn(await turnEnding(seeded, graceBooking, ended(graceBooking.id, "complete", { guests: 3, email: "grace@guests.example" })));
    // A later run of Ada's in another conversation saves her email again, under that conversation's consent.
    await persistence.completeAssistantTurn(await turnEnding(seeded, adaElsewhere, ended(adaElsewhere.id, "complete", { guests: 2, email: "ada.elsewhere@guests.example" })));

    await withdrawBookingConsent(seeded, withdrawn);

    const byNameAndScope = (left: unknown[], right: unknown[]) => `${String(left[0])}${String(left[1])}`.localeCompare(`${String(right[0])}${String(right[1])}`);
    expect((await valuesOf(seeded.workspaceId)).map((value) => [value.name, value.scope_id, value.data]).sort(byNameAndScope)).toEqual([
      ["contact_email", ada, "ada.elsewhere@guests.example"],
      ["contact_email", grace, "grace@guests.example"],
      ["party_size", adaElsewhere.id, 2],
      ["party_size", graceBooking.id, 3],
    ].sort(byNameAndScope));
  });

  it("re-saves only the field a correction to an ended run changed, and leaves the host's newer value of another field", async () => {
    const seeded = await seedWorkspace();
    const customerId = `customer-${randomUUID()}`;
    const conversation = await startConversation(seeded, { verifiedCustomerId: customerId });
    const run = ended(conversation.id, "complete");
    await persistence.completeAssistantTurn(await turnEnding(seeded, conversation, run));
    await valueWrites.upsertValue(seeded.variableIds.contact_email, { type: "customer", id: customerId }, "ada@new.example", { kind: "api", ref: "credential-1" });

    // The visitor corrects the party size after the booking ended.
    await persistence.completeAssistantTurn(await turnEnding(seeded, conversation, { ...run, variables: { ...run.variables, guests: 5 } }, [run]));

    expect((await valuesOf(seeded.workspaceId)).map((value) => [value.name, value.data, value.written_by_kind])).toEqual([
      ["contact_email", "ada@new.example", "api"],
      ["party_size", 5, "routine"],
    ]);
  });

  it("re-saves a correction to a run the Postgres store kept, which holds no ending metadata, and leaves a teammate's newer value (D1)", async () => {
    const seeded = await seedWorkspace();
    const customerId = `customer-${randomUUID()}`;
    const conversation = await startConversation(seeded, { verifiedCustomerId: customerId });
    const routineStates = new RoutineStateRepository(database.kysely);
    const { metadata, ...run } = ended(conversation.id, "complete");
    const endingTurn = new DeferredRoutineStore(routineStates, undefined, [booking]);
    await endingTurn.save({ ...run, metadata });
    await persistence.completeAssistantTurn(turnCommitting(seeded, conversation, endingTurn.getTransition()));
    await valueWrites.upsertValue(seeded.variableIds.contact_email, { type: "customer", id: customerId }, "ada@new.example", { kind: "operator", ref: "teammate-1" });

    // The visitor corrects the party size; the turn reads the ended run back from Postgres.
    const correctionTurn = new DeferredRoutineStore(routineStates, undefined, [booking]);
    const [stored] = await correctionTurn.loadCompleted({ sessionId: conversation.id });
    expect(stored).toEqual(run);
    await correctionTurn.save({ ...stored, variables: { ...stored.variables, guests: 5 }, status: "completed" });
    await persistence.completeAssistantTurn(turnCommitting(seeded, conversation, correctionTurn.getTransition()));

    expect((await valuesOf(seeded.workspaceId)).map((value) => [value.name, value.data, value.written_by_kind])).toEqual([
      ["contact_email", "ada@new.example", "operator"],
      ["party_size", 5, "routine"],
    ]);
    const traced = (await database.query<{ saves: unknown }>(
      `SELECT metadata_json->'turnTrace'->'spine'->'stages'->0->'subTrace'->'payload'->'saves' AS saves
         FROM audit_events WHERE workspace_id = $1 AND event_type = 'chat.answer' AND metadata_json->>'conversationId' = $2`,
      [seeded.workspaceId, conversation.id],
    )).map((row) => row.saves);
    // The ending turn traced both saves; the correction traced the one field it changed.
    expect(traced).toHaveLength(2);
    expect(traced).toContainEqual([{ slotKey: "guests", contextVariable: "party_size", scope: "conversation", outcome: "written" }]);
  });

  it("keeps a teammate's equal value and its writer, so a later withdrawal never takes it", async () => {
    const seeded = await seedWorkspace();
    const conversation = await startConversation(seeded);
    await valueWrites.upsertValue(seeded.variableIds.party_size, { type: "conversation", id: conversation.id }, 4, { kind: "operator", ref: "user-1" });

    await persistence.completeAssistantTurn(await turnEnding(seeded, conversation, ended(conversation.id, "complete", { guests: 4 })));

    expect((await valuesOf(seeded.workspaceId)).map((value) => [value.name, value.data, value.written_by_kind])).toEqual([["party_size", 4, "operator"]]);
    expect(await savesTraced(seeded.workspaceId, conversation.id)).toEqual([
      { slotKey: "guests", contextVariable: "party_size", scope: "conversation", outcome: "unchanged" },
    ]);
  });

  it("writes nothing to an attribute the conversation's release does not keep, and says so", async () => {
    const seeded = await seedWorkspace();
    const keepsOnlyEmail = await release(seeded.workspaceId, seeded.agentId, [seeded.variableIds.contact_email]);
    const conversation = await startConversation(seeded, { verifiedCustomerId: `customer-${randomUUID()}`, agentRevisionId: keepsOnlyEmail });

    await persistence.completeAssistantTurn(await turnEnding(seeded, conversation, ended(conversation.id, "complete")));

    expect((await valuesOf(seeded.workspaceId)).map((value) => value.name)).toEqual(["contact_email"]);
    expect(await savesTraced(seeded.workspaceId, conversation.id)).toEqual([
      { slotKey: "guests", contextVariable: "party_size", scope: "conversation", outcome: "not_enabled" },
      { slotKey: "email", contextVariable: "contact_email", scope: "person", outcome: "written" },
    ]);
    expect(metrics.renderPrometheus()).toMatch(/context_value_writes_total\{[^}]*outcome="not_enabled"[^}]*\} [1-9]/);
  });
});

describeIntegration("a routine's saves through the chat turn (Postgres, #1884)", () => {
  const database = new Database(integrationDatabaseUrl);
  const BOOKING_ID = "routine-class-saves";
  const slotValues: Record<string, Record<string, string>> = {
    "My name is Ada": { name: "Ada" },
    "Tuesday at 10": { time: "Tuesday at 10" },
  };
  const model: ChatGateway = {
    async answer(input) {
      const prompt = input.systemPrompt ?? "";
      if (prompt.includes("wants to start any registered routine")) {
        return JSON.stringify({ matches: [{ routineId: BOOKING_ID, confidence: 0.95, variables: {} }] });
      }
      if (prompt.includes("claimsAuthority") || prompt.includes("Declared slots")) {
        return JSON.stringify({ variables: slotValues[input.query] ?? {}, claimsAuthority: false, condition: null, offTopic: false });
      }
      return `[step reply to: ${input.query}]`;
    },
    async *streamAnswer() {
      throw new Error("these turns run the non-streaming path");
    },
  };
  const harness = createRoutineConsentChatHarness(database, model);
  const definition = {
    ...classBooking("continue", { askTime: true }),
    id: BOOKING_ID,
    lineageId: BOOKING_ID,
    consents: [],
    slots: [
      { stableSlotId: "slot_name", key: "name", type: "text" as const, required: true, description: "The visitor's name", ordinal: 0, saveTo: { contextVariable: "visitor_name", scope: "person" as const } },
      { stableSlotId: "slot_time", key: "time", type: "text" as const, required: true, description: "When the visitor wants to come", ordinal: 1, saveTo: { contextVariable: "class_time", scope: "conversation" as const } },
    ],
    steps: [
      { stableStepId: "ask_name", kind: "chat" as const, instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} },
      { stableStepId: "ask_time", kind: "chat" as const, instruction: "Ask for {{slot.time}}.", toolRef: null, ordinal: 1, metadata: {} },
    ],
    transitions: [
      { fromStep: "ask_name", toRef: "ask_time", guardKind: "default" as const, guardText: null, ordinal: 0 },
      { fromStep: "ask_time", toRef: "done", guardKind: "default" as const, guardText: null, ordinal: 1 },
    ],
  };

  afterAll(async () => {
    await harness.cleanup();
    await database.close().catch(() => undefined);
  });

  /** A conversation whose stored release keeps the two attributes the booking saves to. */
  const bookingConversation = async () => {
    const conversation = await harness.startConversation({ definition });
    const variable = async (name: string) => (await database.query<{ id: string }>(
      `INSERT INTO context_variables (workspace_id, name, value_type, trust_tier, sensitivity, default_surfacing)
       VALUES ($1, $2, 'string', 'unverified', 'normal', 'on_reference') RETURNING id`,
      [conversation.workspaceId, name],
    ))[0].id;
    const now = new Date().toISOString();
    const contextVariableEnablements = [await variable("visitor_name"), await variable("class_time")].map((variableId) => ({
      id: randomUUID(), agentId: conversation.agentId, variableId, source: "pushed", resolverSkillId: null, maxAgeSeconds: null,
      resolverTimeoutMs: null, surfacing: "on_reference", enabled: true, createdAt: now, updatedAt: now,
    }));
    await database.query("UPDATE agent_revisions SET snapshot = $1::jsonb WHERE agent_id = $2", [JSON.stringify({ contextVariableEnablements }), conversation.agentId]);
    return conversation;
  };

  const valuesIn = (workspaceId: string) => database.query<{ name: string; scope_type: string; scope_id: string; data: unknown }>(
    `SELECT v.name, cv.scope_type, cv.scope_id, cv.data FROM context_variable_values cv JOIN context_variables v ON v.id = cv.variable_id
      WHERE cv.workspace_id = $1 ORDER BY v.name`,
    [workspaceId],
  );

  /** The saves on the routine's trace of the conversation's latest turn. */
  const lastTurnSaves = async (workspaceId: string, conversationId: string) => {
    const [row] = await database.query<{ metadata_json: unknown }>(
      `SELECT metadata_json FROM audit_events WHERE workspace_id = $1 AND event_type = 'chat.answer' AND metadata_json->>'conversationId' = $2
        ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, conversationId],
    );
    return JSON.stringify(row?.metadata_json ?? null).match(/"saves":(\[[^\]]*\])/)?.[1];
  };

  it("saves a person value to the customer the conversation is bound to, though a later turn carries another verified id (S1)", async () => {
    const conversation = await bookingConversation();

    await conversation.send("I want to book a class", undefined, { verifiedCustomerId: "customer-ada" });
    await conversation.send("My name is Ada", undefined, { verifiedCustomerId: "customer-grace" });
    await conversation.send("Tuesday at 10", undefined, { verifiedCustomerId: "customer-grace" });

    expect(await conversation.routineState()).toMatchObject({ status: "completed" });
    expect(await valuesIn(conversation.workspaceId)).toEqual([
      { name: "class_time", scope_type: "conversation", scope_id: conversation.conversationId, data: "Tuesday at 10" },
      { name: "visitor_name", scope_type: "customer", scope_id: "customer-ada", data: "Ada" },
    ]);
    expect(JSON.parse(await lastTurnSaves(conversation.workspaceId, conversation.conversationId) ?? "null")).toEqual([
      { slotKey: "name", contextVariable: "visitor_name", scope: "person", outcome: "written" },
      { slotKey: "time", contextVariable: "class_time", scope: "conversation", outcome: "written" },
    ]);
  });

  it("writes nothing from a safe_test turn, as an agent turn probe runs, and shows where each value would have gone (CR6)", async () => {
    const conversation = await bookingConversation();

    await conversation.send("I want to book a class");
    await conversation.send("My name is Ada");
    await conversation.send("Tuesday at 10", undefined, { executionMode: "safe_test" });

    expect(await valuesIn(conversation.workspaceId)).toEqual([]);
    const saves = await lastTurnSaves(conversation.workspaceId, conversation.conversationId);
    expect(JSON.parse(saves ?? "null")).toEqual([
      { slotKey: "name", contextVariable: "visitor_name", scope: "person", outcome: "not_saved_in_test" },
      { slotKey: "time", contextVariable: "class_time", scope: "conversation", outcome: "not_saved_in_test" },
    ]);
    expect(saves).not.toContain("Tuesday");
  });
});
