import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { toJsonb } from "../../src/shared/infra/kysely/sqlHelpers.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) return false;
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const describeIfDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("agent retrieve skill sync", () => {
  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;
  let agentRepository: AgentRepository;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accountRepository = new AccountRepository(database.kysely);
    workspaceRepository = new WorkspaceRepository(database.kysely);
    agentRepository = new AgentRepository(database.kysely);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  const createWorkspace = async () => {
    const account = await accountRepository.create({
      name: "Retrieve Skill Sync",
      email: `retrieve-skill-sync-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    return workspaceRepository.create(account.id, "Retrieve Skill Sync");
  };

  it("keeps an existing default-answer retrieve skill aligned with agent retrieval edits", async () => {
    const workspace = await createWorkspace();
    const sourceId = randomUUID();
    await database.kysely
      .insertInto("document_sources")
      .values({
        id: sourceId,
        workspace_id: workspace.id,
        name: "Product handbook",
        kind: "manual",
      })
      .executeTakeFirstOrThrow();

    const agent = await agentRepository.create(workspace.id, {
      name: "Docs Agent",
      retrievalEnabled: true,
      sourceScope: { mode: "all" },
      suggestedQuestionsEnabled: true,
    });

    await database.kysely
      .insertInto("agent_skills")
      .values({
        id: randomUUID(),
        workspace_id: workspace.id,
        agent_id: agent.id,
        skill_name: "answer",
        kind: "retrieve",
        target_type: "source_scope",
        target_id: null,
        invocation_mode: "default_answer",
        enabled: true,
        config: toJsonb({
          sourceScope: "all",
          suggestedQuestionsEnabled: true,
          vectorTopK: 4,
          exposedInputs: { query: true },
        }),
      })
      .executeTakeFirstOrThrow();

    const updated = await agentRepository.update(agent.id, workspace.id, {
      retrievalEnabled: false,
      sourceScope: { mode: "selected", sourceIds: [sourceId] },
      suggestedQuestionsEnabled: false,
      skillSettings: {
        "retrieval.answer": {
          vectorTopK: 9,
          customInstruction: "Use the selected product handbook.",
          similarityThreshold: 0.82,
          providerKnob: "preserved",
        },
      },
    });

    expect(updated.retrievalEnabled).toBe(false);
    expect(updated.sourceScope).toEqual({ mode: "selected", sourceIds: [sourceId] });
    expect(updated.suggestedQuestionsEnabled).toBe(false);
    expect(updated.skillSettings["retrieval.answer"]).toMatchObject({
      vectorTopK: 9,
      customInstruction: "Use the selected product handbook.",
      providerKnob: "preserved",
    });

    const readBack = await agentRepository.findByIdAndWorkspaceId(agent.id, workspace.id);
    expect(readBack).toMatchObject({
      retrievalEnabled: false,
      sourceScope: { mode: "selected", sourceIds: [sourceId] },
      suggestedQuestionsEnabled: false,
    });

    const row = await database.kysely
      .selectFrom("agent_skills")
      .select(["enabled", "config"])
      .where("agent_id", "=", agent.id)
      .where("kind", "=", "retrieve")
      .where("invocation_mode", "=", "default_answer")
      .executeTakeFirstOrThrow();
    expect(row.enabled).toBe(false);
    expect(row.config).toMatchObject({
      sourceScope: { sourceIds: [sourceId] },
      suggestedQuestionsEnabled: false,
      vectorTopK: 9,
      instruction: "Use the selected product handbook.",
      providerKnob: "preserved",
      exposedInputs: { query: true },
    });
    expect(row.config).not.toHaveProperty("similarityThreshold");
    expect(row.config).not.toHaveProperty("customInstruction");
  });
});
