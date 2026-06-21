import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { McpConnectionRepository } from "../../src/db/repositories/mcpConnectionRepository.js";
import { Database } from "../../src/shared/infra/database.js";

// Focused characterization for the OAuth-token methods and the remove() reference guard,
// which the externalSkills suite does not fully exercise.

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

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

const describeIfDatabase = (await canReach(integrationDatabaseUrl)) ? describe : describe.skip;

describeIfDatabase("McpConnectionRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new McpConnectionRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Mcp Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Mcp Workspace",
      `route-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO agents (id, workspace_id) VALUES ($1,$2)`, [agentId, workspaceId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const create = () =>
    repository.create({
      agentId,
      displayName: "Server",
      serverUrl: "https://mcp.example.com",
      authMethod: "oauth",
    });

  it("create defaults to unconfigured and find scopes by agent", async () => {
    const created = await create();
    expect(created).toMatchObject({ agentId, status: "unconfigured", oauthFlowCiphertext: null });
    expect((await repository.findById(agentId, created.id))?.id).toBe(created.id);
    expect(await repository.findById(randomUUID(), created.id)).toBeNull();
  });

  it("setOauthFlow then setOauthTokens transitions status and clears the flow", async () => {
    const created = await create();
    const withFlow = await repository.setOauthFlow(agentId, created.id, "flow-cipher");
    expect(withFlow?.oauthFlowCiphertext).toBe("flow-cipher");

    const authorized = await repository.setOauthTokens(agentId, created.id, "cred-cipher", "key-1");
    expect(authorized).toMatchObject({
      status: "authorized",
      credentialCiphertext: "cred-cipher",
      encryptionKeyId: "key-1",
      oauthFlowCiphertext: null,
    });
  });

  it("update applies only the provided fields (presence semantics)", async () => {
    const created = await create();
    const updated = await repository.update(agentId, created.id, { displayName: "Renamed" });
    expect(updated).toMatchObject({ displayName: "Renamed", serverUrl: created.serverUrl });

    const status = await repository.updateStatus(agentId, created.id, "error");
    expect(status?.status).toBe("error");
  });

  it("remove deletes an unreferenced connection but blocks a referenced one", async () => {
    const created = await create();
    expect(await repository.remove(agentId, created.id)).toBe(true);
    expect(await repository.remove(agentId, created.id)).toBe(false);

    const referenced = await create();
    await database.query(
      `INSERT INTO agent_skills (id, agent_id, workspace_id, skill_name, kind, target_type, target_id)
       VALUES ($1,$2,$3,$4,'external_mcp','mcp_connection',$5)`,
      [randomUUID(), agentId, workspaceId, "some_tool", referenced.id],
    );
    await expect(repository.remove(agentId, referenced.id)).rejects.toMatchObject({ code: "23503" });
  });
});
