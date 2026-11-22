import { randomUUID } from "node:crypto";

import { afterAll, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import {
  postgresWorkspaceEventRecorder,
  WorkspaceEventValueWithholder,
} from "../../src/db/repositories/workspaceEventLogRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { ConversationValueWriterService, type ContextVariableOption } from "../../src/modules/context-variables/public.js";
import { workspaceEventDataSchema, type WorkspaceEventRecorder } from "../../src/shared/domain/workspaceEventLog.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const option = (key: string): ContextVariableOption => ({ key, label: key, description: null, archived: false });

describeIntegration("context_value.changed, recorded by each writer of a conversation's value (Postgres, #1884)", () => {
  const database = new Database(integrationDatabaseUrl);
  const recorder = postgresWorkspaceEventRecorder;
  const conversations = new ConversationRepository(database.kysely, recorder);
  const variables = new ContextVariableRepository(database.kysely, recorder);
  const classifierWrites = new ConversationValueWriterService({ repository: variables });
  const seededAccountIds: string[] = [];
  const api = { kind: "api" as const, ref: "credential-1" };
  const operator = { kind: "operator" as const, ref: "user-1" };
  const classifier = { kind: "classifier" as const, ref: "context-classification/1" };

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
    expect(events[0].data).toMatchObject({ conversationId, variable: "topic", valueType: "enum", scope: "conversation", redacted: false, routineId: null });
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
    const failingVariables = new ContextVariableRepository(database.kysely, failing);

    await expect(failingVariables.upsertValue(topic.id, scope, "billing", operator)).rejects.toThrow("event log unavailable");
    expect(await variables.readValue(topic.id, scope)).toBeNull();

    await variables.upsertValue(topic.id, scope, "billing", operator);
    await expect(failingVariables.deleteValue(topic.id, scope, operator)).rejects.toThrow("event log unavailable");
    expect((await variables.readValue(topic.id, scope))?.data).toBe("billing");
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
    await variables.upsertValue(topic.id, scope, "billing", { kind: "routine", ref: `booking:${randomUUID()}` });
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
