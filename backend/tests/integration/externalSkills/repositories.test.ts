import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient, type QueryResultRow } from "pg";

import { McpConnectionRepository } from "../../../src/db/repositories/mcpConnectionRepository.js";
import { ExternalSkillDefinitionRepository } from "../../../src/db/repositories/externalSkillDefinitionRepository.js";
import { decryptField, encryptField } from "../../../src/shared/infra/crypto/fieldEncryption.js";
import type { Database } from "../../../src/shared/infra/database.js";
import { createKyselyDatabase } from "../../../src/shared/infra/kysely/kyselyDatabase.js";
import { testMigrationsPath } from "../../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) {
    return false;
  }
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

const clientBackedDatabase = (client: PoolClient): Database => {
  const pool = {
    async connect() {
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "release") return () => undefined;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  } as Database["pool"];
  return {
    pool,
    kysely: createKyselyDatabase(pool),
    async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await client.query<T>(text, params)).rows;
    },
    async execute(text: string, params: unknown[] = []): Promise<number> {
      return (await client.query(text, params)).rowCount ?? 0;
    },
  } as Database;
};

describeIfDatabase("external skills repositories (postgres)", () => {
  const schema = `test_extskills_${randomUUID().replace(/-/g, "")}`;
  const encryptionKey = Buffer.alloc(32, 7).toString("base64");
  const workspaceId = randomUUID();
  const agentId = randomUUID();

  let pool: pg.Pool;
  let client: PoolClient;
  let connections: McpConnectionRepository;
  let skills: ExternalSkillDefinitionRepository;

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
    `);
    const migrationSql = await readFile(path.join(testMigrationsPath, "093_external_skills.sql"), "utf8");
    await client.query(migrationSql);
    await client.query(await readFile(path.join(testMigrationsPath, "094_external_skills_oauth_flow.sql"), "utf8"));
    // 099 creates the shared spine; 101 moves detail config onto generic target/config columns.
    await client.query(await readFile(path.join(testMigrationsPath, "099_agent_skills_spine.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "101_agent_skills_generic_targets.sql"), "utf8"));
    await client.query(`INSERT INTO workspaces (id) VALUES ($1)`, [workspaceId]);
    await client.query(`INSERT INTO agents (id, workspace_id) VALUES ($1, $2)`, [agentId, workspaceId]);

    const database = clientBackedDatabase(client);
    connections = new McpConnectionRepository(database.kysely);
    skills = new ExternalSkillDefinitionRepository(database.kysely);
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("round-trips a connection with an encrypted credential", async () => {
    const ciphertext = encryptField("xoxb-secret-token", encryptionKey);
    const created = await connections.create({
      agentId,
      displayName: "Support Slack",
      serverUrl: "https://mcp.example.com",
      authMethod: "access_token",
      credentialCiphertext: ciphertext,
      encryptionKeyId: "k1",
    });
    expect(created.status).toBe("unconfigured");

    const found = await connections.findById(agentId, created.id);
    expect(found?.credentialCiphertext).toBe(ciphertext);
    expect(decryptField(found!.credentialCiphertext!, encryptionKey)).toBe("xoxb-secret-token");
    // never stores plaintext
    expect(found?.credentialCiphertext).not.toContain("xoxb-secret-token");
  });

  it("round-trips an OAuth connection's client config, flow, and tokens", async () => {
    const clientCiphertext = encryptField(JSON.stringify({ clientId: "c1" }), encryptionKey);
    const created = await connections.create({
      agentId,
      displayName: "Scheduler",
      serverUrl: "https://mcp.example.com",
      authMethod: "oauth",
      oauthClientCiphertext: clientCiphertext,
      status: "unconfigured",
    });
    expect(created.status).toBe("unconfigured");
    expect(created.oauthClientCiphertext).toBe(clientCiphertext);
    expect(created.oauthFlowCiphertext).toBeNull();

    const flowCiphertext = encryptField(JSON.stringify({ state: "s", codeVerifier: "v" }), encryptionKey);
    const withFlow = await connections.setOauthFlow(agentId, created.id, flowCiphertext);
    expect(withFlow?.oauthFlowCiphertext).toBe(flowCiphertext);

    const tokenCiphertext = encryptField(JSON.stringify({ accessToken: "at" }), encryptionKey);
    const authorized = await connections.setOauthTokens(agentId, created.id, tokenCiphertext, "k1");
    expect(authorized?.status).toBe("authorized");
    expect(authorized?.credentialCiphertext).toBe(tokenCiphertext);
    // The transient flow is cleared once authorized.
    expect(authorized?.oauthFlowCiphertext).toBeNull();
  });

  it("creates and resolves a skill definition by name, omitting disabled ones", async () => {
    const connection = await connections.create({
      agentId,
      displayName: "Slack 2",
      serverUrl: "https://mcp2.example.com",
      authMethod: "access_token",
    });
    await skills.create({
      agentId,
      connectionId: connection.id,
      skillName: "handoff_slack",
      toolName: "post_message",
      boundParams: { channel: "#support" },
      exposedParams: { message: {} },
    });

    const resolved = await skills.findEnabledByName(agentId, "handoff_slack");
    expect(resolved).toMatchObject({
      skillName: "handoff_slack",
      toolName: "post_message",
      boundParams: { channel: "#support" },
      exposedParams: { message: {} },
      enabled: true,
    });

    const disabled = await skills.create({
      agentId,
      connectionId: connection.id,
      skillName: "disabled_skill",
      toolName: "post_message",
      boundParams: {},
      exposedParams: {},
      enabled: false,
    });
    expect(await skills.findEnabledByName(agentId, "disabled_skill")).toBeNull();
    expect(await skills.findById(agentId, disabled.id)).not.toBeNull();
  });

  it("blocks deleting a connection that a skill definition still references", async () => {
    const connection = await connections.create({
      agentId,
      displayName: "Referenced",
      serverUrl: "https://mcp3.example.com",
      authMethod: "access_token",
    });
    const skill = await skills.create({
      agentId,
      connectionId: connection.id,
      skillName: "ref_skill",
      toolName: "t",
      boundParams: {},
      exposedParams: {},
    });

    await expect(connections.remove(agentId, connection.id)).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query(`DELETE FROM mcp_connections WHERE agent_id = $1 AND id = $2`, [agentId, connection.id]),
    ).rejects.toMatchObject({ code: "23503" });

    expect(await skills.remove(agentId, skill.id)).toBe(true);
    expect(await connections.remove(agentId, connection.id)).toBe(true);
  });

  it("enforces unique skill name per agent", async () => {
    const connection = await connections.create({
      agentId,
      displayName: "Unique",
      serverUrl: "https://mcp4.example.com",
      authMethod: "access_token",
    });
    await skills.create({
      agentId,
      connectionId: connection.id,
      skillName: "dup_skill",
      toolName: "t",
      boundParams: {},
      exposedParams: {},
    });
    await expect(
      skills.create({
        agentId,
        connectionId: connection.id,
        skillName: "dup_skill",
        toolName: "t",
        boundParams: {},
        exposedParams: {},
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
