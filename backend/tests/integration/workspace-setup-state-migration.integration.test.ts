import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient } from "pg";

import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { WorkspaceSetupStateRepository } from "../../src/db/repositories/workspaceSetupStateRepository.js";
import { WorkspaceSummaryService } from "../../src/modules/workspace/services/workspaceSummaryService.js";
import { Database } from "../../src/shared/infra/database.js";
import { testMigrationsPath } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const describeIfDatabase = integrationDatabaseUrl ? describe : describe.skip;

describeIfDatabase("migration 231 workspace setup state", () => {
  const schema = `test_workspace_setup_231_${randomUUID().replaceAll("-", "")}`;
  const workspaceId = randomUUID();
  let pool: pg.Pool;
  let client: PoolClient;
  let database: Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE workspaces (id UUID PRIMARY KEY);
      CREATE TABLE documents (id UUID PRIMARY KEY, workspace_id UUID NOT NULL, status TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}');
      CREATE TABLE conversations (id UUID PRIMARY KEY, workspace_id UUID NOT NULL);
      CREATE TABLE agents (id UUID PRIMARY KEY, workspace_id UUID NOT NULL);
      CREATE TABLE agent_directives (id UUID PRIMARY KEY, agent_id UUID NOT NULL);
      CREATE TABLE routine_definition (id UUID PRIMARY KEY, agent_id UUID NOT NULL);
      CREATE TABLE workspace_webhook_destinations (id UUID PRIMARY KEY, workspace_id UUID NOT NULL, last_delivery_status TEXT);
      CREATE TABLE api_credentials (id UUID PRIMARY KEY, workspace_id UUID NOT NULL, revoked_at TIMESTAMPTZ, expires_at TIMESTAMPTZ);
    `);
    await client.query("INSERT INTO workspaces (id) VALUES ($1)", [workspaceId]);
    await client.query(
      "INSERT INTO documents (id, workspace_id, status, metadata) VALUES ($1, $2, 'ready', '{}'::jsonb)",
      [randomUUID(), workspaceId],
    );
    await client.query(await readFile(path.join(testMigrationsPath, "231_workspace_setup_state.sql"), "utf8"));
    const schemaUrl = new URL(integrationDatabaseUrl!);
    schemaUrl.searchParams.set("options", `-c search_path=${schema},public`);
    database = new Database(schemaUrl.toString());
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("grandfathers a pre-existing workspace with documents out of first run", async () => {
    const service = new WorkspaceSummaryService(
      new DocumentRepository(database.kysely),
      new ConversationRepository(database.kysely),
      new WorkspaceSetupStateRepository(database.kysely),
    );

    await expect(service.getSummary(workspaceId)).resolves.toMatchObject({
      hasDocuments: true,
      setup: { dismissed: true, shouldShowFirstRun: false },
    });
  });
});
