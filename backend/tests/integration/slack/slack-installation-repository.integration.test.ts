import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient } from "pg";

import {
  SlackChannelBindingRepository,
  SlackInstallationRepository,
} from "../../../src/modules/slack/install/slackInstallationService.js";
import { createKyselyDatabase } from "../../../src/shared/infra/kysely/kyselyDatabase.js";
import { testMigrationsPath } from "../../support/databaseMigrations.js";

// Real-Postgres characterization of the SlackInstallationRepository and
// SlackChannelBindingRepository after migration from raw `pg` to Kysely. The upsert
// ON CONFLICT semantics (team_id / installation_id), ORDER BY updated_at, DB-clock
// timestamps, and RETURNING projections are the spec the rewrite must preserve.

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

const asPool = (client: PoolClient): pg.Pool =>
  ({
    async connect() {
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "release") return () => undefined;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  }) as unknown as pg.Pool;

describeIfDatabase("slack installation + binding repositories (postgres, kysely)", () => {
  const schema = `test_slack_install_${randomUUID().replace(/-/g, "")}`;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const oauthConnectionId = randomUUID();
  const slackConnectionId = randomUUID();

  let pool: pg.Pool;
  let client: PoolClient;
  let installations: SlackInstallationRepository;
  let bindings: SlackChannelBindingRepository;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE workspaces (id UUID PRIMARY KEY)`);
    await client.query(
      `CREATE TABLE agents (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE)`,
    );
    await client.query(await readFile(path.join(testMigrationsPath, "095_integration_oauth_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "105_integration_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "107_slack_keystone.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "112_slack_gap_escalation_optin.sql"), "utf8"));

    await client.query(`INSERT INTO workspaces (id) VALUES ($1)`, [workspaceId]);
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

    const kysely = createKyselyDatabase(asPool(client));
    installations = new SlackInstallationRepository(kysely);
    bindings = new SlackChannelBindingRepository(kysely);
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("upserts an installation, then updates the same row on team_id conflict", async () => {
    const created = await installations.upsert({
      connectionId: slackConnectionId,
      workspaceId,
      teamId: "TEAM1",
      teamName: "Acme",
      botUserId: "UBOT1",
    });
    expect(created).toMatchObject({
      connectionId: slackConnectionId,
      workspaceId,
      teamId: "TEAM1",
      teamName: "Acme",
      botUserId: "UBOT1",
    });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);

    const updated = await installations.upsert({
      connectionId: slackConnectionId,
      workspaceId,
      teamId: "TEAM1",
      teamName: "Acme Renamed",
      botUserId: "UBOT2",
    });
    // Same row (team_id is the conflict target), fields replaced from EXCLUDED.
    expect(updated.id).toBe(created.id);
    expect(updated.teamName).toBe("Acme Renamed");
    expect(updated.botUserId).toBe("UBOT2");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it("finds an installation by id, team id, and most-recent-by-workspace", async () => {
    const byId = await installations.findByTeamId("TEAM1");
    expect(byId).not.toBeNull();
    expect((await installations.findById(byId!.id))?.id).toBe(byId!.id);

    const byWorkspace = await installations.findByWorkspaceId(workspaceId);
    expect(byWorkspace?.id).toBe(byId!.id);

    expect(await installations.findByTeamId("nope")).toBeNull();
    expect(await installations.findByWorkspaceId(randomUUID())).toBeNull();
  });

  it("upserts a binding, then updates the same row on installation_id conflict", async () => {
    const installation = await installations.findByTeamId("TEAM1");
    const created = await bindings.upsert({
      installationId: installation!.id,
      workspaceId,
      answeringAgentId: agentId,
      escalationChannelId: "C123",
    });
    expect(created).toMatchObject({
      installationId: installation!.id,
      workspaceId,
      answeringAgentId: agentId,
      escalationChannelId: "C123",
      gapEscalationEnabled: false,
    });

    const updated = await bindings.upsert({
      installationId: installation!.id,
      workspaceId,
      answeringAgentId: agentId,
      escalationChannelId: null,
      gapEscalationEnabled: true,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.escalationChannelId).toBeNull();
    expect(updated.gapEscalationEnabled).toBe(true);

    expect(await bindings.findByInstallationId(installation!.id)).toMatchObject({
      id: created.id,
      gapEscalationEnabled: true,
    });
  });

  it("removes binding then installation and reports the deletions", async () => {
    const installation = await installations.findByTeamId("TEAM1");
    expect(await bindings.removeByInstallationId(installation!.id)).toBe(true);
    expect(await bindings.removeByInstallationId(installation!.id)).toBe(false);
    expect(await bindings.findByInstallationId(installation!.id)).toBeNull();

    expect(await installations.removeByWorkspaceId(workspaceId)).toBe(true);
    expect(await installations.removeByWorkspaceId(workspaceId)).toBe(false);
    expect(await installations.findByWorkspaceId(workspaceId)).toBeNull();
  });
});
