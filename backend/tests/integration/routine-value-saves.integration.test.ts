import { randomUUID } from "node:crypto";

import type { ConversationRoutineStore, Routine, RoutineState } from "@radioso/conversation-contract";
import { afterAll, expect, it, vi } from "vitest";

import { createConsentWithdrawal } from "../../src/app/composition/consentWithdrawal.js";
import { withWorkspaceEvents } from "../../src/app/composition/workspaceEventLog.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ContextVariableValueWrites } from "../../src/db/repositories/contextVariableValueWrites.js";
import { ConversationActivityRepository } from "../../src/db/repositories/conversationActivityRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { RoutineConsentRepository } from "../../src/db/repositories/routineConsentRepository.js";
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
    undefined,
    undefined,
    undefined,
    new ContextValueSaves({ store: valueWrites, metrics }),
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
    steps: [],
    transitions: [],
    slots: [
      { id: "slot-guests", key: "guests", type: "number", required: true, saveTo: { contextVariable: "party_size", scope: "conversation" } },
      { id: "slot-email", key: "email", type: "email", required: true, saveTo: { contextVariable: "contact_email", scope: "person" } },
      { id: "slot-note", key: "note", type: "text", required: false },
    ],
  };

  interface Seeded {
    accountId: string;
    workspaceId: string;
    agentId: string;
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
    return {
      accountId: account.id,
      workspaceId: workspace.id,
      agentId,
      variableIds: { party_size: await variable("party_size", "number"), contact_email: await variable("contact_email", "string") },
    };
  };

  const ended = (conversationId: string, terminalKind: string, variables: Record<string, unknown> = { guests: 4, email: "ada@guests.example", note: "window seat" }): RoutineState => ({
    sessionId: conversationId,
    routineId: "booking",
    executionId: randomUUID(),
    path: ["ask_guests", "ask_email", "done"],
    variables,
    status: "completed",
    metadata: { terminalKind, terminalStepId: "done" },
  });

  const capturedSave = async (state: RoutineState) => {
    const inner: ConversationRoutineStore = { loadActive: async () => null, save: async () => {}, clear: async () => {} };
    const store = new DeferredRoutineStore(inner, undefined, [booking]);
    await store.save(state);
    return store.getTransition();
  };

  const turnEnding = async (
    seeded: Seeded,
    conversation: { id: string; verifiedCustomerId: string | null },
    state: RoutineState,
  ) => ({
    workspaceId: seeded.workspaceId,
    conversationId: conversation.id,
    verifiedCustomerId: conversation.verifiedCustomerId,
    routineStateTransition: await capturedSave(state),
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
      WHERE cv.workspace_id = $1 ORDER BY v.name, cv.scope_type`,
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
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed", verifiedCustomerId: customerId });
    const state = ended(conversation.id, "complete");

    await persistence.completeAssistantTurn(await turnEnding(seeded, { id: conversation.id, verifiedCustomerId: customerId }, state));

    const ref = `booking:${state.executionId}`;
    expect(await valuesOf(seeded.workspaceId)).toEqual([
      { name: "contact_email", scope_type: "customer", scope_id: customerId, data: "ada@guests.example", written_by_kind: "routine", written_by_ref: ref },
      { name: "party_size", scope_type: "conversation", scope_id: conversation.id, data: 4, written_by_kind: "routine", written_by_ref: ref },
    ]);
    // A person's value is no conversation's change: only the conversation's own records an event.
    expect(await eventsOf(seeded.workspaceId, "context_value.changed")).toEqual([
      expect.objectContaining({ variable: "party_size", value: 4, writtenBy: "routine", routineId: "booking" }),
    ]);
    expect(await eventsOf(seeded.workspaceId, "routine.completed")).toHaveLength(1);
    expect(await savesTraced(seeded.workspaceId, conversation.id)).toEqual([
      { slotKey: "guests", contextVariable: "party_size", scope: "conversation", outcome: "written" },
      { slotKey: "email", contextVariable: "contact_email", scope: "person", outcome: "written" },
    ]);
    expect(metrics.renderPrometheus()).toMatch(/context_value_writes_total\{[^}]*outcome="written"[^}]*\} [1-9]/);
  });

  it("rolls the values and their change event back with a turn that does not commit", async () => {
    const seeded = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed" });
    const input = await turnEnding(seeded, { id: conversation.id, verifiedCustomerId: null }, ended(conversation.id, "complete"));

    await expect(persistence.completeAssistantTurn({ ...input, commitFence: () => { throw new Error("A newer turn superseded this one"); } }))
      .rejects.toThrow("A newer turn superseded this one");

    expect(await valuesOf(seeded.workspaceId)).toEqual([]);
    expect(await eventsOf(seeded.workspaceId, "context_value.changed")).toEqual([]);
    expect(await eventsOf(seeded.workspaceId, "routine.completed")).toEqual([]);
  });

  it("saves nothing for a run that got stuck, was declined consent, or was abandoned", async () => {
    const seeded = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed" });
    const scope = { id: conversation.id, verifiedCustomerId: null };

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
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed" });

    await persistence.completeAssistantTurn(await turnEnding(seeded, { id: conversation.id, verifiedCustomerId: null }, ended(conversation.id, "handoff")));

    expect((await valuesOf(seeded.workspaceId)).map((value) => [value.name, value.scope_type])).toEqual([["party_size", "conversation"]]);
    expect(await savesTraced(seeded.workspaceId, conversation.id)).toEqual([
      { slotKey: "guests", contextVariable: "party_size", scope: "conversation", outcome: "written" },
      { slotKey: "email", contextVariable: "contact_email", scope: "person", outcome: "no_person_key" },
    ]);
    expect(await eventsOf(seeded.workspaceId, "routine.completed")).toEqual([expect.objectContaining({ outcome: "handoff" })]);
    expect(metrics.renderPrometheus()).toMatch(/context_value_writes_total\{[^}]*outcome="no_person_key"[^}]*\} [1-9]/);
  });

  it("replaces a classified value, gives way to a teammate's later one, and is not replaced by the classifier", async () => {
    const seeded = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed" });
    const scope = { type: "conversation" as const, id: conversation.id };
    const partySize = async () => (await valuesOf(seeded.workspaceId)).find((value) => value.name === "party_size");
    await valueWrites.upsertValue(seeded.variableIds.party_size, scope, 2, { kind: "classifier", ref: "classifier" });

    await persistence.completeAssistantTurn(await turnEnding(seeded, { id: conversation.id, verifiedCustomerId: null }, ended(conversation.id, "complete", { guests: 4 })));
    expect(await partySize()).toMatchObject({ data: 4, written_by_kind: "routine" });

    expect(await valueWrites.upsertValue(seeded.variableIds.party_size, scope, 3, { kind: "classifier", ref: "classifier" })).toBeNull();
    expect(await partySize()).toMatchObject({ data: 4, written_by_kind: "routine" });

    await valueWrites.upsertValue(seeded.variableIds.party_size, scope, 6, { kind: "operator", ref: "user-1" });
    expect(await partySize()).toMatchObject({ data: 6, written_by_kind: "operator" });

    // Last writer wins: a later run of the routine replaces the teammate's value.
    await persistence.completeAssistantTurn(await turnEnding(seeded, { id: conversation.id, verifiedCustomerId: null }, ended(conversation.id, "complete", { guests: 5 })));
    expect(await partySize()).toMatchObject({ data: 5, written_by_kind: "routine" });
  });

  it("hands what a routine saved to a later turn's directive condition and {{context.<name>}}, and a person's value to their next conversation", async () => {
    const seeded = await seedWorkspace();
    const customerId = `customer-${randomUUID()}`;
    const booking = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed", verifiedCustomerId: customerId });
    await persistence.completeAssistantTurn(await turnEnding(seeded, { id: booking.id, verifiedCustomerId: customerId }, ended(booking.id, "complete")));
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
    const later = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed", verifiedCustomerId: customerId });
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
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed", verifiedCustomerId: customerId, visitorId });
    await persistence.completeAssistantTurn(await turnEnding(seeded, { id: conversation.id, verifiedCustomerId: customerId }, ended(conversation.id, "complete")));
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
});
