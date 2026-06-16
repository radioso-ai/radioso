import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient } from "pg";

import { testMigrationsPath } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) return false;
  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

const hasDatabase = await canReach(integrationDatabaseUrl);
const describeIfDatabase = hasDatabase ? describe : describe.skip;

const applyMigration = async (client: PoolClient, file: string): Promise<void> => {
  await client.query(await readFile(path.join(testMigrationsPath, file), "utf8"));
};

describeIfDatabase("agent skill target cascade triggers (postgres)", () => {
  const schema = `test_agent_skill_cascade_${randomUUID().replace(/-/g, "")}`;

  let pool: pg.Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE workspaces (id UUID PRIMARY KEY);
      CREATE TABLE agents (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE routine_definition (
        id UUID PRIMARY KEY,
        agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);
    await applyMigration(client, "089_workspace_webhook_destinations.sql");
    await applyMigration(client, "093_external_skills.sql");
    await applyMigration(client, "094_external_skills_oauth_flow.sql");
    await applyMigration(client, "099_agent_skills_spine.sql");
    await applyMigration(client, "101_agent_skills_generic_targets.sql");
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("allows deleting a workspace that owns a webhook skill and destination", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const destinationId = randomUUID();
    const skillId = randomUUID();

    await client.query(`INSERT INTO workspaces (id) VALUES ($1)`, [workspaceId]);
    await client.query(`INSERT INTO agents (id, workspace_id) VALUES ($1, $2)`, [agentId, workspaceId]);
    await client.query(
      `INSERT INTO workspace_webhook_destinations
         (id, workspace_id, name, url, secret_ciphertext, encryption_key_id)
       VALUES ($1, $2, 'Lead webhook', 'https://hooks.example.com/leads', 'ciphertext', 'k1')`,
      [destinationId, workspaceId],
    );
    await client.query(
      `INSERT INTO agent_skills
         (id, agent_id, workspace_id, skill_name, kind, target_type, target_id, config)
       VALUES ($1, $2, $3, 'send_lead_webhook', 'webhook', 'webhook_destination', $4, $5::jsonb)`,
      [skillId, agentId, workspaceId, destinationId, JSON.stringify({ boundPayload: {}, exposedPayload: {} })],
    );

    await expect(client.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId])).resolves.toBeDefined();

    expect((await client.query(`SELECT 1 FROM agent_skills WHERE id = $1`, [skillId])).rowCount).toBe(0);
    expect((await client.query(`SELECT 1 FROM workspace_webhook_destinations WHERE id = $1`, [destinationId])).rowCount).toBe(0);
  });

  it("allows deleting an agent that owns an MCP skill and connection", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const connectionId = randomUUID();
    const skillId = randomUUID();

    await client.query(`INSERT INTO workspaces (id) VALUES ($1)`, [workspaceId]);
    await client.query(`INSERT INTO agents (id, workspace_id) VALUES ($1, $2)`, [agentId, workspaceId]);
    await client.query(
      `INSERT INTO mcp_connections (id, agent_id, display_name, server_url, auth_method)
       VALUES ($1, $2, 'Support MCP', 'https://mcp.example.com', 'access_token')`,
      [connectionId, agentId],
    );
    await client.query(
      `INSERT INTO agent_skills
         (id, agent_id, workspace_id, skill_name, kind, target_type, target_id, config)
       VALUES ($1, $2, $3, 'post_to_mcp', 'external_mcp', 'mcp_connection', $4, $5::jsonb)`,
      [skillId, agentId, workspaceId, connectionId, JSON.stringify({ toolName: "post_message" })],
    );

    await expect(client.query(`DELETE FROM agents WHERE id = $1`, [agentId])).resolves.toBeDefined();

    expect((await client.query(`SELECT 1 FROM agent_skills WHERE id = $1`, [skillId])).rowCount).toBe(0);
    expect((await client.query(`SELECT 1 FROM mcp_connections WHERE id = $1`, [connectionId])).rowCount).toBe(0);
  });
});
