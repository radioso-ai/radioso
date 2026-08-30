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

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("context variable enablement reference migration (postgres)", () => {
  const schema = `test_context_variable_references_${randomUUID().replaceAll("-", "")}`;
  const historicalEnablementId = randomUUID();

  let pool: pg.Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE agents (id UUID PRIMARY KEY);
      CREATE TABLE agent_skills (id UUID PRIMARY KEY);
      CREATE TABLE agent_context_variables (
        id UUID PRIMARY KEY,
        agent_id UUID NOT NULL,
        variable_id UUID NOT NULL,
        resolver_skill_id UUID
      );
    `);
    await client.query(
      `INSERT INTO agent_context_variables (id, agent_id, variable_id, resolver_skill_id)
       VALUES ($1, $2, $3, $4)`,
      [historicalEnablementId, randomUUID(), randomUUID(), randomUUID()],
    );
    await client.query(await readFile(
      path.join(testMigrationsPath, "154_context_variable_enablement_references.sql"),
      "utf8",
    ));
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("preserves historical orphans while enforcing new references and cascades", async () => {
    const constraints = await client.query<{ conname: string; convalidated: boolean }>(`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conrelid = 'agent_context_variables'::regclass
        AND conname IN (
          'agent_context_variables_agent_id_fkey',
          'agent_context_variables_resolver_skill_id_fkey'
        )
      ORDER BY conname
    `);
    expect(constraints.rows).toEqual([
      { conname: "agent_context_variables_agent_id_fkey", convalidated: false },
      { conname: "agent_context_variables_resolver_skill_id_fkey", convalidated: false },
    ]);
    expect((await client.query(
      `SELECT 1 FROM agent_context_variables WHERE id = $1`,
      [historicalEnablementId],
    )).rowCount).toBe(1);

    await expect(client.query(
      `INSERT INTO agent_context_variables (id, agent_id, variable_id)
       VALUES ($1, $2, $3)`,
      [randomUUID(), randomUUID(), randomUUID()],
    )).rejects.toMatchObject({ code: "23503" });

    const agentId = randomUUID();
    await client.query(`INSERT INTO agents (id) VALUES ($1)`, [agentId]);
    await expect(client.query(
      `INSERT INTO agent_context_variables (id, agent_id, variable_id, resolver_skill_id)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), agentId, randomUUID(), randomUUID()],
    )).rejects.toMatchObject({ code: "23503" });

    const resolverSkillId = randomUUID();
    const resolverEnablementId = randomUUID();
    await client.query(`INSERT INTO agent_skills (id) VALUES ($1)`, [resolverSkillId]);
    await client.query(
      `INSERT INTO agent_context_variables (id, agent_id, variable_id, resolver_skill_id)
       VALUES ($1, $2, $3, $4)`,
      [resolverEnablementId, agentId, randomUUID(), resolverSkillId],
    );
    await client.query(`DELETE FROM agent_skills WHERE id = $1`, [resolverSkillId]);
    expect((await client.query(
      `SELECT 1 FROM agent_context_variables WHERE id = $1`,
      [resolverEnablementId],
    )).rowCount).toBe(0);

    const agentEnablementId = randomUUID();
    await client.query(
      `INSERT INTO agent_context_variables (id, agent_id, variable_id)
       VALUES ($1, $2, $3)`,
      [agentEnablementId, agentId, randomUUID()],
    );
    await client.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    expect((await client.query(
      `SELECT 1 FROM agent_context_variables WHERE id = $1`,
      [agentEnablementId],
    )).rowCount).toBe(0);
  });
});
