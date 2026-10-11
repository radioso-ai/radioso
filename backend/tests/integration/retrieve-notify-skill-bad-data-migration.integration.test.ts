import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { applyTestMigration, runTestMigrationsBefore } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migration110 = "110_retrieve_skills_spine.sql";
const migration111 = "111_notify_and_completion_export_skills.sql";

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) return false;
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const isolatedDatabaseUrl = (baseUrl: string, databaseName: string): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("retrieve and notify skill bad-data migrations", () => {
  const databaseName = `mig110_111_${randomUUID().replace(/-/g, "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedDatabaseUrl(integrationDatabaseUrl!, databaseName));
    await runTestMigrationsBefore(database, "110_conversation_channel_context.sql");
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  const seedAgent = async (behaviorSettings: Record<string, unknown>): Promise<{
    agentId: string;
    workspaceId: string;
  }> => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Account', $2, 'hash')",
      [accountId, `mig110-111-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Workspace', $3)",
      [workspaceId, accountId, `route-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO agents (id, workspace_id, name, behavior_settings) VALUES ($1, $2, 'Agent', $3::jsonb)",
      [agentId, workspaceId, JSON.stringify(behaviorSettings)],
    );
    return { agentId, workspaceId };
  };

  const seedPublishedCompletionExport = async (agentId: string, workspaceId: string): Promise<void> => {
    const destinationId = randomUUID();
    const definitionId = randomUUID();
    await database.execute(
      `INSERT INTO workspace_webhook_destinations (
         id, workspace_id, name, url, secret_ciphertext, encryption_key_id
       ) VALUES ($1, $2, 'Completion export', 'https://example.test/export', 'ciphertext', 'test-key')`,
      [destinationId, workspaceId],
    );
    await database.execute(
      `INSERT INTO routine_definition (
         id, agent_id, lineage_id, version, name, status, activation_trigger_description
       ) VALUES ($1, $2, $3, 1, 'Export routine', 'published', 'Export a completion')`,
      [definitionId, agentId, randomUUID()],
    );
    await database.execute(
      `INSERT INTO routine_completion_export (definition_id, enabled, trigger_kinds, destination_ref)
       VALUES ($1, TRUE, ARRAY['complete'], $2)`,
      [definitionId, destinationId],
    );
  };

  it("treats malformed boolean and integer settings as absent while preserving well-formed values", async () => {
    const malformed = await seedAgent({
      suggestedQuestionsEnabled: "yes",
      suggestedQuestionsCount: 1.5,
      contactRequestsEnabled: "true",
      webhookExportsEnabled: "false",
    });
    const stringNumber = await seedAgent({
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: "3",
      contactRequestsEnabled: false,
      webhookExportsEnabled: false,
    });
    const wellFormed = await seedAgent({
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 3,
      contactRequestsEnabled: true,
      webhookExportsEnabled: false,
    });
    await seedPublishedCompletionExport(malformed.agentId, malformed.workspaceId);

    await expect(applyTestMigration(database, migration110)).resolves.toBeUndefined();
    await expect(applyTestMigration(database, migration111)).resolves.toBeUndefined();

    const retrieveSkills = await database.query<{
      agent_id: string;
      config: Record<string, unknown>;
    }>(
      `SELECT agent_id, config
       FROM agent_skills
       WHERE agent_id = ANY($1::uuid[]) AND skill_name = 'answer'
       ORDER BY agent_id`,
      [[malformed.agentId, stringNumber.agentId, wellFormed.agentId]],
    );
    const retrieveConfigByAgent = new Map(retrieveSkills.map((skill) => [skill.agent_id, skill.config]));

    expect(retrieveConfigByAgent.get(malformed.agentId)).toMatchObject({
      sourceScope: "all",
      suggestedQuestionsEnabled: true,
      exposedInputs: { query: true },
    });
    expect(retrieveConfigByAgent.get(malformed.agentId)).not.toHaveProperty("suggestedQuestionsCount");
    expect(retrieveConfigByAgent.get(stringNumber.agentId)).not.toHaveProperty("suggestedQuestionsCount");
    expect(retrieveConfigByAgent.get(wellFormed.agentId)).toEqual({
      sourceScope: "all",
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 3,
      exposedInputs: { query: true },
    });

    const contactSkills = await database.query<{ agent_id: string; enabled: boolean }>(
      `SELECT agent_id, enabled
       FROM agent_skills
       WHERE agent_id = ANY($1::uuid[]) AND skill_name = 'contact_human'
       ORDER BY agent_id`,
      [[malformed.agentId, wellFormed.agentId]],
    );
    expect(contactSkills).toEqual([{ agent_id: wellFormed.agentId, enabled: true }]);

    const completionExportSkills = await database.query<{ agent_id: string }>(
      `SELECT agent_id
       FROM agent_skills
       WHERE agent_id = $1 AND skill_name = 'completion_export'`,
      [malformed.agentId],
    );
    expect(completionExportSkills).toEqual([]);
  });

  it("rejects a differently named default-answer skill before it hits the partial unique index", async () => {
    const { agentId, workspaceId } = await seedAgent({});
    await database.execute(
      `INSERT INTO agent_skills (
         id, workspace_id, agent_id, skill_name, kind, target_type, target_id, config, invocation_mode, enabled
       ) VALUES ($1, $2, $3, 'another_answer', 'retrieve', 'source_scope', NULL, '{}'::jsonb, 'default_answer', TRUE)`,
      [randomUUID(), workspaceId, agentId],
    );

    await expect(applyTestMigration(database, migration110)).rejects.toThrow(
      /already have a default-answer skill named other than "answer"/,
    );
  });
});
