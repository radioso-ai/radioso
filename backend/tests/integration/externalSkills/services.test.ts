import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient, type QueryResultRow } from "pg";

import { McpConnectionRepository } from "../../../src/db/repositories/mcpConnectionRepository.js";
import { ExternalSkillDefinitionRepository } from "../../../src/db/repositories/externalSkillDefinitionRepository.js";
import { McpConnectionService } from "../../../src/modules/externalSkills/services/mcpConnectionService.js";
import { ExternalSkillDefinitionService } from "../../../src/modules/externalSkills/services/externalSkillDefinitionService.js";
import { SdkMcpToolService } from "../../../src/modules/externalSkills/toolService/sdkMcpToolService.js";
import type { ToolServiceFactory } from "../../../src/modules/externalSkills/executor/mcpSkillExecutor.js";
import type { Database } from "../../../src/shared/infra/database.js";
import { connectMockMcpServer } from "../../support/mockMcpServer.js";
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

const describeIfDatabase = (await canReach(integrationDatabaseUrl)) ? describe : describe.skip;

const clientBackedDatabase = (client: PoolClient): Database =>
  ({
    pool: {} as Database["pool"],
    async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await client.query<T>(text, params)).rows;
    },
    async execute(text: string, params: unknown[] = []): Promise<number> {
      return (await client.query(text, params)).rowCount ?? 0;
    },
  }) as Database;

const DISCOVERED = [
  {
    name: "post_message",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string" }, message: { type: "string" } },
      required: ["channel", "message"],
    },
    respond: () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  },
];

// Each discovery builds a fresh client over a fresh mock server.
const mockToolServiceFactory: ToolServiceFactory = {
  create: () =>
    new SdkMcpToolService({
      transportFactory: async () => (await connectMockMcpServer(DISCOVERED)).clientTransport,
    }),
};

describeIfDatabase("external skills services (postgres)", () => {
  const schema = `test_extskillsvc_${randomUUID().replace(/-/g, "")}`;
  const encryptionKey = Buffer.alloc(32, 5).toString("base64");
  const workspaceId = randomUUID();
  const agentId = randomUUID();

  let pool: pg.Pool;
  let client: PoolClient;
  let connections: McpConnectionService;
  let skills: ExternalSkillDefinitionService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE workspaces (id UUID PRIMARY KEY);
      CREATE TABLE agents (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE);
    `);
    await client.query(await readFile(path.join(testMigrationsPath, "093_external_skills.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "094_external_skills_oauth_flow.sql"), "utf8"));
    // 099 re-homes external_skill_definitions onto the shared agent_skills spine.
    await client.query(await readFile(path.join(testMigrationsPath, "099_agent_skills_spine.sql"), "utf8"));
    await client.query(`INSERT INTO workspaces (id) VALUES ($1)`, [workspaceId]);
    await client.query(`INSERT INTO agents (id, workspace_id) VALUES ($1, $2)`, [agentId, workspaceId]);

    const database = clientBackedDatabase(client);
    connections = new McpConnectionService({
      repository: new McpConnectionRepository(database),
      toolServiceFactory: mockToolServiceFactory,
      encryptionKey,
      encryptionKeyId: "k1",
    });
    skills = new ExternalSkillDefinitionService(new ExternalSkillDefinitionRepository(database), connections);
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  const newConnection = () =>
    connections.create(agentId, {
      displayName: "Slack",
      serverUrl: "https://mcp.example.com",
      authMethod: "access_token",
      accessToken: "xoxb-secret",
    });

  it("creates a connection without ever exposing the credential", async () => {
    const summary = await newConnection();
    expect(summary.status).toBe("authorized");
    expect(summary.hasCredential).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("xoxb-secret");

    const listed = await connections.list(agentId);
    expect(listed.some((c) => c.id === summary.id)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("xoxb-secret");
  });

  it("discovers the connection's tools", async () => {
    const connection = await newConnection();
    const tools = await connections.discoverTools(agentId, connection.id);
    expect(tools.map((t) => t.name)).toContain("post_message");
  });

  it("creates a skill definition after validating it against discovery", async () => {
    const connection = await newConnection();
    const view = await skills.create(agentId, {
      skillName: "handoff_slack",
      connectionId: connection.id,
      toolName: "post_message",
      boundParams: { channel: "#support" },
      exposedParams: { message: {} },
      enabled: true,
    });
    expect(view).toMatchObject({ skillName: "handoff_slack", toolName: "post_message" });
  });

  it("rejects a skill bound to a tool the server does not expose", async () => {
    const connection = await newConnection();
    await expect(
      skills.create(agentId, {
        skillName: "bad_tool",
        connectionId: connection.id,
        toolName: "nonexistent",
        boundParams: {},
        exposedParams: {},
        enabled: true,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a skill that does not cover the tool's required inputs", async () => {
    const connection = await newConnection();
    await expect(
      skills.create(agentId, {
        skillName: "missing_required",
        connectionId: connection.id,
        toolName: "post_message",
        boundParams: { channel: "#x" },
        exposedParams: {}, // message (required) neither bound nor exposed
        enabled: true,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a duplicate skill name and blocks deleting a referenced connection", async () => {
    const connection = await newConnection();
    const base = {
      connectionId: connection.id,
      toolName: "post_message",
      boundParams: { channel: "#support" },
      exposedParams: { message: {} },
      enabled: true,
    };
    await skills.create(agentId, { ...base, skillName: "dup" });
    await expect(skills.create(agentId, { ...base, skillName: "dup" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(connections.remove(agentId, connection.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("updates a connection (rename + rotate token) and a skill (disable + re-bind)", async () => {
    const connection = await newConnection();
    const renamed = await connections.update(agentId, connection.id, { displayName: "Renamed", accessToken: "rotated-token" });
    expect(renamed.displayName).toBe("Renamed");
    expect(renamed.hasCredential).toBe(true);

    const skill = await skills.create(agentId, {
      skillName: "updatable",
      connectionId: connection.id,
      toolName: "post_message",
      boundParams: { channel: "#x" },
      exposedParams: { message: {} },
      enabled: true,
    });
    const disabled = await skills.update(agentId, skill.id, { enabled: false });
    expect(disabled.enabled).toBe(false);

    // Re-binding is re-validated against discovery: an unknown param is rejected.
    await expect(
      skills.update(agentId, skill.id, { boundParams: { ghost: "x" }, exposedParams: { message: {} } }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("persists outcomeMap updates and returns them from get", async () => {
    const connection = await newConnection();
    const skill = await skills.create(agentId, {
      skillName: "outcome_map_editable",
      connectionId: connection.id,
      toolName: "post_message",
      boundParams: { channel: "#x" },
      exposedParams: { message: {} },
      outcomeMap: { ok: "completed" },
      enabled: true,
    });

    const updated = await skills.update(agentId, skill.id, { outcomeMap: { ok: "sent", fallback: "failed" } });
    expect(updated.outcomeMap).toEqual({ ok: "sent", fallback: "failed" });

    const fetched = await skills.get(agentId, skill.id);
    expect(fetched.outcomeMap).toEqual({ ok: "sent", fallback: "failed" });
  });
});
