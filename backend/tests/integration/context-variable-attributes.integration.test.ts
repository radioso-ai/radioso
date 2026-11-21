import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import {
  ContextVariableRepository,
  ContextVariableValueEraser,
  ContextVariableValueExporter,
} from "../../src/db/repositories/contextVariableRepository.js";
import { contextScopeLadder, type ContextVariableOption } from "../../src/modules/context-variables/domain.js";
import { Database } from "../../src/shared/infra/database.js";
import { toJsonb } from "../../src/shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const option = (key: string, archived = false): ContextVariableOption => ({
  key,
  label: key.charAt(0).toUpperCase() + key.slice(1),
  description: `Conversations about ${key}.`,
  archived,
});

describeIntegration("typed attributes (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new ContextVariableRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const api = { kind: "api" as const, ref: "credential-1" };

  const uniqueName = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "_")}`;

  const createConversation = async (sessionId: string | null = null): Promise<string> => {
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, anonymous_session_id) VALUES ($1, $2, $3, $4)",
      [conversationId, workspaceId, agentId, sessionId],
    );
    return conversationId;
  };

  const createTopic = () => repository.create({
    workspaceId,
    name: uniqueName("topic"),
    description: "What the conversation is about.",
    valueType: "enum",
    options: [option("billing"), option("shipping")],
    trustTier: "unverified",
    sensitivity: "normal",
    defaultSurfacing: "on_reference",
  });

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)", [
      accountId, "Attributes Co", `attributes-${accountId}@example.com`, "hash",
    ]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)", [
      workspaceId, accountId, "Attributes Workspace", `route-${workspaceId}`,
    ]);
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [agentId, workspaceId, "Attributes Agent"]);
    await database.query(
      "INSERT INTO agent_drafts (agent_id, workspace_id, generation, snapshot) VALUES ($1, $2, 1, $3::jsonb)",
      [agentId, workspaceId, JSON.stringify({ customInstruction: null, directives: [], routines: [], contextVariableEnablements: [] })],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("stores an enum definition's options and returns them wherever the definition is read", async () => {
    const topic = await createTopic();
    expect(topic).toMatchObject({ valueType: "enum", options: [option("billing"), option("shipping")] });

    const updated = await repository.update(workspaceId, topic.id, { options: [option("billing"), option("shipping", true), option("returns")] });
    expect(updated?.options).toEqual([option("billing"), option("shipping", true), option("returns")]);
    expect((await repository.get(workspaceId, topic.id))?.options).toEqual(updated?.options);
    await repository.upsertEnablement({ agentId, variableId: topic.id, source: "pushed", surfacing: "on_reference" });
    const enablement = (await repository.listByAgent(workspaceId, agentId)).find((row) => row.variableId === topic.id);
    expect(enablement?.variable?.options).toEqual(updated?.options);

    const plain = await repository.create({
      workspaceId, name: uniqueName("plan"), valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always",
    });
    expect(plain.options).toBeNull();
  });

  it("keeps a conversation's value under its id, with who wrote it, and refuses an id no conversation of the workspace has", async () => {
    const topic = await createTopic();
    const conversationId = await createConversation();
    const scope = { type: "conversation" as const, id: conversationId };

    const saved = await repository.upsertValue(topic.id, scope, "billing", api);
    expect(saved).toMatchObject({ scope, data: "billing", writtenBy: api });
    expect(await repository.readValue(topic.id, scope)).toMatchObject({ data: "billing", writtenBy: api });
    expect(await repository.hasValues(topic.id)).toBe(true);

    await expect(repository.upsertValue(topic.id, { type: "conversation", id: randomUUID() }, "billing", api))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("keeps a value sent under an uppercase conversation id under the conversation's own id, where its erasure finds it", async () => {
    const topic = await createTopic();
    const conversationId = await createConversation();
    const sent = { type: "conversation" as const, id: conversationId.toUpperCase() };

    expect(await repository.upsertValue(topic.id, sent, "billing", api))
      .toMatchObject({ scope: { type: "conversation", id: conversationId } });
    expect(await repository.readValue(topic.id, sent)).toMatchObject({ data: "billing" });

    await new ContextVariableValueEraser(database.kysely).erase({ kind: "conversations", workspaceId, conversationIds: [conversationId] });
    expect(await repository.readValue(topic.id, sent)).toBeNull();
    expect(await repository.hasValues(topic.id)).toBe(false);
  });

  /**
   * Runs `hold` in a transaction left open until `release` is called, while the test races it, then
   * `finish` in the same transaction before it commits.
   */
  const holdOpen = (hold: (trx: Db) => Promise<void>, finish: (trx: Db) => Promise<void> = async () => undefined) => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let markHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { markHeld = resolve; });
    const done = database.kysely.transaction().execute(async (trx) => {
      await hold(trx);
      markHeld();
      await released;
      await finish(trx);
    });
    return { held, release, done };
  };
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const createPlan = () => repository.create({
    workspaceId, name: uniqueName("plan"), valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always",
  });

  it("refuses a value that no longer fits a type changed after the writer read the definition", async () => {
    const plan = await createPlan();
    await repository.update(workspaceId, plan.id, { valueType: "enum", options: [option("gold")] });

    await expect(repository.upsertValue(plan.id, { type: "session", id: `session-${randomUUID()}` }, "free text", api))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await repository.hasValues(plan.id)).toBe(false);
  });

  it("refuses a type change that waited on a value write in flight", async () => {
    const plan = await createPlan();
    // A value write holds the variable's row the way the writer does, and has not committed yet.
    const writer = holdOpen(async (trx) => {
      await trx.selectFrom("context_variables").select("id").where("id", "=", plan.id).forKeyShare().executeTakeFirstOrThrow();
      await trx.insertInto("context_variable_values").values({
        id: randomUUID(), workspace_id: workspaceId, variable_id: plan.id, scope_type: "session",
        scope_id: `session-${randomUUID()}`, data: toJsonb("free text"), written_by_kind: "api",
      }).execute();
    });
    await writer.held;

    const typeChange = repository.update(workspaceId, plan.id, { valueType: "enum", options: [option("gold")] })
      .catch((error: unknown) => error);
    await pause(200);
    writer.release();
    await writer.done;

    expect(await typeChange).toMatchObject({ statusCode: 409 });
    expect((await repository.get(workspaceId, plan.id))?.valueType).toBe("string");
  });

  it("refuses a conversation value written while that conversation is being erased", async () => {
    const topic = await createTopic();
    const conversationId = await createConversation();
    // The erasure locks the conversation, runs the erasers, then deletes it, in one transaction.
    const erasure = holdOpen(
      async (trx) => {
        await trx.selectFrom("conversations").select("id").where("id", "=", conversationId).forNoKeyUpdate().executeTakeFirstOrThrow();
        await new ContextVariableValueEraser(trx).erase({ kind: "conversations", workspaceId, conversationIds: [conversationId] });
      },
      async (trx) => { await trx.deleteFrom("conversations").where("id", "=", conversationId).execute(); },
    );
    await erasure.held;

    const write = repository.upsertValue(topic.id, { type: "conversation", id: conversationId }, "billing", api)
      .catch((error: unknown) => error);
    await pause(200);
    erasure.release();
    await erasure.done;

    expect(await write).toMatchObject({ statusCode: 404 });
    expect(await repository.hasValues(topic.id)).toBe(false);
  });

  it("reads a value written before writers were recorded as the API's", async () => {
    const topic = await createTopic();
    const scope = { type: "session" as const, id: `session-${randomUUID()}` };
    await database.query(
      "INSERT INTO context_variable_values (workspace_id, variable_id, scope_type, scope_id, data) VALUES ($1, $2, $3, $4, '\"billing\"'::jsonb)",
      [workspaceId, topic.id, scope.type, scope.id],
    );
    expect((await repository.readValue(topic.id, scope))?.writtenBy).toEqual({ kind: "api", ref: null });
  });

  it("lets the classifier fill only an empty value or its own, and lets every other writer replace it", async () => {
    const topic = await createTopic();
    const scope = { type: "conversation" as const, id: await createConversation() };
    const classifier = { kind: "classifier" as const, ref: "context-classification@1" };

    expect(await repository.upsertValue(topic.id, scope, "billing", classifier)).toMatchObject({ writtenBy: classifier });
    expect(await repository.upsertValue(topic.id, scope, "shipping", classifier)).toMatchObject({ data: "shipping" });
    expect(await repository.upsertValue(topic.id, scope, "billing", api)).toMatchObject({ data: "billing", writtenBy: api });
    expect(await repository.upsertValue(topic.id, scope, "shipping", classifier)).toBeNull();
    expect(await repository.readValue(topic.id, scope)).toMatchObject({ data: "billing", writtenBy: api });
  });

  it("resolves the conversation's own value ahead of the session's", async () => {
    const topic = await createTopic();
    await repository.upsertEnablement({ agentId, variableId: topic.id, source: "pushed", surfacing: "on_reference" });
    const chatSessionId = `session-${randomUUID()}`;
    const conversationId = await createConversation(chatSessionId);
    const scopes = contextScopeLadder({ conversationId, chatSessionId, verifiedCustomerId: null, agentId, workspaceId });
    await repository.upsertValue(topic.id, { type: "session", id: chatSessionId }, "shipping", api);
    await repository.upsertValue(topic.id, { type: "conversation", id: conversationId }, "billing", api);

    const resolved = await repository.resolveForAgent(workspaceId, agentId, scopes);
    expect(resolved.find((variable) => variable.name === topic.name)).toMatchObject({ value: "billing", label: "Billing" });
  });

  it("reads each variable's most specific value on the ladder in one read", async () => {
    const topic = await createTopic();
    const unset = await createTopic();
    const plan = await repository.create({
      workspaceId, name: uniqueName("plan"), valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always",
    });
    const chatSessionId = `session-${randomUUID()}`;
    const conversationId = await createConversation(chatSessionId);
    const scopes = contextScopeLadder({ conversationId, chatSessionId, verifiedCustomerId: null, agentId, workspaceId });
    await repository.upsertValue(topic.id, { type: "session", id: chatSessionId }, "shipping", api);
    await repository.upsertValue(topic.id, { type: "conversation", id: conversationId }, "billing", api);
    await repository.upsertValue(plan.id, { type: "workspace", id: workspaceId }, "basic", api);
    await repository.upsertValue(plan.id, { type: "agent", id: agentId }, "pro", api);

    const values = await repository.readMostSpecificValues([topic.id, plan.id, unset.id], scopes);

    expect(values.get(topic.id)).toMatchObject({ data: "billing", scope: { type: "conversation", id: conversationId } });
    expect(values.get(plan.id)).toMatchObject({ data: "pro", scope: { type: "agent", id: agentId } });
    expect(values.has(unset.id)).toBe(false);
  });

  it("erases a conversation's values with it and exports them with their writer", async () => {
    const topic = await createTopic();
    const erased = await createConversation();
    const kept = await createConversation();
    await repository.upsertValue(topic.id, { type: "conversation", id: erased }, "billing", api);
    await repository.upsertValue(topic.id, { type: "conversation", id: kept }, "shipping", api);

    const exported = await new ContextVariableValueExporter(database.kysely).export({
      workspaceId, conversationIds: [erased], visitorIds: [], verifiedCustomerIds: [],
    });
    expect(exported).toEqual([expect.objectContaining({ variable: topic.name, scope: "conversation", value: "billing", writtenBy: "api" })]);

    await new ContextVariableValueEraser(database.kysely).erase({ kind: "conversations", workspaceId, conversationIds: [erased] });
    expect(await repository.readValue(topic.id, { type: "conversation", id: erased })).toBeNull();
    expect(await repository.readValue(topic.id, { type: "conversation", id: kept })).toMatchObject({ data: "shipping" });
  });
});
