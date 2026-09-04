import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OperatorMcpInvocationRepository } from "../../../src/db/repositories/operatorMcpInvocationRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("OperatorMcpInvocationRepository", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new OperatorMcpInvocationRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const clientRecordId = randomUUID();
  const snapshotId = randomUUID();
  const grantId = randomUUID();
  const credentialId = randomUUID();
  const clientId = `https://client.example/${clientRecordId}`;
  const resource = "https://mcp.example/operator/mcp";

  const baseInput = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    credentialId,
    grantId,
    grantVersion: "1",
    accountId,
    workspaceId,
    userId,
    clientId: clientRecordId,
    method: "tools/call" as const,
    descriptorName: "retrieval_probe",
    shape: "probe" as const,
    operationId: null as string | null,
    inputDigest: "a".repeat(64),
    verificationCost: 0,
    proofNonceDigest: randomUUID().replaceAll("-", ""),
    now: new Date("2026-09-04T00:00:00.000Z"),
    retainedUntil: new Date("2026-09-11T00:00:00.000Z"),
    ...overrides,
  });

  const clearInvocations = async (): Promise<void> => {
    await database.query("DELETE FROM operator_mcp_invocations WHERE grant_id = $1", [grantId]);
  };

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'MCP invocation test', $2, 'hash')", [accountId, `mcp-invocation-${accountId}@example.com`]);
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [userId, `mcp-invocation-user-${userId}@example.com`]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'admin', 'active')", [membershipId, accountId, userId]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'MCP invocation workspace', $3)", [workspaceId, accountId, `mcp-invocation-${workspaceId}`]);
    await database.query(
      `INSERT INTO operator_mcp_clients
        (id, client_id, registration_method, application_type, display_name, redirect_uris, metadata_digest)
       VALUES ($1, $2, 'metadata_document', 'web', 'MCP invocation test client', '[]'::jsonb, $3)`,
      [clientRecordId, clientId, "metadata-digest"],
    );
    await database.query(
      `INSERT INTO operator_mcp_client_metadata_snapshots
        (id, client_id, client_version, metadata_digest, normalized_metadata, source, validated_at)
       VALUES ($1, $2, 1, $3, '{}'::jsonb, 'metadata_document', NOW())`,
      [snapshotId, clientRecordId, "metadata-digest"],
    );
    await database.query(
      `INSERT INTO operator_mcp_grants
        (id, client_id, client_version, client_metadata_snapshot_id, account_id, workspace_id, user_id,
         membership_id, resource, tool_scopes, offline_access, credential_epoch)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, ARRAY['operator:probe'], false, 1)`,
      [grantId, clientRecordId, snapshotId, accountId, workspaceId, userId, membershipId, resource],
    );
    await database.query(
      `INSERT INTO operator_mcp_access_credentials
        (id, grant_id, token_digest, issued_grant_version, issued_client_version,
         issued_client_metadata_snapshot_id, issued_credential_epoch, issued_tool_scopes,
         issued_offline_access, expires_at)
       VALUES ($1, $2, $3, 1, 1, $4, 1, ARRAY['operator:probe'], false, NOW() + INTERVAL '15 minutes')`,
      [credentialId, grantId, `invocation-credential-${credentialId}`, snapshotId],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_client_metadata_snapshots WHERE id = $1", [snapshotId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_clients WHERE id = $1", [clientRecordId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("consumes a nonce-bound invocation proof once across repository replicas", async () => {
    await clearInvocations();
    const input = baseInput();
    const otherReplica = new OperatorMcpInvocationRepository(database.kysely);
    await expect(repository.admit(input)).resolves.toMatchObject({ status: "admitted", invocation: { id: input.id } });
    await expect(repository.consumeProof(input.proofNonceDigest)).resolves.toBe("consumed");
    await expect(otherReplica.consumeProof(input.proofNonceDigest)).resolves.toBe("replay");
    await expect(repository.consumeProof(randomUUID().replaceAll("-", ""))).resolves.toBe("missing");
  });

  it("reconciles stable operations and rejects input-digest reuse", async () => {
    await clearInvocations();
    const first = baseInput({ operationId: "operation-1" });
    await expect(repository.admit(first)).resolves.toMatchObject({ status: "admitted" });
    await expect(repository.admit({ ...first, id: randomUUID(), proofNonceDigest: randomUUID().replaceAll("-", "") })).resolves.toMatchObject({
      status: "replay",
      invocation: { id: first.id, inputDigest: first.inputDigest },
    });
    await expect(repository.admit({ ...first, id: randomUUID(), inputDigest: "b".repeat(64), proofNonceDigest: randomUUID().replaceAll("-", "") })).resolves.toMatchObject({ status: "conflict" });
    await expect(repository.findByOperation({ grantId, operationId: "operation-1" })).resolves.toMatchObject({ id: first.id });
  });

  it("reserves six rolling verification units atomically and does not oversubscribe", async () => {
    await clearInvocations();
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => repository.admit(baseInput({
      id: randomUUID(), operationId: `budget-${index}`, verificationCost: 1, proofNonceDigest: randomUUID().replaceAll("-", ""),
    }))));
    expect(attempts.filter((result) => result.status === "admitted")).toHaveLength(6);
    expect(attempts.filter((result) => result.status === "budget_exhausted")).toHaveLength(2);
  });

  it("refunds only an admitted pre-effect reservation and reconciles its outcome", async () => {
    await clearInvocations();
    const first = baseInput({ verificationCost: 2, operationId: "refund-before-effect" });
    await expect(repository.admit(first)).resolves.toMatchObject({ status: "admitted" });
    await expect(repository.refundReservation({ invocationId: first.id, now: first.now })).resolves.toBe(true);
    await expect(repository.findById(first.id)).resolves.toMatchObject({ status: "refused", budgetReservedAt: null });
    await expect(repository.refundReservation({ invocationId: first.id, now: first.now })).resolves.toBe(false);

    const running = baseInput({ verificationCost: 2, operationId: "refund-after-effect" });
    await expect(repository.admit(running)).resolves.toMatchObject({ status: "admitted" });
    await expect(repository.markRunning({ invocationId: running.id, now: running.now })).resolves.toMatchObject({ status: "running" });
    await expect(repository.refundReservation({ invocationId: running.id, now: running.now })).resolves.toBe(false);
    await expect(repository.recordOutcome({ invocationId: running.id, status: "completed", safeOutcomeCode: "ok", resultReference: "result-1", now: running.now })).resolves.toMatchObject({
      status: "completed", safeOutcomeCode: "ok", resultReference: "result-1",
    });
  });

  it("prepares an admitted tool call with its keyed input and budget reservation", async () => {
    await clearInvocations();
    const admitted = baseInput({ descriptorName: "retrieval_probe", shape: null, inputDigest: "wire-digest" });
    await expect(repository.admit(admitted)).resolves.toMatchObject({ status: "admitted" });
    await expect(repository.prepareInvocation({
      invocationId: admitted.id, operationId: "prepared-operation", descriptorName: "retrieval_probe",
      shape: "probe", inputDigest: "keyed-input-digest", verificationCost: 2, now: admitted.now,
    })).resolves.toMatchObject({
      status: "prepared",
      invocation: { operationId: "prepared-operation", inputDigest: "keyed-input-digest", verificationCost: 2, budgetReservedAt: admitted.now },
    });
  });
});
