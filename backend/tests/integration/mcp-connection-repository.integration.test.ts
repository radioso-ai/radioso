import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { McpConnectionRepository } from "../../src/db/repositories/mcpConnectionRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Focused characterization for the OAuth-token methods, the remove() reference guard, and
// workspace ownership, which the externalSkills suite does not fully exercise.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("McpConnectionRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new McpConnectionRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const agentId = randomUUID();
  const secondAgentId = randomUUID();
  const otherWorkspaceAgentId = randomUUID();

  const insertWorkspace = (id: string) =>
    database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      id,
      accountId,
      "Mcp Workspace",
      `route-${id}`,
    ]);

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Mcp Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await insertWorkspace(workspaceId);
    await insertWorkspace(otherWorkspaceId);
    await database.query(`INSERT INTO agents (id, workspace_id) VALUES ($1,$2)`, [agentId, workspaceId]);
    await database.query(`INSERT INTO agents (id, workspace_id) VALUES ($1,$2)`, [secondAgentId, workspaceId]);
    await database.query(`INSERT INTO agents (id, workspace_id) VALUES ($1,$2)`, [
      otherWorkspaceAgentId,
      otherWorkspaceId,
    ]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const create = (owner: string = workspaceId) =>
    repository.create({
      workspaceId: owner,
      displayName: "Server",
      serverUrl: "https://mcp.example.com",
      authMethod: "oauth",
    });

  const bindSkill = (skillAgentId: string, skillWorkspaceId: string, connectionId: string) =>
    database.query(
      `INSERT INTO agent_skills (id, agent_id, workspace_id, skill_name, kind, target_type, target_id)
       VALUES ($1,$2,$3,$4,'external_mcp','mcp_connection',$5)`,
      [randomUUID(), skillAgentId, skillWorkspaceId, `tool_${randomUUID().slice(0, 8)}`, connectionId],
    );

  it("create defaults to unconfigured and find scopes by workspace", async () => {
    const created = await create();
    expect(created).toMatchObject({ workspaceId, status: "unconfigured", oauthFlowCiphertext: null });
    expect((await repository.findById(workspaceId, created.id))?.id).toBe(created.id);
    expect(await repository.findById(otherWorkspaceId, created.id)).toBeNull();
  });

  it("setOauthFlow then setOauthTokens transitions status and clears the flow", async () => {
    const created = await create();
    const withFlow = await repository.setOauthFlow(workspaceId, created.id, "flow-cipher");
    expect(withFlow?.oauthFlowCiphertext).toBe("flow-cipher");

    const authorized = await repository.setOauthTokens(workspaceId, created.id, "cred-cipher");
    expect(authorized).toMatchObject({
      status: "authorized",
      credentialCiphertext: "cred-cipher",
      oauthFlowCiphertext: null,
    });
  });

  it("update applies only the provided fields (presence semantics)", async () => {
    const created = await create();
    const updated = await repository.update(workspaceId, created.id, { displayName: "Renamed" });
    expect(updated).toMatchObject({ displayName: "Renamed", serverUrl: created.serverUrl });

    const status = await repository.updateStatus(workspaceId, created.id, "error");
    expect(status?.status).toBe("error");
  });

  it("remove deletes an unreferenced connection but blocks a referenced one", async () => {
    const created = await create();
    expect(await repository.remove(workspaceId, created.id)).toBe(true);
    expect(await repository.remove(workspaceId, created.id)).toBe(false);

    const referenced = await create();
    await bindSkill(agentId, workspaceId, referenced.id);
    await expect(repository.remove(workspaceId, referenced.id)).rejects.toMatchObject({ code: "23503" });
  });

  it("lets every agent in the workspace bind the same connection", async () => {
    const shared = await create();

    await expect(bindSkill(agentId, workspaceId, shared.id)).resolves.toBeDefined();
    await expect(bindSkill(secondAgentId, workspaceId, shared.id)).resolves.toBeDefined();
  });

  it("rejects a skill that binds another workspace's connection", async () => {
    const foreign = await create(otherWorkspaceId);

    await expect(bindSkill(agentId, workspaceId, foreign.id)).rejects.toMatchObject({ code: "23503" });
  });

  it("blocks removal while a different agent's skill still uses the connection", async () => {
    const shared = await create();
    await bindSkill(secondAgentId, workspaceId, shared.id);

    await expect(repository.remove(workspaceId, shared.id)).rejects.toMatchObject({ code: "23503" });
    await expect(database.query(`DELETE FROM mcp_connections WHERE id = $1`, [shared.id])).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("lists the whole workspace, or only what one agent's skills use", async () => {
    const listWorkspaceId = randomUUID();
    const listAgentId = randomUUID();
    await insertWorkspace(listWorkspaceId);
    await database.query(`INSERT INTO agents (id, workspace_id) VALUES ($1,$2)`, [listAgentId, listWorkspaceId]);
    const used = await create(listWorkspaceId);
    const unused = await create(listWorkspaceId);
    await bindSkill(listAgentId, listWorkspaceId, used.id);

    expect((await repository.listByWorkspace(listWorkspaceId)).map((row) => row.id)).toEqual([used.id, unused.id]);
    expect((await repository.listUsedByAgent(listWorkspaceId, listAgentId)).map((row) => row.id)).toEqual([used.id]);
    expect(await repository.listUsedByAgent(otherWorkspaceId, listAgentId)).toEqual([]);
  });

  it("reports each agent using a connection once, by the name operators know it by", async () => {
    const usageWorkspaceId = randomUUID();
    const namedAgentId = randomUUID();
    const relabelledAgentId = randomUUID();
    await insertWorkspace(usageWorkspaceId);
    await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1,$2,'Billing')`, [
      namedAgentId,
      usageWorkspaceId,
    ]);
    await database.query(`INSERT INTO agents (id, workspace_id, name, internal_name) VALUES ($1,$2,'Claudio','Sales IT')`, [
      relabelledAgentId,
      usageWorkspaceId,
    ]);
    const shared = await create(usageWorkspaceId);
    const other = await create(usageWorkspaceId);
    await bindSkill(namedAgentId, usageWorkspaceId, shared.id);
    await bindSkill(namedAgentId, usageWorkspaceId, shared.id);
    await bindSkill(relabelledAgentId, usageWorkspaceId, shared.id);
    await bindSkill(namedAgentId, usageWorkspaceId, other.id);

    expect(await repository.listAgentUsage(usageWorkspaceId, shared.id)).toEqual([
      { connectionId: shared.id, agentId: namedAgentId, agentName: "Billing" },
      { connectionId: shared.id, agentId: relabelledAgentId, agentName: "Sales IT" },
    ]);
    expect((await repository.listAgentUsage(usageWorkspaceId)).map((row) => row.connectionId).sort()).toEqual(
      [shared.id, shared.id, other.id].sort(),
    );
    expect(await repository.listAgentUsage(otherWorkspaceId, shared.id)).toEqual([]);
  });

  it("keeps the connection when an agent using it is deleted", async () => {
    const departingAgentId = randomUUID();
    await database.query(`INSERT INTO agents (id, workspace_id) VALUES ($1,$2)`, [departingAgentId, workspaceId]);
    const shared = await create();
    await bindSkill(departingAgentId, workspaceId, shared.id);

    await database.query(`DELETE FROM agents WHERE id = $1`, [departingAgentId]);

    expect((await repository.findById(workspaceId, shared.id))?.id).toBe(shared.id);
  });

  // Migrations run while the previous revision still serves, and that revision inserts by agent.
  it("assigns a row written with only an agent_id to that agent's workspace", async () => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO mcp_connections (id, agent_id, display_name, server_url, auth_method)
       VALUES ($1,$2,'Server','https://mcp.example.com','oauth')`,
      [id, agentId],
    );

    expect((await repository.findById(workspaceId, id))?.workspaceId).toBe(workspaceId);
  });
});
