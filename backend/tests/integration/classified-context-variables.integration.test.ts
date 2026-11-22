import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { ClassifiedContextVariableReads } from "../../src/db/repositories/classifiedContextVariableReads.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { ConversationValueWriterService } from "../../src/modules/context-variables/public.js";
import type { ContextVariableOption } from "../../src/modules/context-variables/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const option = (key: string): ContextVariableOption => ({ key, label: key, description: `About ${key}.`, archived: false });

describeIntegration("classified attributes (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new ContextVariableRepository(database.kysely);
  const reads = new ClassifiedContextVariableReads(database.kysely);
  const writer = new ConversationValueWriterService({ repository });
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const classifier = { kind: "classifier" as const, ref: "context-classification/1" };

  const uniqueName = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "_")}`;
  const createChoice = () => repository.create({
    workspaceId, name: uniqueName("topic"), valueType: "enum", options: [option("billing"), option("shipping")],
    trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
  });

  const enablementSnapshot = (variableId: string, source: string, enabled = true) => ({
    id: randomUUID(), agentId, variableId, source, resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null,
    surfacing: "on_reference", enabled, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  const createConversationOn = async (enablements: unknown[]): Promise<string> => {
    const revisionId = randomUUID();
    await database.query(
      "INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation) VALUES ($1, $2, $3, $4::jsonb, 1)",
      [revisionId, agentId, workspaceId, JSON.stringify({ contextVariableEnablements: enablements })],
    );
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, agent_revision_id) VALUES ($1, $2, $3, $4)",
      [conversationId, workspaceId, agentId, revisionId],
    );
    return conversationId;
  };

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)", [
      accountId, "Classified Co", `classified-${accountId}@example.com`, "hash",
    ]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)", [
      workspaceId, accountId, "Classified Workspace", `route-${workspaceId}`,
    ]);
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [agentId, workspaceId, "Classified Agent"]);
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

  it("reads the classified variables of the conversation's pinned revision with the conversation's own value", async () => {
    const topic = await createChoice();
    const pushed = await createChoice();
    const disabled = await createChoice();
    const conversationId = await createConversationOn([
      enablementSnapshot(topic.id, "classified"),
      enablementSnapshot(pushed.id, "pushed"),
      enablementSnapshot(disabled.id, "classified", false),
    ]);
    await repository.upsertValue(topic.id, { type: "conversation", id: conversationId }, "shipping", { kind: "operator", ref: "user-1" });

    const read = await reads.readConversationTargets({ workspaceId, conversationId });

    expect(read?.agentId).toBe(agentId);
    expect(read?.targets).toEqual([{
      variable: expect.objectContaining({ id: topic.id, options: [option("billing"), option("shipping")] }),
      stored: { data: "shipping", writtenBy: { kind: "operator", ref: "user-1" } },
    }]);
    await expect(reads.readConversationTargets({ workspaceId: randomUUID(), conversationId })).resolves.toBeNull();
    await expect(reads.readDefinitions({ workspaceId, variableIds: [topic.id, pushed.id] })).resolves.toHaveLength(2);
  });

  it("writes as the classifier only over an empty or classifier-written value, and clears only its own", async () => {
    const topic = await createChoice();
    const conversationId = await createConversationOn([enablementSnapshot(topic.id, "classified")]);
    const scope = { type: "conversation" as const, id: conversationId };

    await expect(writer.write({ conversationId, variable: topic, stored: null, data: "billing", writtenBy: classifier })).resolves.toBe("written");
    await expect(repository.readValue(topic.id, scope)).resolves.toMatchObject({ data: "billing", writtenBy: classifier });

    await repository.upsertValue(topic.id, scope, "shipping", { kind: "api", ref: "credential-1" });
    // The run read the classifier's own value; the host's write since is kept by the store itself.
    const staleRead = { data: "billing", writtenBy: classifier };
    await expect(writer.write({ conversationId, variable: topic, stored: staleRead, data: null, writtenBy: classifier })).resolves.toBe("kept");
    await expect(writer.write({ conversationId, variable: topic, stored: staleRead, data: "billing", writtenBy: classifier })).resolves.toBe("unchanged");
    await expect(writer.write({ conversationId, variable: topic, stored: { data: "billing", writtenBy: classifier }, data: "shipping", writtenBy: classifier })).resolves.toBe("kept");
    await expect(repository.readValue(topic.id, scope)).resolves.toMatchObject({ data: "shipping", writtenBy: { kind: "api" } });

    await repository.deleteValue(topic.id, scope);
    await writer.write({ conversationId, variable: topic, stored: null, data: "billing", writtenBy: classifier });
    await expect(writer.write({ conversationId, variable: topic, stored: { data: "billing", writtenBy: classifier }, data: null, writtenBy: classifier })).resolves.toBe("cleared");
    await expect(repository.readValue(topic.id, scope)).resolves.toBeNull();
  });
});
