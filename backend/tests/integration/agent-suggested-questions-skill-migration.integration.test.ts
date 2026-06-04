import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { RetrievalSettingsRepository } from "../../src/db/repositories/retrievalSettingsRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations, testMigrationsPath } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }
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

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

describeIfDatabase("agent suggested questions skill settings migration", () => {
  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;
  let retrievalSettingsRepository: RetrievalSettingsRepository;
  let agentRepository: AgentRepository;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accountRepository = new AccountRepository(database);
    workspaceRepository = new WorkspaceRepository(database);
    retrievalSettingsRepository = new RetrievalSettingsRepository(database);
    agentRepository = new AgentRepository(database);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  it("moves divergent legacy agent values into retrieval.answer and leaves matching values inherited", async () => {
    const account = await accountRepository.create({
      name: "Suggested Questions Migration",
      email: `sq-migration-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Suggested Questions Workspace");
    await retrievalSettingsRepository.upsert(workspace.id, {
      queryRewriteEnabled: true,
      semanticRewriteInstructions: "",
      lexicalRewriteInstructions: "",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      rerankEnabled: false,
      vectorTopK: 20,
      similarityThreshold: 0.2,
      rerankTopK: 5,
      metadataRules: [],
      customInstruction: "",
    });
    const divergent = await agentRepository.create(workspace.id, {
      name: "Divergent",
      suggestedQuestionsEnabled: false,
      skillSettings: {
        "retrieval.answer": {
          vectorTopK: 8,
        },
      },
    });
    const inherited = await agentRepository.create(workspace.id, {
      name: "Inherited",
      suggestedQuestionsEnabled: true,
      skillSettings: {
        "retrieval.answer": {
          suggestedQuestionsEnabled: false,
        },
      },
    });

    const migrationSql = await readFile(
      path.join(testMigrationsPath, "075_agent_suggested_questions_skill_override.sql"),
      "utf8",
    );
    await database.pool.query(migrationSql);

    const rows = await database.query<{ id: string; skill_settings: Record<string, unknown> }>(
      "SELECT id, skill_settings FROM agents WHERE id = ANY($1::uuid[]) ORDER BY name ASC",
      [[divergent.id, inherited.id]],
    );
    const byId = new Map(rows.map((row) => [row.id, row.skill_settings]));

    expect(byId.get(divergent.id)).toEqual({
      "retrieval.answer": {
        vectorTopK: 8,
        suggestedQuestionsEnabled: false,
      },
    });
    expect(byId.get(inherited.id)).toEqual({});
  });
});
