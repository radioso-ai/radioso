import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AccountRepository } from "../../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaceRepository.js";
import { CopilotRepository } from "../../../src/db/repositories/copilotRepository.js";
import { createReviewedReceiptSettlement } from "../../../src/app/composition/copilotReviewedReceiptSettlement.js";
import { createDirectiveCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/proposalAdapters.js";
import { AuthoredDirectiveService, type AuthoredDirectiveInput } from "../../../src/modules/agents/public.js";
import type { CopilotProposalApplyContext } from "../../../src/modules/operatorCopilot/contracts.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("the reviewed approval gate, proven against Postgres's row lock and clock", () => {
  const database = new Database(integrationDatabaseUrl);
  const accountRepository = new AccountRepository(database.kysely);
  const workspaceRepository = new WorkspaceRepository(database.kysely);
  const agentRepository = new AgentRepository(database.kysely);
  const proposals = new CopilotRepository(database.kysely);
  const coherenceChecker = { check: async () => ({ coherent: true as const, conflicts: [], rationale: "Coherent." }) };
  const authoredDirectiveService = new AuthoredDirectiveService({ repository: agentRepository, coherenceChecker, registeredCapabilityNames: new Set() });
  const adapter = createDirectiveCopilotProposalAdapter({
    authoredDirectiveService,
    directiveAuthorService: { draftForProposal: async () => { throw new Error("not exercised by these tests"); } },
    agentService: { get: async (workspaceId: string, agentId: string) => (await agentRepository.findByIdAndWorkspaceId(agentId, workspaceId))! } as never,
    reviewedReceipt: createReviewedReceiptSettlement(database.kysely),
  });

  const accountIds: string[] = [];
  const resource = `https://mcp.example/${randomUUID()}/operator/mcp`;

  beforeAll(async () => {
    await database.query("INSERT INTO operator_mcp_deployment_credential_state (resource, credential_epoch, key_fingerprint) VALUES ($1, 1, 'reviewed-approval-key')", [resource]);
  });

  afterAll(async () => {
    for (const accountId of accountIds) {
      await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    }
    await database.query("DELETE FROM operator_mcp_deployment_credential_state WHERE resource = $1", [resource]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  /** Same bootstrap as the reviewed-directives suite: account, workspace, agent, and the client/grant/credential/invocation chain a `prepare_directive` call would have left. */
  const createFixture = async () => {
    const account = await accountRepository.create({ name: "Reviewed Approval", email: `reviewed-approval-${randomUUID()}@example.com`, passwordHash: "hash" });
    accountIds.push(account.id);
    const workspace = await workspaceRepository.create(account.id, "Reviewed Approval Workspace");
    const agent = await agentRepository.create(workspace.id, { name: "Reviewed Approval Agent" });
    const operatorUserId = randomUUID();
    const membershipId = randomUUID();
    const clientId = randomUUID();
    const snapshotId = randomUUID();
    const grantId = randomUUID();
    const credentialId = randomUUID();
    const invocationId = randomUUID();
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [operatorUserId, `reviewed-approval-user-${operatorUserId}@example.com`]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'admin', 'active')", [membershipId, account.id, operatorUserId]);
    await database.query("INSERT INTO operator_mcp_clients (id, client_id, registration_method, application_type, display_name, redirect_uris, metadata_digest) VALUES ($1, $2, 'metadata_document', 'web', 'Client', '[\"https://client.example/callback\"]'::jsonb, 'digest')", [clientId, `https://client.example/${clientId}`]);
    await database.query("INSERT INTO operator_mcp_client_metadata_snapshots (id, client_id, client_version, metadata_digest, normalized_metadata, source, validated_at) VALUES ($1, $2, 1, 'digest', '{}'::jsonb, 'metadata_document', NOW())", [snapshotId, clientId]);
    await database.query("INSERT INTO operator_mcp_grants (id, client_id, client_version, client_metadata_snapshot_id, account_id, workspace_id, user_id, membership_id, resource, tool_scopes, credential_epoch) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, ARRAY['operator:propose', 'operator:write'], 1)", [grantId, clientId, snapshotId, account.id, workspace.id, operatorUserId, membershipId, resource]);
    await database.query("INSERT INTO operator_mcp_access_credentials (id, grant_id, token_digest, issued_grant_version, issued_client_version, issued_client_metadata_snapshot_id, issued_credential_epoch, issued_tool_scopes, issued_offline_access, expires_at) VALUES ($1, $2, $3, 1, 1, $4, 1, ARRAY['operator:propose', 'operator:write'], false, NOW() + INTERVAL '15 minutes')", [credentialId, grantId, `digest-${credentialId}`, snapshotId]);
    await database.query(
      "INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, operation_id, input_digest, proof_nonce_digest, status, retained_until) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'tools/call', 'prepare_directive', 'propose', $8, 'v1:input', $9, 'running', NOW() + INTERVAL '30 days')",
      [invocationId, credentialId, grantId, account.id, workspace.id, operatorUserId, clientId, randomUUID(), `nonce-${invocationId}`],
    );
    return { account, workspace, agent, operatorUserId, grantId, clientId, credentialId, invocationId };
  };

  const createExecutionInvocation = async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
    const executionInvocationId = randomUUID();
    await database.query(
      "INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, operation_id, input_digest, proof_nonce_digest, status, retained_until) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'tools/call', 'execute_reviewed_proposal', 'act', $8, 'v1:input', $9, 'admitted', NOW() + INTERVAL '30 days')",
      [executionInvocationId, fixture.credentialId, fixture.grantId, fixture.account.id, fixture.workspace.id, fixture.operatorUserId, fixture.clientId, randomUUID(), `nonce-${executionInvocationId}`],
    );
    return executionInvocationId;
  };

  const REVIEW_DIGEST = "a".repeat(43);

  /** A signed-in-approval-tier reviewed directive edit, exactly what `prepare_directive` persists for a live/irreversible change. */
  const prepareSignedInProposal = async (fixture: Awaited<ReturnType<typeof createFixture>>, input: { targetRef: unknown; payload: unknown; versionToken: string; expiresAt?: Date }) =>
    proposals.createProposal({
      workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId,
      origin: { type: "operator_mcp_invocation", invocationId: fixture.invocationId },
      targetType: "directive", targetRef: input.targetRef, payload: input.payload, versionToken: input.versionToken,
      evidence: null, reviewDigest: REVIEW_DIGEST, reviewSnapshot: {}, expiresAt: input.expiresAt ?? new Date(Date.now() + 60_000),
      confirmationRequirement: "signed_in_approval", changeEffect: { exposure: "live", reversibility: "reversible", metered: false },
    });

  const approve = (fixture: Awaited<ReturnType<typeof createFixture>>, proposalId: string) =>
    proposals.approveMcpReviewedProposal({ proposalId, workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId, reviewDigest: REVIEW_DIGEST, now: new Date() });

  const claimInput = (fixture: Awaited<ReturnType<typeof createFixture>>, proposalId: string, executionInvocationId: string) => ({
    proposalId, executionInvocationId, reviewDigest: REVIEW_DIGEST, workspaceId: fixture.workspace.id,
    operatorUserId: fixture.operatorUserId, grantId: fixture.grantId, clientId: fixture.clientId, now: new Date(), claimTtlSeconds: 300,
  });

  const applyContext = (fixture: Awaited<ReturnType<typeof createFixture>>, proposalId: string, executionInvocationId: string, applyClaimedAt: Date): CopilotProposalApplyContext => ({
    surface: "mcp", accountId: fixture.account.id, proposalId, executionInvocationId, applyClaimedAt, operatorUserId: fixture.operatorUserId,
  });

  const createDirectiveInput = (name: string): AuthoredDirectiveInput => ({ name, condition: { kind: "always" }, action: "Quote the source verbatim." });

  it("serializes a concurrent approve and claim through the row lock: claim only ever sees a fully committed approval, never a half-written one", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("race-target"));
    const proposal = await prepareSignedInProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload: { name: "race-target", condition: { kind: "always" }, action: "Updated by race." }, versionToken: existing.updatedAt.toISOString() });
    const executionInvocationId = await createExecutionInvocation(fixture);

    const [approveResult, claimResult] = await Promise.all([
      approve(fixture, proposal.id),
      proposals.claimMcpReviewedProposalApply(claimInput(fixture, proposal.id, executionInvocationId)),
    ]);

    // Whichever transaction's row lock won the race, approval always lands (nothing about claiming
    // blocks it), and the claim result is exactly what its own ordering allows.
    expect(approveResult).toBe("approved");
    expect(["claimed", "approval_required"]).toContain(claimResult.status);

    if (claimResult.status === "approval_required") {
      // Approval is now fully committed (`Promise.all` resolved), so the same receipt can claim.
      const followUp = await proposals.claimMcpReviewedProposalApply(claimInput(fixture, proposal.id, executionInvocationId));
      expect(followUp).toMatchObject({ status: "claimed" });
    } else {
      expect(claimResult).toMatchObject({ status: "claimed" });
    }
  });

  it("refuses a claim that started before expiry but only reaches the row lock after it, using database time rather than its own stale timestamp", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("expiry-race-claim"));
    const proposal = await prepareSignedInProposal(fixture, {
      targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload: { name: "expiry-race-claim", condition: { kind: "always" }, action: "Should not apply." },
      versionToken: existing.updatedAt.toISOString(), expiresAt: new Date(Date.now() + 150),
    });
    await approve(fixture, proposal.id);
    const executionInvocationId = await createExecutionInvocation(fixture);

    const lockClient = await database.pool.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query("SELECT id FROM copilot_proposals WHERE id = $1 FOR UPDATE", [proposal.id]);
      // The claim's own SELECT ... FOR UPDATE is now sent, but it cannot acquire the row lock
      // lockClient holds. `now: new Date()` below is captured before this wait — the fix under
      // test discards it and reads `clock_timestamp()` only after the lock is actually granted.
      const claimPromise = proposals.claimMcpReviewedProposalApply(claimInput(fixture, proposal.id, executionInvocationId));
      await new Promise((resolve) => setTimeout(resolve, 500));
      await lockClient.query("COMMIT");
      await expect(claimPromise).resolves.toMatchObject({ status: "expired" });
    } finally {
      lockClient.release();
    }
  });

  it("refuses an approval that started before expiry but only reaches the row lock after it, using database time rather than its own stale timestamp", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("expiry-race-approve"));
    const proposal = await prepareSignedInProposal(fixture, {
      targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload: { name: "expiry-race-approve", condition: { kind: "always" }, action: "Should not approve." },
      versionToken: existing.updatedAt.toISOString(), expiresAt: new Date(Date.now() + 150),
    });

    const lockClient = await database.pool.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query("SELECT id FROM copilot_proposals WHERE id = $1 FOR UPDATE", [proposal.id]);
      const approvePromise = approve(fixture, proposal.id);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await lockClient.query("COMMIT");
      await expect(approvePromise).resolves.toBe("expired");
    } finally {
      lockClient.release();
    }
  });

  it("replays the same settled outcome after approval, without re-checking approval or re-invoking the owner", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("replay-after-approval"));
    const payload = { name: "replay-after-approval", condition: { kind: "always" }, action: "Applied once." };
    const proposal = await prepareSignedInProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload, versionToken: existing.updatedAt.toISOString() });
    await expect(approve(fixture, proposal.id)).resolves.toBe("approved");
    const executionInvocationId = await createExecutionInvocation(fixture);
    const claimed = await proposals.claimMcpReviewedProposalApply(claimInput(fixture, proposal.id, executionInvocationId));
    if (claimed.status !== "claimed") throw new Error(`expected claim, got ${claimed.status}`);

    const applied = await adapter.applyIfVersionMatches(
      fixture.workspace.id, { agentId: fixture.agent.id, directiveId: existing.id }, payload, existing.updatedAt.toISOString(),
      applyContext(fixture, proposal.id, executionInvocationId, claimed.claim.claimedAt),
    );
    expect(applied).toEqual({ outcome: "applied", appliedRef: { directiveId: existing.id } });

    // A retry with the identical receipt replays the settled outcome; it neither re-derives the
    // confirmation requirement nor asks whether the operation is still approved.
    const replay = await proposals.claimMcpReviewedProposalApply(claimInput(fixture, proposal.id, executionInvocationId));
    expect(replay).toEqual({ status: "settled", outcome: "applied", appliedRef: { directiveId: existing.id } });
  });

  it("reports stale once the target changed after approval, so approving never bypasses the version fence", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("approved-then-changed"));
    const staleVersionToken = existing.updatedAt.toISOString();
    const payload = { name: "approved-then-changed", condition: { kind: "always" }, action: "Should be stale." };
    const proposal = await prepareSignedInProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload, versionToken: staleVersionToken });
    await expect(approve(fixture, proposal.id)).resolves.toBe("approved");

    // The directive changes after the operator approved this exact review; approval recorded
    // consent for that review, not a promise that the target would stay still.
    await authoredDirectiveService.update(fixture.workspace.id, fixture.agent.id, existing.id, { name: "approved-then-changed", condition: { kind: "always" }, action: "Changed after approval." }, { expectedUpdatedAt: existing.updatedAt });

    const executionInvocationId = await createExecutionInvocation(fixture);
    const claimed = await proposals.claimMcpReviewedProposalApply(claimInput(fixture, proposal.id, executionInvocationId));
    if (claimed.status !== "claimed") throw new Error(`expected claim, got ${claimed.status}`);

    const result = await adapter.applyIfVersionMatches(
      fixture.workspace.id, { agentId: fixture.agent.id, directiveId: existing.id }, payload, staleVersionToken,
      applyContext(fixture, proposal.id, executionInvocationId, claimed.claim.claimedAt),
    );
    expect(result).toMatchObject({ outcome: "stale" });
  });
});

