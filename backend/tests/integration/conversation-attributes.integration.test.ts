import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql, type CompiledQuery } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { conversationReadSources } from "../../src/app/composition/conversationReadSources.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { ConversationAttributeReads } from "../../src/db/repositories/conversationAttributeReads.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { HistoryItemsRepository } from "../../src/db/repositories/historyItemsRepository.js";
import { postgresWorkspaceEventRecorder } from "../../src/db/repositories/workspaceEventLogRepository.js";
import { ConversationAttributeService } from "../../src/modules/context-variables/conversationAttributes.js";
import type { ContextVariableOption } from "../../src/modules/context-variables/domain.js";
import { ATTRIBUTE_FILTER_NOT_SET, type ConversationAttributeFilter } from "../../src/modules/context-variables/public.js";
import { Database } from "../../src/shared/infra/database.js";
import type { DB } from "../../src/shared/infra/kysely/schema.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const option = (key: string): ContextVariableOption => ({
  key,
  label: key.charAt(0).toUpperCase() + key.slice(1),
  description: null,
  archived: false,
});

describeIntegration("a conversation's attributes and the attribute filter (Postgres, #1884)", () => {
  const database = new Database(integrationDatabaseUrl);
  const variables = new ContextVariableRepository(database.kysely, null);
  const attributes = new ConversationAttributeService(new ConversationAttributeReads(database.kysely, conversationReadSources(database.kysely)));
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const classifier = { kind: "classifier" as const, ref: "context-classification/1" };
  const api = { kind: "api" as const, ref: "credential-1" };

  const uniqueName = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "_")}`;
  const createChoice = () => variables.create({
    workspaceId, name: uniqueName("topic"), valueType: "enum", options: [option("billing"), option("shipping")],
    trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
  });
  const createConversation = async (visitor: { sessionId?: string; customerId?: string } = {}): Promise<string> => {
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, anonymous_session_id, verified_customer_id) VALUES ($1, $2, $3, $4, $5)",
      [conversationId, workspaceId, agentId, visitor.sessionId ?? null, visitor.customerId ?? null],
    );
    return conversationId;
  };

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)", [
      accountId, "Attribute Inbox Co", `attribute-inbox-${accountId}@example.com`, "hash",
    ]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)", [
      workspaceId, accountId, "Attribute Inbox Workspace", `route-${workspaceId}`,
    ]);
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [agentId, workspaceId, "Attribute Agent"]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM conversations WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("reads the values set for the conversation, its session and its customer, not an agent or workspace default", async () => {
    const topic = await createChoice();
    const plan = await variables.create({
      workspaceId, name: uniqueName("plan"), valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always",
    });
    const region = await variables.create({
      workspaceId, name: uniqueName("region"), valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always",
    });
    const sessionId = `session-${randomUUID()}`;
    const customerId = `customer-${randomUUID()}`;
    const conversationId = await createConversation({ sessionId, customerId });
    const otherConversationId = await createConversation({ sessionId: `session-${randomUUID()}` });
    await variables.upsertValue(topic.id, { type: "conversation", id: conversationId }, "billing", classifier);
    await variables.upsertValue(topic.id, { type: "conversation", id: otherConversationId }, "shipping", classifier);
    await variables.upsertValue(plan.id, { type: "session", id: sessionId }, "basic", api);
    await variables.upsertValue(plan.id, { type: "customer", id: customerId }, "pro", api);
    await variables.upsertValue(region.id, { type: "workspace", id: workspaceId }, "eu", api);
    await variables.upsertValue(region.id, { type: "agent", id: agentId }, "us", api);

    const read = await attributes.read(workspaceId, { conversationId, chatSessionId: sessionId, verifiedCustomerId: customerId, sourceChannel: null });

    expect(read.map(({ name, value, scope, writtenBy }) => ({ name, value, scope, writtenBy }))).toEqual(
      [
        { name: topic.name, value: "billing", scope: "conversation", writtenBy: classifier },
        { name: plan.name, value: "basic", scope: "session", writtenBy: api },
      ].sort((left, right) => left.name.localeCompare(right.name)),
    );
    expect(read.find((attribute) => attribute.name === topic.name)?.option).toEqual({ label: "Billing", archived: false });
    await expect(attributes.read(randomUUID(), { conversationId, chatSessionId: sessionId, verifiedCustomerId: customerId, sourceChannel: null })).resolves.toEqual([]);
  });

  it("redacts a Private value read from Postgres, and keeps who set it", async () => {
    const careNeed = await variables.create({
      workspaceId, name: uniqueName("care_need"), valueType: "enum", options: [option("dental")],
      trustTier: "unverified", sensitivity: "sensitive", defaultSurfacing: "on_reference",
    });
    const conversationId = await createConversation();
    await variables.upsertValue(careNeed.id, { type: "conversation", id: conversationId }, "dental", api);

    const [attribute] = await attributes.read(workspaceId, { conversationId, chatSessionId: null, verifiedCustomerId: null, sourceChannel: null });

    expect(attribute).toEqual({
      name: careNeed.name, valueType: "enum", value: null, redacted: true, scope: "conversation", writtenBy: api, updatedAt: expect.any(Date), classified: false,
    });
    expect(JSON.stringify(attribute)).not.toContain("dental");
  });

  it("narrows both history lists to the conversations holding an option, and refuses a filter it cannot serve", async () => {
    const topic = await createChoice();
    const billing = await createConversation();
    const shipping = await createConversation();
    const sessionId = `session-${randomUUID()}`;
    await createConversation({ sessionId });
    await createConversation();
    await variables.upsertValue(topic.id, { type: "conversation", id: billing }, "billing", classifier);
    await variables.upsertValue(topic.id, { type: "conversation", id: shipping }, "shipping", api);
    // A visitor-level value is not the conversation's own label, so the filter leaves it out.
    await variables.upsertValue(topic.id, { type: "session", id: sessionId }, "billing", api);

    const attribute = await attributes.resolveFilter(workspaceId, { name: topic.name, option: "billing" });
    const items = await new HistoryItemsRepository(database.kysely).listPageByWorkspaceId(workspaceId, { limit: 50, attribute });
    const conversations = await new ConversationRepository(database.kysely, postgresWorkspaceEventRecorder)
      .listPageByWorkspaceId(workspaceId, { limit: 50, attribute });

    expect(items.items.map((item) => item.id)).toEqual([billing]);
    expect(items.total).toBe(1);
    expect(conversations.conversations.map((conversation) => conversation.id)).toEqual([billing]);
    expect(conversations.total).toBe(1);

    // Not set: every conversation without a value of its own, the one whose visitor holds one included.
    const notSet = await attributes.resolveFilter(workspaceId, { name: topic.name, option: ATTRIBUTE_FILTER_NOT_SET });
    const workspaceConversations = (await database.query<{ id: string }>("SELECT id FROM conversations WHERE workspace_id = $1", [workspaceId]))
      .map((row) => row.id);
    const unset = workspaceConversations.filter((id) => id !== billing && id !== shipping);
    const unsetItems = await new HistoryItemsRepository(database.kysely).listPageByWorkspaceId(workspaceId, { limit: 100, attribute: notSet });
    const unsetConversations = await new ConversationRepository(database.kysely, postgresWorkspaceEventRecorder)
      .listPageByWorkspaceId(workspaceId, { limit: 100, attribute: notSet });
    expect(unsetItems.items.map((item) => item.id).sort()).toEqual([...unset].sort());
    expect(unsetItems.total).toBe(unset.length);
    expect(unsetConversations.conversations.map((conversation) => conversation.id).sort()).toEqual([...unset].sort());
    expect(unsetConversations.total).toBe(unset.length);
    await expect(attributes.resolveFilter(workspaceId, { name: topic.name, option: "returns" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(attributes.resolveFilter(randomUUID(), { name: topic.name, option: "billing" })).rejects.toMatchObject({ statusCode: 400 });
  });

  /** The SQL a list read sends for an attribute filter, captured on a logging Kysely that shares the pool. */
  const capturedFilterQuery = async (read: (db: Kysely<DB>) => Promise<unknown>): Promise<CompiledQuery> => {
    const statements: CompiledQuery[] = [];
    // Shares the pool, so it is never destroyed: that would end the pool `database` owns.
    const logged = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: database.pool }),
      log: (event) => { statements.push(event.query); },
    });
    await read(logged);
    const query = statements.find((statement) => statement.sql.includes("context_variable_values"));
    if (!query) throw new Error("The list read sent no attribute filter");
    return query;
  };

  const planWithoutSequentialScans = async (query: CompiledQuery): Promise<string> => {
    const plan = await database.kysely.transaction().execute(async (trx) => {
      await sql`SET LOCAL enable_seqscan = off`.execute(trx);
      return trx.executeQuery({ ...query, sql: `EXPLAIN (FORMAT JSON) ${query.sql}` });
    });
    return JSON.stringify(plan.rows);
  };

  // What these prove: each list's filter query implies the partial index's predicate, so the
  // index is usable. With sequential scans off the planner names a partial index only when the
  // query's WHERE implies its predicate; drop `filterIndexPredicate` and both fail.
  it.each([
    ["the merged history list (/history, /history/query)", (db: Kysely<DB>, attribute: ConversationAttributeFilter) =>
      new HistoryItemsRepository(db).listPageByWorkspaceId(workspaceId, { limit: 50, attribute })],
    ["the chat list (/history/chat, Ray's conversation_history_search)", (db: Kysely<DB>, attribute: ConversationAttributeFilter) =>
      new ConversationRepository(db, postgresWorkspaceEventRecorder).listPageByWorkspaceId(workspaceId, { limit: 50, attribute })],
  ])("can serve %s's attribute filter from the filter index", async (_list, read) => {
    const topic = await createChoice();
    const conversationId = await createConversation();
    await variables.upsertValue(topic.id, { type: "conversation", id: conversationId }, "billing", classifier);
    const attribute = await attributes.resolveFilter(workspaceId, { name: topic.name, option: "billing" });

    const query = await capturedFilterQuery((db) => read(db, attribute));

    expect(await planWithoutSequentialScans(query)).toContain("idx_context_variable_values_variable_scope_data");
  });
});
