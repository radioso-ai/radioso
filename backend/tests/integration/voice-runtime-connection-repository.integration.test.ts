import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VoiceRuntimeConnectionRepository } from "../../src/modules/voiceChannel/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("VoiceRuntimeConnectionRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new VoiceRuntimeConnectionRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();

  const insertAgent = async (agentWorkspaceId = workspaceId): Promise<string> => {
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [agentId, agentWorkspaceId, "Voice Agent"]);
    return agentId;
  };

  const insertGrant = async (agentId: string): Promise<string> => {
    const grantId = randomUUID();
    await database.query(
      `INSERT INTO agent_access_grants (id, agent_id, workspace_id, label, principal_kind, role, token_prefix, token_hash, origin_mode, channel)
       VALUES ($1, $2, $3, 'Voice calls', 'agent-api', 'agent', 'rk_test', $4, 'allow-all', 'agent-api')`,
      [grantId, agentId, workspaceId, `hash-${grantId}`],
    );
    return grantId;
  };

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Voice Runtime Test Co", `voice-runtime-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4), ($5, $2, $6, $7)",
      [workspaceId, accountId, "Voice Runtime Workspace", `voice-runtime-${workspaceId}`, otherWorkspaceId, "Other Workspace", `voice-runtime-${otherWorkspaceId}`],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("keeps one connection per agent: a save replaces the agent's connection", async () => {
    const agentId = await insertAgent();
    const firstGrant = await insertGrant(agentId);
    const secondGrant = await insertGrant(agentId);
    const connection = { workspaceId, agentId, vendor: "elevenlabs" as const, region: "eu" as const, vendorAgentId: "agent_first", channelCredentialId: firstGrant };

    await expect(repository.find({ workspaceId, agentId })).resolves.toBeNull();
    await repository.save(connection);
    await repository.save({ ...connection, region: "us", vendorAgentId: "agent_second", channelCredentialId: secondGrant });

    await expect(repository.find({ workspaceId, agentId })).resolves.toEqual({
      ...connection,
      region: "us",
      vendorAgentId: "agent_second",
      channelCredentialId: secondGrant,
    });
  });

  it("reads a connection only in its own workspace, and removes it there", async () => {
    const agentId = await insertAgent();
    await repository.save({ workspaceId, agentId, vendor: "elevenlabs", region: "us", vendorAgentId: "agent_42", channelCredentialId: null });

    await expect(repository.find({ workspaceId: otherWorkspaceId, agentId })).resolves.toBeNull();
    await repository.remove({ workspaceId: otherWorkspaceId, agentId });
    await expect(repository.find({ workspaceId, agentId })).resolves.not.toBeNull();
    await repository.remove({ workspaceId, agentId });
    await expect(repository.find({ workspaceId, agentId })).resolves.toBeNull();
  });

  it("forgets the credential when its grant row is deleted, and goes with its agent", async () => {
    const agentId = await insertAgent();
    const grantId = await insertGrant(agentId);
    await repository.save({ workspaceId, agentId, vendor: "elevenlabs", region: "sg", vendorAgentId: "agent_42", channelCredentialId: grantId });

    await database.query("DELETE FROM agent_access_grants WHERE id = $1", [grantId]);
    await expect(repository.find({ workspaceId, agentId })).resolves.toMatchObject({ channelCredentialId: null });

    await database.query("DELETE FROM agents WHERE id = $1", [agentId]);
    const rows = await database.query("SELECT 1 FROM agent_voice_runtime_connections WHERE agent_id = $1", [agentId]);
    expect(rows).toEqual([]);
  });

  it("reads a row naming a vendor or region this version does not know as no connection", async () => {
    const agentId = await insertAgent();
    await database.query(
      "INSERT INTO agent_voice_runtime_connections (agent_id, workspace_id, vendor, region, vendor_agent_id) VALUES ($1, $2, 'acme', 'mars', 'agent_42')",
      [agentId, workspaceId],
    );

    await expect(repository.find({ workspaceId, agentId })).resolves.toBeNull();
  });
});
