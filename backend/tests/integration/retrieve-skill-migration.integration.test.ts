import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { testMigrationsPath } from "../support/databaseMigrations.js";

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

describeIfDatabase("retrieve skills spine migration", () => {
  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;
  let agentRepository: AgentRepository;
  let migrationSql: string;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accountRepository = new AccountRepository(database);
    workspaceRepository = new WorkspaceRepository(database);
    agentRepository = new AgentRepository(database);
    await database.pool.query(await readFile(path.join(testMigrationsPath, "109_agent_skills_invocation_mode.sql"), "utf8"));
    migrationSql = await readFile(path.join(testMigrationsPath, "110_retrieve_skills_spine.sql"), "utf8");
  });

  afterAll(async () => {
    await database.close();
  });

  const createWorkspace = async () => {
    const account = await accountRepository.create({
      name: "Retrieve Skill Migration",
      email: `retrieve-skill-migration-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    return workspaceRepository.create(account.id, "Retrieve Skill Migration");
  };

  it("projects each agent's retrieval settings into exactly one default-answer retrieve skill idempotently", async () => {
    const workspace = await createWorkspace();
    const sourceId = randomUUID();
    await database.execute(
      `INSERT INTO document_sources (id, workspace_id, name, kind, created_at, updated_at)
       VALUES ($1, $2, 'Events', 'manual', NOW(), NOW())`,
      [sourceId, workspace.id],
    );
    const agent = await agentRepository.create(workspace.id, {
      name: "Events Agent",
      retrievalEnabled: false,
      sourceScope: { mode: "selected", sourceIds: [sourceId] },
      suggestedQuestionsEnabled: false,
      skillSettings: {
        "retrieval.answer": {
          vectorTopK: 9,
          customInstruction: "Use current event documents.",
          similarityThreshold: 0.91,
        },
      },
    });

    await database.pool.query(migrationSql);
    await database.pool.query(migrationSql);

    const rows = await database.query<{
      skill_name: string;
      kind: string;
      invocation_mode: string;
      enabled: boolean;
      target_type: string | null;
      target_id: string | null;
      config: Record<string, unknown>;
    }>(
      `SELECT skill_name, kind, invocation_mode, enabled, target_type, target_id, config
       FROM agent_skills
       WHERE agent_id = $1 AND kind = 'retrieve'`,
      [agent.id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      skill_name: "answer",
      kind: "retrieve",
      invocation_mode: "default_answer",
      enabled: false,
      target_type: "source_scope",
      target_id: null,
    });
    expect(rows[0]?.config).toMatchObject({
      sourceScope: { sourceIds: [sourceId] },
      suggestedQuestionsEnabled: false,
      vectorTopK: 9,
      instruction: "Use current event documents.",
      exposedInputs: { query: true },
    });
    expect(rows[0]?.config).not.toHaveProperty("similarityThreshold");
  });
});
