import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OperatorMcpInvocationRepository } from "../../../src/db/repositories/operatorMcpInvocationRepository.js";
import { CopilotRepository } from "../../../src/db/repositories/copilotRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("OperatorMcpInvocationRepository", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new OperatorMcpInvocationRepository(database.kysely);
  const copilotRepository = new CopilotRepository(database.kysely);
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
    await database.query(
      "DELETE FROM copilot_proposals WHERE operator_mcp_invocation_id IN (SELECT id FROM operator_mcp_invocations WHERE grant_id = $1)",
      [grantId],
    );
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
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, ARRAY['operator:probe', 'operator:propose'], false, 1)`,
      [grantId, clientRecordId, snapshotId, accountId, workspaceId, userId, membershipId, resource],
    );
    await database.query(
      `INSERT INTO operator_mcp_access_credentials
        (id, grant_id, token_digest, issued_grant_version, issued_client_version,
         issued_client_metadata_snapshot_id, issued_credential_epoch, issued_tool_scopes,
         issued_offline_access, expires_at)
       VALUES ($1, $2, $3, 1, 1, $4, 1, ARRAY['operator:probe', 'operator:propose'], false, NOW() + INTERVAL '15 minutes')`,
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

  it("honors a deployment verification budget lower than the protocol maximum", async () => {
    await clearInvocations();
    const limited = new OperatorMcpInvocationRepository(database.kysely, { verificationBudgetPerMinute: 2 });
    const attempts = await Promise.all(Array.from({ length: 3 }, (_, index) => limited.admit(baseInput({
      id: randomUUID(), operationId: `limited-budget-${index}`, verificationCost: 1, proofNonceDigest: randomUUID().replaceAll("-", ""),
    }))));

    expect(attempts.filter((result) => result.status === "admitted")).toHaveLength(2);
    expect(attempts.filter((result) => result.status === "budget_exhausted")).toHaveLength(1);
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
    await expect(repository.claimRunning({ invocationId: running.id, now: running.now })).resolves.toMatchObject({ status: "running" });
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

  it("recovers a committed proposal when the original invocation outcome was lost", async () => {
    await clearInvocations();
    const operationId = "proposal-after-crash";
    const original = baseInput({ descriptorName: "propose_ingestion_settings", shape: null, inputDigest: "wire-1" });
    await repository.admit(original);
    await repository.prepareInvocation({
      invocationId: original.id, operationId, descriptorName: "propose_ingestion_settings",
      shape: "propose", inputDigest: "proposal-input", verificationCost: 0, now: original.now,
    });
    await repository.consumeProof(original.proofNonceDigest, original.now);
    await repository.claimRunning({ invocationId: original.id, now: original.now });
    const proposalId = randomUUID();
    await database.query(
      `INSERT INTO copilot_proposals
        (id, workspace_id, operator_user_id, operator_mcp_invocation_id, target_type, target_ref, payload, version_token)
       VALUES ($1, $2, $3, $4, 'ingestion_settings', '{}'::jsonb, '{}'::jsonb, 'v1')`,
      [proposalId, workspaceId, userId, original.id],
    );
    await repository.recordOutcome({
      invocationId: original.id,
      status: "failed",
      safeOutcomeCode: "dependency_error",
      now: new Date(original.now.getTime() + 500),
    });
    await expect(copilotRepository.recoverOperatorMcpProposal({
      invocationId: original.id,
      grantId,
      workspaceId,
      operatorUserId: userId,
      operationId,
      descriptorName: "propose_ingestion_settings",
      inputDigest: "proposal-input",
      staleBefore: new Date(original.now.getTime() - 1_000),
      now: new Date(original.now.getTime() + 1_000),
    })).resolves.toMatchObject({ status: "recovered", proposal: { id: proposalId } });
    await expect(repository.recordOutcome({
      invocationId: original.id,
      status: "completed",
      safeOutcomeCode: "completed",
      resultReference: `/oauth/operator-mcp/proposal/${proposalId}`,
      now: new Date(original.now.getTime() + 1_500),
    })).resolves.toMatchObject({ status: "completed", safeOutcomeCode: "completed" });
    await expect(database.query(
      `INSERT INTO copilot_proposals
        (id, workspace_id, operator_user_id, operator_mcp_invocation_id, target_type, target_ref, payload, version_token)
       VALUES ($1, $2, $3, $4, 'ingestion_settings', '{}'::jsonb, '{}'::jsonb, 'v1')`,
      [randomUUID(), workspaceId, userId, original.id],
    )).rejects.toThrow();
  });

  it("reclaims a stale proposal operation when no proposal was committed", async () => {
    await clearInvocations();
    const operationId = "proposal-before-effect-crash";
    const original = baseInput({ descriptorName: "propose_ingestion_settings", shape: null, inputDigest: "wire-1" });
    await repository.admit(original);
    await repository.prepareInvocation({
      invocationId: original.id, operationId, descriptorName: "propose_ingestion_settings",
      shape: "propose", inputDigest: "proposal-input", verificationCost: 0, now: original.now,
    });
    await repository.consumeProof(original.proofNonceDigest, original.now);
    await repository.claimRunning({ invocationId: original.id, now: original.now });
    const retryOne = baseInput({ descriptorName: "propose_ingestion_settings", shape: null, inputDigest: "wire-2" });
    const retryTwo = baseInput({ descriptorName: "propose_ingestion_settings", shape: null, inputDigest: "wire-3" });
    await repository.admit(retryOne);
    await repository.admit(retryTwo);

    await expect(copilotRepository.recoverOperatorMcpProposal({
      invocationId: original.id,
      grantId,
      workspaceId,
      operatorUserId: userId,
      operationId,
      descriptorName: "propose_ingestion_settings",
      inputDigest: "proposal-input",
      staleBefore: new Date(original.now.getTime() - 1_000),
      now: new Date(original.now.getTime() + 1_000),
    })).resolves.toEqual({ status: "in_progress" });
    await expect(repository.findById(original.id)).resolves.toMatchObject({ status: "running", operationId });

    await expect(copilotRepository.recoverOperatorMcpProposal({
      invocationId: original.id,
      grantId,
      workspaceId,
      operatorUserId: userId,
      operationId,
      descriptorName: "propose_ingestion_settings",
      inputDigest: "proposal-input",
      staleBefore: new Date(original.now.getTime() + 120_000),
      now: new Date(original.now.getTime() + 121_000),
    })).resolves.toEqual({ status: "retry_prepare" });
    await expect(repository.findById(original.id)).resolves.toMatchObject({
      status: "refused",
      safeOutcomeCode: "abandoned_before_effect",
      operationId,
    });
    await expect(repository.findByOperation({ grantId, operationId })).resolves.toBeNull();
    await expect(repository.claimRunning({ invocationId: original.id, now: original.now })).resolves.toBeNull();
    await expect(copilotRepository.createProposal({
      workspaceId,
      operatorUserId: userId,
      origin: { type: "operator_mcp_invocation", invocationId: original.id },
      targetType: "ingestion_settings",
      targetRef: { workspaceId },
      payload: { summary: "A delayed proposal must not commit" },
      versionToken: "v1",
      evidence: null,
    })).rejects.toThrow(/authorization/i);

    const attempts = await Promise.all([retryOne, retryTwo].map((retry) => repository.prepareInvocation({
      invocationId: retry.id,
      operationId,
      descriptorName: "propose_ingestion_settings",
      shape: "propose",
      inputDigest: "proposal-input",
      verificationCost: 0,
      now: new Date(original.now.getTime() + 121_000),
    })));
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(["prepared", "replay"]);
  });
});
