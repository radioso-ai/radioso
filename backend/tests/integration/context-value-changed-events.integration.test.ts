import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { ContextVariableValueWrites } from "../../src/db/repositories/contextVariableValueWrites.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import {
  postgresWorkspaceEventRecorder,
  WorkspaceEventValueWithholder,
} from "../../src/db/repositories/workspaceEventLogRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { ConversationValueWriterService, routineValueWriter, type ContextVariableOption } from "../../src/modules/context-variables/public.js";
import { workspaceEventDataSchema, type WorkspaceEventRecorder } from "../../src/shared/domain/workspaceEventLog.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const option = (key: string): ContextVariableOption => ({ key, label: key, description: null, archived: false });

describeIntegration("context_value.changed, recorded by each writer of a conversation's value (Postgres, #1884)", () => {
  const database = new Database(integrationDatabaseUrl);
  const recorder = postgresWorkspaceEventRecorder;
  const deliveryRequests: string[] = [];
  const delivery = { requestDelivery: (workspaceId: string) => { deliveryRequests.push(workspaceId); } };
  const conversations = new ConversationRepository(database.kysely, recorder);
  const variables = new ContextVariableRepository(database.kysely, { recorder, delivery });
  const classifierWrites = new ConversationValueWriterService({ repository: variables });
  const seededAccountIds: string[] = [];
  const api = { kind: "api" as const, ref: "credential-1" };
  const operator = { kind: "operator" as const, ref: "user-1" };
  const classifier = { kind: "classifier" as const, ref: "context-classification/1" };

  beforeEach(() => {
    deliveryRequests.length = 0;
  });

  afterAll(async () => {
    if (seededAccountIds.length > 0) {
      await database.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [seededAccountIds]);
    }
    await database.close().catch(() => undefined);
  });

  const seed = async (options: { sourceChannel?: string } = {}) => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Attribute events",
      email: `attribute-events-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Attribute events");
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Front desk')", [agentId, workspace.id]);
    const conversation = await conversations.create({
      workspaceId: workspace.id,
      agentId,
      sourceChannel: options.sourceChannel ?? "website_embed",
      anonymousSessionId: `session-${randomUUID()}`,
    });
    const topic = await variables.create({
      workspaceId: workspace.id, name: "topic", valueType: "enum", options: [option("billing"), option("shipping")],
      trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
    });
    const careNeed = await variables.create({
      workspaceId: workspace.id, name: "care_need", valueType: "enum", options: [option("dental")],
      trustTier: "unverified", sensitivity: "sensitive", defaultSurfacing: "on_reference",
    });
    return { workspaceId: workspace.id, conversationId: conversation.id, sessionId: conversation.anonymousSessionId!, topic, careNeed };
  };

  /** Each `context_value.changed` of the workspace, oldest first, its `data` as the log serves it. */
  const valueEvents = async (workspaceId: string) => (await database.query<{
    data: Record<string, unknown>;
    conversation_id: string;
    agent_id: string | null;
    channel: string | null;
    caller_kind: string;
    visitor_id: string | null;
  }>(
    `SELECT data, conversation_id, agent_id, channel, caller_kind, visitor_id FROM workspace_events
     WHERE workspace_id = $1 AND type = 'context_value.changed' ORDER BY position`,
    [workspaceId],
  )).map((row): { conversation_id: string; data: Record<string, unknown> } => ({
    conversation_id: row.conversation_id,
    data: {
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      channel: row.channel,
      callerKind: row.caller_kind,
      visitorId: row.visitor_id,
      ...row.data,
    },
  }));

  it("records each change of the conversation's value with its writer, and nothing for a write that changes no value", async () => {
    const { workspaceId, conversationId, topic } = await seed();
    const scope = { type: "conversation" as const, id: conversationId };

    await variables.upsertValue(topic.id, scope, "billing", classifier);
    await variables.upsertValue(topic.id, scope, "billing", operator);
    await variables.upsertValue(topic.id, scope, "shipping", api);
    await variables.deleteValue(topic.id, scope, operator);
    await variables.deleteValue(topic.id, scope, operator);

    const events = await valueEvents(workspaceId);
    expect(events.map((event) => [event.data.value, event.data.writtenBy])).toEqual([
      ["billing", "classifier"],
      ["shipping", "api"],
      [null, "operator"],
    ]);
    expect(events.every((event) => event.conversation_id === conversationId)).toBe(true);
    for (const event of events) {
      expect(() => workspaceEventDataSchema("context_value.changed").strict().parse(event.data)).not.toThrow();
    }
    expect(events[0].data).toMatchObject({ conversationId, variableId: topic.id, variable: "topic", valueType: "enum", scope: "conversation", redacted: false, routineId: null });
  });

  it("asks for delivery once each change commits, and not for a write that changes nothing", async () => {
    const { workspaceId, conversationId, sessionId, topic } = await seed();
    const scope = { type: "conversation" as const, id: conversationId };

    await variables.upsertValue(topic.id, scope, "billing", classifier);
    await variables.upsertValue(topic.id, scope, "billing", operator);
    await variables.deleteValue(topic.id, scope, operator);
    await variables.deleteValue(topic.id, scope, operator);
    await variables.upsertValue(topic.id, { type: "session", id: sessionId }, "billing", api);

    expect(deliveryRequests).toEqual([workspaceId, workspaceId]);
  });

  it("redacts the variable's earlier values when it becomes Private, and only that variable's", async () => {
    const { workspaceId, conversationId, topic, careNeed } = await seed();
    const other = await seed();
    const scope = { type: "conversation" as const, id: conversationId };
    const plan = await variables.create({
      workspaceId, name: "plan", valueType: "enum", options: [option("pro")],
      trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
    });
    await variables.upsertValue(topic.id, scope, "billing", classifier);
    await variables.upsertValue(topic.id, scope, "shipping", operator);
    await variables.upsertValue(plan.id, scope, "pro", api);
    await variables.upsertValue(careNeed.id, scope, "dental", api);
    await variables.upsertValue(other.topic.id, { type: "conversation", id: other.conversationId }, "billing", api);

    await variables.update(workspaceId, topic.id, { sensitivity: "sensitive" });

    const events = await valueEvents(workspaceId);
    expect(events.map((event) => [event.data.variable, event.data.value, event.data.redacted, event.data.writtenBy])).toEqual([
      ["topic", null, true, "classifier"],
      ["topic", null, true, "operator"],
      ["plan", "pro", false, "api"],
      ["care_need", null, true, "api"],
    ]);
    expect(JSON.stringify(events)).not.toMatch(/billing|shipping/);
    for (const event of events) {
      expect(() => workspaceEventDataSchema("context_value.changed").strict().parse(event.data)).not.toThrow();
    }
    expect((await valueEvents(other.workspaceId)).map((event) => event.data.value)).toEqual(["billing"]);
  });

  it("redacts them the same way when an applied proposal makes the attribute Private", async () => {
    const { workspaceId, conversationId, topic } = await seed();
    await variables.upsertValue(topic.id, { type: "conversation", id: conversationId }, "billing", api);
    const agent = await new AgentRepository(database.kysely).create(workspaceId, { name: "Reviewed changes" });

    await variables.applyProposal({
      workspaceId,
      agentId: agent.id,
      variableId: topic.id,
      definition: {
        name: topic.name, description: null, valueType: "enum", options: topic.options,
        trustTier: "unverified", sensitivity: "sensitive", defaultSurfacing: "on_reference",
      },
      expectedVariableUpdatedAt: topic.updatedAt,
      enablement: null,
      expectedEnablementUpdatedAt: null,
    });

    expect((await valueEvents(workspaceId)).map((event) => [event.data.value, event.data.redacted])).toEqual([[null, true]]);
  });

  it("records the classifier's writes and its clears, and nothing when it keeps a teammate's value or answers the same", async () => {
    const { workspaceId, conversationId, topic } = await seed();
    const write = (data: string | null, stored: Parameters<typeof classifierWrites.write>[0]["stored"]) =>
      classifierWrites.write({ conversationId, variable: topic, stored, data, writtenBy: classifier });

    expect(await write("billing", null)).toBe("written");
    expect(await write("billing", { data: "billing", writtenBy: classifier })).toBe("unchanged");
    expect(await write(null, { data: "billing", writtenBy: classifier })).toBe("cleared");
    await variables.upsertValue(topic.id, { type: "conversation", id: conversationId }, "shipping", operator);
    expect(await write("billing", { data: "shipping", writtenBy: operator })).toBe("kept");

    expect((await valueEvents(workspaceId)).map((event) => [event.data.value, event.data.writtenBy])).toEqual([
      ["billing", "classifier"],
      [null, "classifier"],
      ["shipping", "operator"],
    ]);
  });

  it("never carries a Private attribute's value", async () => {
    const { workspaceId, conversationId, careNeed } = await seed();

    await variables.upsertValue(careNeed.id, { type: "conversation", id: conversationId }, "dental", api);

    const [event] = await valueEvents(workspaceId);
    expect(event.data).toMatchObject({ variable: "care_need", value: null, redacted: true });
    expect(JSON.stringify(event.data)).not.toContain("dental");
  });

  it("records nothing for a value kept for the visitor's session, or for a Test Chat conversation", async () => {
    const { workspaceId, sessionId, topic } = await seed();
    await variables.upsertValue(topic.id, { type: "session", id: sessionId }, "billing", api);
    const test = await seed({ sourceChannel: "authenticated_chat" });
    await variables.upsertValue(test.topic.id, { type: "conversation", id: test.conversationId }, "billing", api);

    expect(await valueEvents(workspaceId)).toEqual([]);
    expect(await valueEvents(test.workspaceId)).toEqual([]);
  });

  it("writes the value and its event in one transaction: a failed event leaves the value as it was", async () => {
    const { conversationId, topic } = await seed();
    const scope = { type: "conversation" as const, id: conversationId };
    const failing: WorkspaceEventRecorder = { record: async () => { throw new Error("event log unavailable"); } };
    const failingVariables = new ContextVariableRepository(database.kysely, { recorder: failing, delivery });

    await expect(failingVariables.upsertValue(topic.id, scope, "billing", operator)).rejects.toThrow("event log unavailable");
    expect(await variables.readValue(topic.id, scope)).toBeNull();

    await variables.upsertValue(topic.id, scope, "billing", operator);
    await expect(failingVariables.deleteValue(topic.id, scope, operator)).rejects.toThrow("event log unavailable");
    expect((await variables.readValue(topic.id, scope))?.data).toBe("billing");
    expect(deliveryRequests).toHaveLength(1);
  });

  it("goes with its conversation", async () => {
    const { workspaceId, conversationId, topic } = await seed();
    await variables.upsertValue(topic.id, { type: "conversation", id: conversationId }, "billing", operator);
    expect(await valueEvents(workspaceId)).toHaveLength(1);

    await database.query("DELETE FROM conversations WHERE id = $1", [conversationId]);

    expect(await valueEvents(workspaceId)).toEqual([]);
  });

  it("leaves the log when the consent of the routine that wrote it is withdrawn", async () => {
    const { workspaceId, conversationId, topic } = await seed();
    const scope = { type: "conversation" as const, id: conversationId };
    // A routine's value is written only by its ending's save, in the turn's transaction, naming the routine.
    const valueWrites = new ContextVariableValueWrites(database.kysely, { recorder, delivery });
    await database.kysely.transaction().execute(async (trx) => {
      const definition = await valueWrites.lockDefinitionNamedIn(trx, workspaceId, "topic");
      await valueWrites.storeIn(trx, { definition: definition!, scope, data: "billing", writtenBy: routineValueWriter("booking", randomUUID(), conversationId), routineId: "booking", conversationId });
    });
    await variables.upsertValue(topic.id, scope, "shipping", operator);

    const withheld = await new WorkspaceEventValueWithholder(database.kysely).withhold({
      workspaceId,
      conversationId,
      messageIds: [],
      valueTexts: [],
      withdrawnRoutineSlots: [{ routineId: "booking", slotKeys: ["topic"] }],
    });

    expect(withheld).toBe(1);
    expect((await valueEvents(workspaceId)).map((event) => event.data.writtenBy)).toEqual(["operator"]);
  });
});
