import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient } from "pg";

import { SlackSkillDefinitionRepository } from "../../../src/modules/slackSkills/repository.js";
import { createKyselyDatabase } from "../../../src/shared/infra/kysely/kyselyDatabase.js";
import { testMigrationsPath } from "../../support/databaseMigrations.js";

// Real-Postgres characterization of the SlackSkillDefinitionRepository after migration
// from raw `pg` to Kysely. It stores onto the agent_skills spine with kind='slack' and
// target_type='slack_installation'; the COALESCE update semantics (enabled stays when
// omitted, config shallow-merge), kind-scoped filters, and ORDER BY skill_name are the
// spec the rewrite must preserve.

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

describeIfDatabase("slack skill definition repository (postgres, kysely)", () => {
  const schema = `test_slack_skills_${randomUUID().replace(/-/g, "")}`;
  const workspaceId = randomUUID();
  const otherAgentId = randomUUID();
  const agentId = randomUUID();
  const oauthConnectionId = randomUUID();
  const slackConnectionId = randomUUID();
  const installationId = randomUUID();

  let pool: pg.Pool;
  let client: PoolClient;
  let repository: SlackSkillDefinitionRepository;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE workspaces (id UUID PRIMARY KEY)`);
    await client.query(
      `CREATE TABLE agents (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE)`,
    );
    const migrations = [
      "093_external_skills.sql",
      "094_external_skills_oauth_flow.sql",
      "095_integration_oauth_connections.sql",
      "096_customer_email_connections.sql",
      "097_email_skill_definitions.sql",
      "098_email_skill_activity.sql",
      "099_agent_skills_spine.sql",
      "100_email_skills_into_spine.sql",
      "101_agent_skills_generic_targets.sql",
      "105_integration_connections.sql",
      "106_customer_email_connections_to_integration_connections.sql",
      "107_slack_keystone.sql",
      "108_slack_agent_skill_kind.sql",
    ];
    for (const file of migrations) {
      await client.query(await readFile(path.join(testMigrationsPath, file), "utf8"));
    }

    await client.query(`INSERT INTO workspaces (id) VALUES ($1)`, [workspaceId]);
    await client.query(`INSERT INTO agents (id, workspace_id) VALUES ($1, $2), ($3, $2)`, [
      agentId,
      workspaceId,
      otherAgentId,
    ]);
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
      [installationId, slackConnectionId, workspaceId],
    );

    repository = new SlackSkillDefinitionRepository(createKyselyDatabase(asPool(client)));
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("creates a slack skill on the agent_skills spine and round-trips it", async () => {
    const created = await repository.create({
      workspaceId,
      agentId,
      installationId,
      skillName: "post_to_support",
      boundInputs: { channelId: "C1" },
      exposedInputs: { text: { description: "Message", required: true } },
    });

    expect(created).toMatchObject({
      workspaceId,
      agentId,
      installationId,
      skillName: "post_to_support",
      boundInputs: { channelId: "C1" },
      exposedInputs: { text: { description: "Message", required: true } },
      enabled: true,
    });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);

    // Persisted with the slack discriminators on the shared spine.
    const raw = await client.query(
      `SELECT kind, target_type FROM agent_skills WHERE id = $1`,
      [created.id],
    );
    expect(raw.rows[0]).toMatchObject({ kind: "slack", target_type: "slack_installation" });

    expect((await repository.findById(workspaceId, agentId, created.id))?.id).toBe(created.id);
  });

  it("finds enabled-by-name only while enabled, and lists by agent in skill_name order", async () => {
    const zebra = await repository.create({ workspaceId, agentId, installationId, skillName: "zebra" });
    await repository.create({ workspaceId, agentId, installationId, skillName: "alpha" });

    const found = await repository.findEnabledByName(workspaceId, agentId, "zebra");
    expect(found?.id).toBe(zebra.id);

    await repository.update(workspaceId, agentId, zebra.id, { enabled: false });
    expect(await repository.findEnabledByName(workspaceId, agentId, "zebra")).toBeNull();

    const list = await repository.listByAgent(workspaceId, agentId);
    // Ordered ascending by skill_name; includes the disabled one.
    expect(list.map((s) => s.skillName)).toEqual([...list.map((s) => s.skillName)].sort());
    expect(list.some((s) => s.skillName === "zebra")).toBe(true);
  });

  it("preserves enabled when omitted and shallow-merges config on update", async () => {
    const skill = await repository.create({
      workspaceId,
      agentId,
      installationId,
      skillName: "mergeable",
      boundInputs: { channelId: "C1" },
      exposedInputs: {},
    });

    // Update config only; enabled must stay true (COALESCE semantics).
    const updated = await repository.update(workspaceId, agentId, skill.id, {
      boundInputs: { text: "X" },
    });
    expect(updated?.enabled).toBe(true);
    // Shallow top-level merge: boundInputs object replaced, exposedInputs untouched.
    expect(updated?.boundInputs).toEqual({ text: "X" });
    expect(updated?.exposedInputs).toEqual({});
  });

  it("scopes mutations to the slack kind, agent, and workspace", async () => {
    const skill = await repository.create({ workspaceId, agentId, installationId, skillName: "scoped" });

    // Wrong agent -> not found / no-op
    expect(await repository.findById(workspaceId, otherAgentId, skill.id)).toBeNull();
    expect(await repository.update(workspaceId, otherAgentId, skill.id, { enabled: false })).toBeNull();
    expect(await repository.remove(workspaceId, otherAgentId, skill.id)).toBe(false);

    // Correct scope -> removable, then gone
    expect(await repository.remove(workspaceId, agentId, skill.id)).toBe(true);
    expect(await repository.remove(workspaceId, agentId, skill.id)).toBe(false);
    expect(await repository.findById(workspaceId, agentId, skill.id)).toBeNull();
  });
});