describeIntegration("migration 200_copilot_reviewed_approval settles pre-existing pending reviewed rows", () => {
  const isolatedName = `mig_reviewed_approval_${randomUUID().replace(/-/g, "")}`;
  const migrationsDirectory = new URL("../../../src/db/migrations/", import.meta.url);
  const isolatedDatabaseUrl = (baseUrl: string, databaseName: string): string => {
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    return url.toString();
  };

  it("settles a pre-migration pending reviewed proposal as stale, with a conversation requirement, instead of leaving it unapprovable", async () => {
    const admin = new Database(integrationDatabaseUrl);
    let isolated: Database | undefined;
    try {
      await admin.execute(`CREATE DATABASE "${isolatedName}"`);
      isolated = new Database(isolatedDatabaseUrl(integrationDatabaseUrl, isolatedName));

      const migrationFiles = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
      const gateFile = "200_copilot_reviewed_approval.sql";
      const gateIndex = migrationFiles.indexOf(gateFile);
      expect(gateIndex).toBeGreaterThan(0);

      // Replay every migration up to (not including) the approval gate, exactly the schema the
      // gate's own author wrote its `UPDATE`s against.
      for (const file of migrationFiles.slice(0, gateIndex)) {
        const sql = await readFile(new URL(file, migrationsDirectory), "utf8");
        await isolated.pool.query(sql);
      }

      const accountId = randomUUID(); const userId = randomUUID(); const workspaceId = randomUUID(); const conversationId = randomUUID(); const proposalId = randomUUID();
      const settledProposalId = randomUUID();
      await isolated.pool.query(
        "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Legacy', $2, 'hash')",
        [accountId, `legacy-${accountId}@example.com`],
      );
      await isolated.pool.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [userId, `legacy-user-${userId}@example.com`]);
      await isolated.pool.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Legacy', $3)", [workspaceId, accountId, `legacy-${workspaceId}`]);
      await isolated.pool.query("INSERT INTO copilot_conversations (id, workspace_id, operator_user_id) VALUES ($1, $2, $3)", [conversationId, workspaceId, userId]);
      // A pending reviewed proposal exactly as `prepare_directive` left it before this migration
      // existed: `review_digest` set, and none of the columns the gate is about to add.
      await isolated.pool.query(
        "INSERT INTO copilot_proposals (id, workspace_id, operator_user_id, conversation_id, target_type, target_ref, payload, version_token, status, review_digest, review_snapshot, expires_at) VALUES ($1, $2, $3, $4, 'directive', '{}'::jsonb, '{}'::jsonb, 'v1', 'pending', 'a'||repeat('0', 42), '{}'::jsonb, NOW() + INTERVAL '10 minutes')",
        [proposalId, workspaceId, userId, conversationId],
      );
      // An already-settled reviewed row (not pending) must be left exactly as it landed; the gate
      // only classifies rows that never got to a real answer.
      await isolated.pool.query(
        "INSERT INTO copilot_proposals (id, workspace_id, operator_user_id, conversation_id, target_type, target_ref, payload, version_token, status, review_digest, review_snapshot, expires_at) VALUES ($1, $2, $3, $4, 'directive', '{}'::jsonb, '{}'::jsonb, 'v1', 'applied', 'b'||repeat('0', 42), '{}'::jsonb, NOW() + INTERVAL '10 minutes')",
        [settledProposalId, workspaceId, userId, conversationId],
      );

      const gateSql = await readFile(new URL(gateFile, migrationsDirectory), "utf8");
      await isolated.pool.query(gateSql);

      const pendingRow = await isolated.queryOne<{ status: string; confirmation_requirement: string | null; approved_at: Date | null }>(
        "SELECT status, confirmation_requirement, approved_at FROM copilot_proposals WHERE id = $1", [proposalId],
      );
      expect(pendingRow).toMatchObject({ status: "stale", confirmation_requirement: "conversation", approved_at: null });

      const settledRow = await isolated.queryOne<{ status: string; confirmation_requirement: string | null }>(
        "SELECT status, confirmation_requirement FROM copilot_proposals WHERE id = $1", [settledProposalId],
      );
      expect(settledRow).toMatchObject({ status: "applied", confirmation_requirement: "conversation" });
    } finally {
      await isolated?.close().catch(() => undefined);
      await admin.execute(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => undefined);
      await admin.close().catch(() => undefined);
    }
  });
});
