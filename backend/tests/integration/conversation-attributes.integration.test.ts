import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql, type CompiledQuery } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { ConversationAttributeReads } from "../../src/db/repositories/conversationAttributeReads.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { HistoryItemsRepository } from "../../src/db/repositories/historyItemsRepository.js";
import { postgresWorkspaceEventRecorder } from "../../src/db/repositories/workspaceEventLogRepository.js";
import { ConversationAttributeService } from "../../src/modules/context-variables/conversationAttributes.js";
import type { ContextVariableOption } from "../../src/modules/context-variables/domain.js";
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
  const variables = new ContextVariableRepository(database.kysely);
  const attributes = new ConversationAttributeService(new ConversationAttributeReads(database.kysely));
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

    const read = await attributes.read(workspaceId, conversationId);

    expect(read.map(({ name, value, scope, writtenBy }) => ({ name, value, scope, writtenBy }))).toEqual(
      [
        { name: topic.name, value: "billing", scope: "conversation", writtenBy: classifier },
        { name: plan.name, value: "basic", scope: "session", writtenBy: api },
      ].sort((left, right) => left.name.localeCompare(right.name)),
    );
    expect(read.find((attribute) => attribute.name === topic.name)?.option).toEqual({ label: "Billing", archived: false });
    await expect(attributes.read(randomUUID(), conversationId)).resolves.toEqual([]);
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
    await expect(attributes.resolveFilter(workspaceId, { name: topic.name, option: "returns" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(attributes.resolveFilter(randomUUID(), { name: topic.name, option: "billing" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("serves the Inbox's attribute filter from the filter index", async () => {
    const topic = await createChoice();
    // Enough conversations that reading each one's value costs more than the filter index's lookup.
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id)
       SELECT gen_random_uuid(), $1, $2 FROM generate_series(1, 400)`,
      [workspaceId, agentId],
    );
    await database.query(
      `INSERT INTO context_variable_values (workspace_id, variable_id, scope_type, scope_id, data, written_by_kind, written_by_ref)
       SELECT $1, $2, 'conversation', c.id::text, CASE WHEN random() < 0.05 THEN '"billing"'::jsonb ELSE '"shipping"'::jsonb END, 'classifier', 'context-classification/1'
         FROM conversations c WHERE c.workspace_id = $1`,
      [workspaceId, topic.id],
    );
    await database.query("ANALYZE context_variable_values");
    await database.query("ANALYZE conversations");
    const attribute = await attributes.resolveFilter(workspaceId, { name: topic.name, option: "billing" });
    const statements: CompiledQuery[] = [];
    // Shares the pool, so it is never destroyed: that would end the pool `database` owns.
    const logged = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: database.pool }),
      log: (event) => { statements.push(event.query); },
    });

    await new HistoryItemsRepository(logged).listPageByWorkspaceId(workspaceId, { limit: 50, attribute });

    const [listQuery] = statements;
    const plan = await database.kysely.transaction().execute(async (trx) => {
      await sql`SET LOCAL enable_seqscan = off`.execute(trx);
      return trx.executeQuery({ ...listQuery, sql: `EXPLAIN (FORMAT JSON) ${listQuery.sql}` });
    });
    expect(JSON.stringify(plan.rows)).toContain("idx_context_variable_values_variable_scope_data");
  });
});
