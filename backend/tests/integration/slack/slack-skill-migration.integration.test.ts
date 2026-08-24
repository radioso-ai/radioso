import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient } from "pg";

import { testMigrationsPath } from "../../support/databaseMigrations.js";

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

describeIfDatabase("Slack skill migration 108 (postgres)", () => {
  const schema = `test_slack_skill_migration_${randomUUID().replace(/-/g, "")}`;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const agentId = randomUUID();
  const oauthConnectionId = randomUUID();
  const slackConnectionId = randomUUID();
  const slackInstallationId = randomUUID();

  let pool: pg.Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE workspaces (id UUID PRIMARY KEY)`);
    await client.query(`CREATE TABLE agents (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE)`);
    // 107_slack_keystone.sql carries an FK to conversations. Stubbing it in this
    // schema keeps the file self-sufficient: resolving it through `public` would
    // make the test depend on another test file having migrated first, which the
    // vitest sequencer does not guarantee.
    await client.query(`CREATE TABLE conversations (id UUID PRIMARY KEY)`);
    await client.query(await readFile(path.join(testMigrationsPath, "093_external_skills.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "094_external_skills_oauth_flow.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "095_integration_oauth_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "096_customer_email_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "097_email_skill_definitions.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "098_email_skill_activity.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "099_agent_skills_spine.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "100_email_skills_into_spine.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "101_agent_skills_generic_targets.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "105_integration_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "106_customer_email_connections_to_integration_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "107_slack_keystone.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "108_slack_agent_skill_kind.sql"), "utf8"));

    await client.query(`INSERT INTO workspaces (id) VALUES ($1), ($2)`, [workspaceId, otherWorkspaceId]);
    await client.query(`INSERT INTO agents (id, workspace_id) VALUES ($1, $2)`, [agentId, workspaceId]);
    await client.query(
      `INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name, status, granted_scopes)
       VALUES ($1, $2, 'slack', 'Slack', 'authorized', ARRAY['chat:write'])`,
      [oauthConnectionId, workspaceId],
    );
    await client.query(
      `INSERT INTO integration_connections (id, workspace_id, oauth_connection_id, provider, display_name, status, config)
       VALUES ($1, $2, $3, 'slack', 'Slack', 'authorized', '{}'::jsonb)`,
      [slackConnectionId, workspaceId, oauthConnectionId],
    );
    await client.query(
      `INSERT INTO slack_installations (id, connection_id, workspace_id, team_id, team_name, bot_user_id)
       VALUES ($1, $2, $3, 'TSKILL', 'Skill Team', 'UBOT')`,
      [slackInstallationId, slackConnectionId, workspaceId],
    );
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("accepts slack skills only when targeting a same-workspace Slack installation", async () => {
    await expect(
      client.query(
        `INSERT INTO agent_skills (id, agent_id, workspace_id, skill_name, kind, target_type, target_id, config)
         VALUES ($1, $2, $3, 'post_to_support', 'slack', 'slack_installation', $4, '{}'::jsonb)`,
        [randomUUID(), agentId, workspaceId, slackInstallationId],
      ),
    ).resolves.toBeDefined();

    await expect(
      client.query(
        `INSERT INTO agent_skills (id, agent_id, workspace_id, skill_name, kind, target_type, target_id, config)
         VALUES ($1, $2, $3, 'bad_target_type', 'slack', 'customer_email_connection', $4, '{}'::jsonb)`,
        [randomUUID(), agentId, workspaceId, slackInstallationId],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      client.query(
        `INSERT INTO agent_skills (id, agent_id, workspace_id, skill_name, kind, target_type, target_id, config)
         VALUES ($1, $2, $3, 'wrong_workspace', 'slack', 'slack_installation', $4, '{}'::jsonb)`,
        [randomUUID(), agentId, otherWorkspaceId, slackInstallationId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
