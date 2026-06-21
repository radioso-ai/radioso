import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import {
  ensureLegacyRetrievalColumns,
  runAllTestMigrations,
  testMigrationsPath,
} from "../support/databaseMigrations.js";

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
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const semanticPromptPath = path.resolve(
  __dirname,
  "../../prompts/retrieval/semantic-rewrite-instructions.md",
);

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

describeIfDatabase("workspace retrieval settings to agent skill settings migration", () => {
  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;
  let agentRepository: AgentRepository;
  let migrationSql: string;
  let semanticRewriteDefault: string;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accountRepository = new AccountRepository(database.kysely);
    workspaceRepository = new WorkspaceRepository(database);
    agentRepository = new AgentRepository(database);
    await runAllTestMigrations(database);
    // 081 drops the query-time columns 080 reads; re-add them so we can seed the pre-migration
    // schema and exercise 080 against it.
    await ensureLegacyRetrievalColumns(database);
    migrationSql = await readFile(
      path.join(testMigrationsPath, "080_migrate_workspace_retrieval_to_agent_skill_settings.sql"),
      "utf8",
    );
    semanticRewriteDefault = await readFile(semanticPromptPath, "utf8");
  });

  afterAll(async () => {
    await database.close();
  });

  const createWorkspace = async (name: string) => {
    const account = await accountRepository.create({
      name,
      email: `workspace-retrieval-migration-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    return workspaceRepository.create(account.id, name);
  };

  const seedRetrievalSettings = async (
    workspaceId: string,
    input: {
      queryRewriteEnabled?: boolean;
      rerankEnabled?: boolean;
      vectorTopK?: number;
      similarityThreshold?: number;
      rerankTopK?: number;
      customInstruction?: string;
      attributeControls?: Record<string, unknown>;
    } = {},
  ): Promise<void> => {
    await database.pool.query(
      `INSERT INTO retrieval_settings (
         workspace_id,
         query_rewrite_enabled,
         rerank_enabled,
         vector_top_k,
         similarity_threshold,
         rerank_top_k,
         custom_instruction,
         attribute_controls
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        workspaceId,
        input.queryRewriteEnabled ?? false,
        input.rerankEnabled ?? false,
        input.vectorTopK ?? 15,
        input.similarityThreshold ?? 0.2,
        input.rerankTopK ?? 5,
        input.customInstruction ?? "",
        JSON.stringify(input.attributeControls ?? {}),
      ],
    );
  };

  const loadSkillSettings = async (agentIds: string[]): Promise<Map<string, Record<string, unknown>>> => {
    const rows = await database.query<{ id: string; skill_settings: Record<string, unknown> }>(
      "SELECT id, skill_settings FROM agents WHERE id = ANY($1::uuid[])",
      [agentIds],
    );
    return new Map(rows.map((row) => [row.id, row.skill_settings]));
  };

  it("copies only non-default tuned workspace fields onto a zero-config agent", async () => {
    const workspace = await createWorkspace("Tuned Retrieval Workspace");
    const metadataRule = {
      id: "boost-plan",
      field: "plan",
      operator: "equals",
      value: "enterprise",
      effect: "boost",
      enabled: true,
    };
    await seedRetrievalSettings(workspace.id, {
      queryRewriteEnabled: true,
      rerankEnabled: true,
      vectorTopK: 30,
      rerankTopK: 8,
      customInstruction: "Be terse",
      attributeControls: {
        retrievalStrategy: "reasoning",
        metadataRules: [metadataRule],
      },
    });
    const agent = await agentRepository.create(workspace.id, { name: "Zero Config Agent" });

    await database.pool.query(migrationSql);

    const byId = await loadSkillSettings([agent.id]);
    expect(byId.get(agent.id)).toEqual({
      "retrieval.answer": {
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 30,
        rerankTopK: 8,
        customInstruction: "Be terse",
        retrievalStrategy: "reasoning",
        metadataRules: [metadataRule],
      },
    });
    expect((byId.get(agent.id)?.["retrieval.answer"] as Record<string, unknown>)).not.toHaveProperty(
      "suggestedQuestionsCount",
    );
    expect((byId.get(agent.id)?.["retrieval.answer"] as Record<string, unknown>)).not.toHaveProperty(
      "similarityThreshold",
    );
  });

  it("preserves an existing explicit agent key while adding other non-default workspace fields", async () => {
    const workspace = await createWorkspace("Existing Override Workspace");
    await seedRetrievalSettings(workspace.id, {
      queryRewriteEnabled: true,
      vectorTopK: 30,
      customInstruction: "Use citations",
    });
    const agent = await agentRepository.create(workspace.id, {
      name: "Explicit Override Agent",
      skillSettings: {
        "retrieval.answer": {
          vectorTopK: 8,
        },
      },
    });

    await database.pool.query(migrationSql);

    const byId = await loadSkillSettings([agent.id]);
    expect(byId.get(agent.id)).toEqual({
      "retrieval.answer": {
        vectorTopK: 8,
        queryRewriteEnabled: true,
        customInstruction: "Use citations",
      },
    });
  });

  it("leaves agents in an untuned workspace with empty skill settings", async () => {
    const workspace = await createWorkspace("Untuned Retrieval Workspace");
    await seedRetrievalSettings(workspace.id);
    const agent = await agentRepository.create(workspace.id, { name: "Untuned Agent" });

    await database.pool.query(migrationSql);

    const byId = await loadSkillSettings([agent.id]);
    expect(byId.get(agent.id)).toEqual({});
  });

  it("aborts when a workspace with agents has a non-default similarity threshold", async () => {
    const workspace = await createWorkspace("Threshold Guard Workspace");
    await seedRetrievalSettings(workspace.id, { similarityThreshold: 0.35 });
    await agentRepository.create(workspace.id, { name: "Threshold Guard Agent" });

    try {
      await expect(database.pool.query(migrationSql)).rejects.toThrow(
        /071 US4 migration aborted: workspaces with non-default similarity_threshold cannot be migrated per-agent:/,
      );
    } finally {
      await database.pool.query("DELETE FROM workspaces WHERE id = $1", [workspace.id]);
    }
  });

  it("skips default rewrite instructions but migrates custom rewrite instructions", async () => {
    const defaultWorkspace = await createWorkspace("Default Rewrite Workspace");
    await seedRetrievalSettings(defaultWorkspace.id, {
      attributeControls: {
        semanticRewriteInstructions: collapseWhitespace(semanticRewriteDefault),
      },
    });
    const defaultAgent = await agentRepository.create(defaultWorkspace.id, { name: "Default Rewrite Agent" });

    const customWorkspace = await createWorkspace("Custom Rewrite Workspace");
    await seedRetrievalSettings(customWorkspace.id, {
      attributeControls: {
        semanticRewriteInstructions: "Preserve SKU names and compare warranty language.",
      },
    });
    const customAgent = await agentRepository.create(customWorkspace.id, { name: "Custom Rewrite Agent" });

    await database.pool.query(migrationSql);

    const byId = await loadSkillSettings([defaultAgent.id, customAgent.id]);
    expect(byId.get(defaultAgent.id)).toEqual({});
    expect(byId.get(customAgent.id)).toEqual({
      "retrieval.answer": {
        semanticRewriteInstructions: "Preserve SKU names and compare warranty language.",
      },
    });
  });
});
