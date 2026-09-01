import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AgentConverseSessionMappingRepository } from "../../src/db/repositories/agentConverseSessionMappingRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("AgentConverseSessionMappingRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new AgentConverseSessionMappingRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const grantId = randomUUID();

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "MCP Session Test Co", `mcp-session-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "MCP Session Workspace", `mcp-session-${workspaceId}`],
    );
    await database.query(
      "INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)",
      [agentId, workspaceId, "MCP Session Agent"],
    );
    await database.query(
      `INSERT INTO agent_access_grants (
        id, agent_id, workspace_id, principal_kind, role, channel, token_prefix,
        token_hash, encrypted_token, origin_mode, origin_allowlist, enabled, expires_at
      ) VALUES ($1, $2, $3, 'agent-api', 'agent', 'mcp-converse', $4, $5, NULL, 'allow-all', '{}', true, $6)`,
      [grantId, agentId, workspaceId, "rdso_mcp", `hash-${grantId}`, new Date(Date.now() + 60_000)],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("atomically reuses one identity under concurrent exchange and creates a new one after rotation", async () => {
    const resolved = await Promise.all(
      Array.from({ length: 12 }, () => repository.resolvePublicSessionId({
        grantId,
        grantVersion: "grant-version-one",
        proposedPublicSessionId: randomUUID(),
      })),
    );

    expect(new Set(resolved).size).toBe(1);
    const firstSessionId = resolved[0];
    const persisted = await database.query(
      "SELECT grant_version, public_session_id FROM agent_converse_session_mappings WHERE grant_id = $1",
      [grantId],
    );
    expect(persisted).toEqual([{
      grant_version: "grant-version-one",
      public_session_id: firstSessionId,
    }]);

    await expect(repository.resolvePublicSessionId({
      grantId,
      grantVersion: "grant-version-one",
      proposedPublicSessionId: randomUUID(),
    })).resolves.toBe(firstSessionId);

    const afterRotation = await repository.resolvePublicSessionId({
      grantId,
      grantVersion: "grant-version-two",
      proposedPublicSessionId: randomUUID(),
    });
    expect(afterRotation).not.toBe(firstSessionId);
  });
});
