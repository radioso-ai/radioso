import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CopilotRepository } from "../../../src/db/repositories/copilotRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("operator MCP proposal origin", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const proposals = new CopilotRepository(database.kysely);
  const resource = `https://mcp.example/${randomUUID()}/operator/mcp`;
  const accountId = randomUUID(); const workspaceId = randomUUID(); const userId = randomUUID(); const membershipId = randomUUID();
  const clientId = randomUUID(); const snapshotId = randomUUID(); const grantId = randomUUID(); const credentialId = randomUUID(); const invocationId = randomUUID();
  let persistedProposalId: string | null = null;

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Proposal', $2, 'hash')", [accountId, `proposal-${accountId}@example.com`]);
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [userId, `proposal-user-${userId}@example.com`]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'admin', 'active')", [membershipId, accountId, userId]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Proposal', $3)", [workspaceId, accountId, `proposal-${workspaceId}`]);
    await database.query("INSERT INTO operator_mcp_clients (id, client_id, registration_method, application_type, display_name, redirect_uris, metadata_digest) VALUES ($1, $2, 'metadata_document', 'web', 'Client', '[\"https://client.example/callback\"]'::jsonb, 'digest')", [clientId, `https://client.example/${clientId}`]);
    await database.query("INSERT INTO operator_mcp_client_metadata_snapshots (id, client_id, client_version, metadata_digest, normalized_metadata, source, validated_at) VALUES ($1, $2, 1, 'digest', '{}'::jsonb, 'metadata_document', NOW())", [snapshotId, clientId]);
    await database.query("INSERT INTO operator_mcp_deployment_credential_state (resource, credential_epoch, key_fingerprint) VALUES ($1, 1, 'proposal-key')", [resource]);
    await database.query("INSERT INTO operator_mcp_grants (id, client_id, client_version, client_metadata_snapshot_id, account_id, workspace_id, user_id, membership_id, resource, tool_scopes, credential_epoch) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, ARRAY['operator:propose'], 1)", [grantId, clientId, snapshotId, accountId, workspaceId, userId, membershipId, resource]);
    await database.query("INSERT INTO operator_mcp_access_credentials (id, grant_id, token_digest, issued_grant_version, issued_client_version, issued_client_metadata_snapshot_id, issued_credential_epoch, issued_tool_scopes, issued_offline_access, expires_at) VALUES ($1, $2, $3, 1, 1, $4, 1, ARRAY['operator:propose'], false, NOW() + INTERVAL '15 minutes')", [credentialId, grantId, `digest-${credentialId}`, snapshotId]);
    await database.query("INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, operation_id, input_digest, proof_nonce_digest, status, retained_until) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'tools/call', 'propose_ingestion_settings', 'propose', $8, 'v1:input', $9, 'running', NOW() + INTERVAL '30 days')", [invocationId, credentialId, grantId, accountId, workspaceId, userId, clientId, randomUUID(), `nonce-${invocationId}`]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM copilot_proposals WHERE operator_mcp_invocation_id = $1", [invocationId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_invocations WHERE id = $1", [invocationId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_client_metadata_snapshots WHERE client_id = $1", [clientId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_clients WHERE id = $1", [clientId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_deployment_credential_state WHERE resource = $1", [resource]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("persists a discriminated invocation origin and retains its invocation while the proposal exists", async () => {
    const proposal = await proposals.createProposal({
      workspaceId, operatorUserId: userId, origin: { type: "operator_mcp_invocation", invocationId },
      targetType: "ingestion_settings", targetRef: { workspaceId }, payload: { summary: "Tune ingestion" },
      versionToken: "v1", evidence: null,
    });
    persistedProposalId = proposal.id;
    expect(proposal).toMatchObject({ conversationId: null, operatorMcpInvocationId: invocationId, origin: { type: "operator_mcp_invocation", invocationId } });
    await expect(database.query("DELETE FROM operator_mcp_invocations WHERE id = $1", [invocationId])).rejects.toThrow();
    await database.query("UPDATE operator_mcp_grants SET status = 'revoked', version = version + 1, revoked_at = NOW() WHERE id = $1", [grantId]);
    await expect(proposals.createProposal({
      workspaceId, operatorUserId: userId, origin: { type: "operator_mcp_invocation", invocationId },
      targetType: "ingestion_settings", targetRef: { workspaceId }, payload: { summary: "Stale proposal" },
      versionToken: "v2", evidence: null,
    })).rejects.toThrow(/authorization/i);
    await expect(proposals.findProposal({ id: proposal.id, workspaceId, operatorUserId: userId })).resolves.toMatchObject({ id: proposal.id });
  });

  it("rejects rows that name both or neither origin", async () => {
    const base = [randomUUID(), workspaceId, userId, "ingestion_settings", "{}", "{}", "v1"];
    await expect(database.query("INSERT INTO copilot_proposals (id, workspace_id, operator_user_id, target_type, target_ref, payload, version_token) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)", base)).rejects.toThrow();
  });

  it("expires a pending proposal and deletes MCP records in dependency order", async () => {
    expect(persistedProposalId).not.toBeNull();
    await database.query("UPDATE operator_mcp_invocations SET retained_until = NOW() - INTERVAL '1 day' WHERE id = $1", [invocationId]);
    await expect(proposals.deleteExpiredOperatorMcpRecords({ now: new Date(), limit: 10 })).resolves.toBe(1);
    await expect(database.query("SELECT id FROM operator_mcp_invocations WHERE id = $1", [invocationId])).resolves.toHaveLength(0);
    await expect(database.query("SELECT id FROM copilot_proposals WHERE id = $1", [persistedProposalId])).resolves.toHaveLength(0);
  });
});
