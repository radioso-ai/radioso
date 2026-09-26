import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { AccountRepository } from "../../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaceRepository.js";
import { CopilotRepository } from "../../../src/db/repositories/copilotRepository.js";
import { createReviewedReceiptSettlement } from "../../../src/app/composition/copilotReviewedReceiptSettlement.js";
import { createDirectiveCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/proposalAdapters.js";
import { AuthoredDirectiveService, DirectiveAuthorService, type AuthoredDirectiveInput } from "../../../src/modules/agents/public.js";
import type { CopilotProposalApplyContext } from "../../../src/modules/operatorCopilot/contracts.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("reviewed directive changes, prepared and executed over the operator MCP seam", () => {
  const database = new Database(integrationDatabaseUrl);
  const accountRepository = new AccountRepository(database.kysely);
  const workspaceRepository = new WorkspaceRepository(database.kysely);
  const agentRepository = new AgentRepository(database.kysely);
  const proposals = new CopilotRepository(database.kysely);
  const coherenceChecker = { check: async () => ({ coherent: true as const, conflicts: [], rationale: "Coherent." }) };
  const authoredDirectiveService = new AuthoredDirectiveService({ repository: agentRepository, coherenceChecker, registeredCapabilityNames: new Set() });
  const directiveAuthorService = new DirectiveAuthorService({
    repository: agentRepository,
    textGenerationClient: { complete: async () => { throw new Error("the coach is not exercised by these tests"); } },
    logger: { info: () => undefined, warn: () => undefined },
    buildStepScopeTag: (routineId: string, stepId: string) => `step:${routineId}:${stepId}`,
  });
  const adapter = createDirectiveCopilotProposalAdapter({
    authoredDirectiveService, directiveAuthorService,
    agentService: { get: async (workspaceId: string, agentId: string) => (await agentRepository.findByIdAndWorkspaceId(agentId, workspaceId))! } as never,
    reviewedReceipt: createReviewedReceiptSettlement(database.kysely),
  });

  const accountIds: string[] = [];
  const resource = `https://mcp.example/${randomUUID()}/operator/mcp`;

  beforeAll(async () => {
    await database.query("INSERT INTO operator_mcp_deployment_credential_state (resource, credential_epoch, key_fingerprint) VALUES ($1, 1, 'reviewed-directives-key')", [resource]);
  });

  afterAll(async () => {
    for (const accountId of accountIds) {
      await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    }
    await database.query("DELETE FROM operator_mcp_deployment_credential_state WHERE resource = $1", [resource]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  /**
   * A full reviewed-proposal MCP bootstrap: account, workspace, agent, and the client/grant/
   * credential/invocation chain `prepare_directive` would have left behind, satisfying every
   * foreign key `copilot_proposals`/`operator_mcp_invocations` rows depend on. `clientId` here
   * is `operator_mcp_clients.id`, the FK every invocation and grant carries — not the client's
   * external `client_id` URI, which is only the row's own natural key.
   */
  const createFixture = async () => {
    const account = await accountRepository.create({ name: "Reviewed Directives", email: `reviewed-directives-${randomUUID()}@example.com`, passwordHash: "hash" });
    accountIds.push(account.id);
    const workspace = await workspaceRepository.create(account.id, "Reviewed Directives Workspace");
    const agent = await agentRepository.create(workspace.id, { name: "Reviewed Directives Agent" });
    const operatorUserId = randomUUID();
    const membershipId = randomUUID();
    const clientId = randomUUID();
    const snapshotId = randomUUID();
    const grantId = randomUUID();
    const credentialId = randomUUID();
    const invocationId = randomUUID();
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [operatorUserId, `reviewed-directives-user-${operatorUserId}@example.com`]);
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

  /** A second `operator_mcp_invocations` row for an `execute_reviewed_proposal` attempt, bound to the same grant/client as the fixture's prepare. */
  const createExecutionInvocation = async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
    const executionInvocationId = randomUUID();
    await database.query(
      "INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, operation_id, input_digest, proof_nonce_digest, status, retained_until) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'tools/call', 'execute_reviewed_proposal', 'act', $8, 'v1:input', $9, 'admitted', NOW() + INTERVAL '30 days')",
      [executionInvocationId, fixture.credentialId, fixture.grantId, fixture.account.id, fixture.workspace.id, fixture.operatorUserId, fixture.clientId, randomUUID(), `nonce-${executionInvocationId}`],
    );
    return executionInvocationId;
  };

  const prepareProposal = async (fixture: Awaited<ReturnType<typeof createFixture>>, input: { targetRef: unknown; payload: unknown; versionToken: string }) =>
    proposals.createProposal({
      workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId,
      origin: { type: "operator_mcp_invocation", invocationId: fixture.invocationId },
      targetType: "directive", targetRef: input.targetRef, payload: input.payload, versionToken: input.versionToken,
      evidence: null, reviewDigest: "a".repeat(43), expiresAt: new Date(Date.now() + 60_000),
    });

  const claim = async (fixture: Awaited<ReturnType<typeof createFixture>>, proposalId: string, executionInvocationId: string) => {
    const claimed = await proposals.claimMcpReviewedProposalApply({
      proposalId, executionInvocationId, reviewDigest: "a".repeat(43), workspaceId: fixture.workspace.id,
      operatorUserId: fixture.operatorUserId, grantId: fixture.grantId, clientId: fixture.clientId, now: new Date(), claimTtlSeconds: 300,
    });
    if (claimed.status !== "claimed") throw new Error(`expected claim, got ${claimed.status}`);
    return claimed.claim;
  };

  const applyContext = (fixture: Awaited<ReturnType<typeof createFixture>>, proposalId: string, executionInvocationId: string, applyClaimedAt: Date): CopilotProposalApplyContext => ({
    surface: "mcp", accountId: fixture.account.id, proposalId, executionInvocationId, applyClaimedAt, operatorUserId: fixture.operatorUserId,
  });

  const createDirectiveInput = (name: string): AuthoredDirectiveInput => ({ name, condition: { kind: "always" }, action: "Quote the source verbatim." });

  it("commits a directive create and its reviewed receipt together, then returns the original appliedRef after a lost response", async () => {
    const fixture = await createFixture();
    const fence = await directiveAuthorService.readProposalFence(fixture.workspace.id, fixture.agent.id, null);
    const proposal = await prepareProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: null }, payload: createDirectiveInput("create-committed"), versionToken: fence });
    const executionInvocationId = await createExecutionInvocation(fixture);
    const claimed = await claim(fixture, proposal.id, executionInvocationId);

    const result = await adapter.applyIfVersionMatches(fixture.workspace.id, { agentId: fixture.agent.id, directiveId: null }, createDirectiveInput("create-committed"), fence, applyContext(fixture, proposal.id, executionInvocationId, claimed.claimedAt));

    expect(result.outcome).toBe("applied");
    const created = (await agentRepository.listDirectives(fixture.agent.id, fixture.workspace.id)).find((directive) => directive.name === "create-committed");
    expect(created).toBeDefined();
    expect(result).toMatchObject({ appliedRef: { directiveId: created!.id } });

    const replay = await proposals.claimMcpReviewedProposalApply({
      proposalId: proposal.id, executionInvocationId, reviewDigest: "a".repeat(43), workspaceId: fixture.workspace.id,
      operatorUserId: fixture.operatorUserId, grantId: fixture.grantId, clientId: fixture.clientId, now: new Date(), claimTtlSeconds: 300,
    });
    expect(replay).toEqual({ status: "settled", outcome: "applied", appliedRef: { directiveId: created!.id } });
  });

  it("rolls a directive create back when its reviewed receipt cannot settle", async () => {
    const fixture = await createFixture();
    const fence = await directiveAuthorService.readProposalFence(fixture.workspace.id, fixture.agent.id, null);
    const proposal = await prepareProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: null }, payload: createDirectiveInput("create-rolled-back"), versionToken: fence });
    const claimed = await claim(fixture, proposal.id, await createExecutionInvocation(fixture));

    await expect(adapter.applyIfVersionMatches(
      fixture.workspace.id, { agentId: fixture.agent.id, directiveId: null }, createDirectiveInput("create-rolled-back"), fence,
      // A mismatched execution receipt: the settlement's UPDATE affects no row, so the hook throws
      // and the owner's create transaction must never commit.
      applyContext(fixture, proposal.id, randomUUID(), claimed.claimedAt),
    )).rejects.toThrow(/receipt_conflict/u);

    expect((await agentRepository.listDirectives(fixture.agent.id, fixture.workspace.id)).find((directive) => directive.name === "create-rolled-back")).toBeUndefined();
  });

  it("documents the create fence: another write on the same agent does not invalidate a prepared create", async () => {
    const fixture = await createFixture();
    const fence = await directiveAuthorService.readProposalFence(fixture.workspace.id, fixture.agent.id, null);
    const proposal = await prepareProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: null }, payload: createDirectiveInput("fence-order-insensitive"), versionToken: fence });

    // A second, unrelated directive write on the same agent lands before the first is executed. A
    // create is fenced only on the agent existing, not on this row's updatedAt, so it must still
    // apply - this is the incident the fence fixes: an operator drafting a directive alongside
    // agent-setting proposals must be able to apply each independently of write order.
    await authoredDirectiveService.create(fixture.workspace.id, fixture.agent.id, createDirectiveInput("unrelated-first"), { coherence: "skip" });

    const executionInvocationId = await createExecutionInvocation(fixture);
    const claimed = await claim(fixture, proposal.id, executionInvocationId);
    await expect(adapter.applyIfVersionMatches(
      fixture.workspace.id, { agentId: fixture.agent.id, directiveId: null }, createDirectiveInput("fence-order-insensitive"), fence,
      applyContext(fixture, proposal.id, executionInvocationId, claimed.claimedAt),
    )).resolves.toMatchObject({ outcome: "applied" });
    expect((await agentRepository.listDirectives(fixture.agent.id, fixture.workspace.id)).find((directive) => directive.name === "fence-order-insensitive")).toBeDefined();
  });

  it("reports a create as stale once its agent is deleted before execute", async () => {
    const fixture = await createFixture();
    const fence = await directiveAuthorService.readProposalFence(fixture.workspace.id, fixture.agent.id, null);
    const proposal = await prepareProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: null }, payload: createDirectiveInput("agent-deleted-create"), versionToken: fence });

    await agentRepository.deleteByIdAndWorkspaceId(fixture.agent.id, fixture.workspace.id);

    const executionInvocationId = await createExecutionInvocation(fixture);
    const claimed = await claim(fixture, proposal.id, executionInvocationId);
    await expect(adapter.applyIfVersionMatches(
      fixture.workspace.id, { agentId: fixture.agent.id, directiveId: null }, createDirectiveInput("agent-deleted-create"), fence,
      applyContext(fixture, proposal.id, executionInvocationId, claimed.claimedAt),
    )).resolves.toMatchObject({ outcome: "stale" });
  });

  it("commits a directive edit and its reviewed receipt together, then returns the original appliedRef after a lost response", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("edit-committed"));
    const proposal = await prepareProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload: { name: "edit-committed", condition: { kind: "always" }, action: "Updated action." }, versionToken: existing.updatedAt.toISOString() });
    const executionInvocationId = await createExecutionInvocation(fixture);
    const claimed = await claim(fixture, proposal.id, executionInvocationId);

    const result = await adapter.applyIfVersionMatches(
      fixture.workspace.id, { agentId: fixture.agent.id, directiveId: existing.id }, { name: "edit-committed", condition: { kind: "always" }, action: "Updated action." }, existing.updatedAt.toISOString(),
      applyContext(fixture, proposal.id, executionInvocationId, claimed.claimedAt),
    );

    expect(result).toEqual({ outcome: "applied", appliedRef: { directiveId: existing.id } });
    const updated = (await agentRepository.listDirectives(fixture.agent.id, fixture.workspace.id)).find((directive) => directive.id === existing.id);
    expect(updated?.action).toBe("Updated action.");

    const replay = await proposals.claimMcpReviewedProposalApply({
      proposalId: proposal.id, executionInvocationId, reviewDigest: "a".repeat(43), workspaceId: fixture.workspace.id,
      operatorUserId: fixture.operatorUserId, grantId: fixture.grantId, clientId: fixture.clientId, now: new Date(), claimTtlSeconds: 300,
    });
    expect(replay).toEqual({ status: "settled", outcome: "applied", appliedRef: { directiveId: existing.id } });
  });

  it("rolls a directive edit back when its reviewed receipt cannot settle", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("edit-rolled-back"));
    const proposal = await prepareProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload: { name: "edit-rolled-back", condition: { kind: "always" }, action: "Should not land." }, versionToken: existing.updatedAt.toISOString() });
    const claimed = await claim(fixture, proposal.id, await createExecutionInvocation(fixture));

    await expect(adapter.applyIfVersionMatches(
      fixture.workspace.id, { agentId: fixture.agent.id, directiveId: existing.id }, { name: "edit-rolled-back", condition: { kind: "always" }, action: "Should not land." }, existing.updatedAt.toISOString(),
      applyContext(fixture, proposal.id, randomUUID(), claimed.claimedAt),
    )).rejects.toThrow(/receipt_conflict/u);

    const untouched = (await agentRepository.listDirectives(fixture.agent.id, fixture.workspace.id)).find((directive) => directive.id === existing.id);
    expect(untouched?.action).toBe("Quote the source verbatim.");
  });

  it("commits a set_enabled change and its reviewed receipt together, then returns the original appliedRef after a lost response", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("set-enabled-committed"));
    const proposal = await prepareProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload: { op: "set_enabled", enabled: false }, versionToken: existing.updatedAt.toISOString() });
    const executionInvocationId = await createExecutionInvocation(fixture);
    const claimed = await claim(fixture, proposal.id, executionInvocationId);

    const result = await adapter.applyIfVersionMatches(
      fixture.workspace.id, { agentId: fixture.agent.id, directiveId: existing.id }, { op: "set_enabled", enabled: false }, existing.updatedAt.toISOString(),
      applyContext(fixture, proposal.id, executionInvocationId, claimed.claimedAt),
    );

    expect(result).toEqual({ outcome: "applied", appliedRef: { directiveId: existing.id } });
    expect((await agentRepository.listDirectives(fixture.agent.id, fixture.workspace.id)).find((directive) => directive.id === existing.id)?.enabled).toBe(false);

    const replay = await proposals.claimMcpReviewedProposalApply({
      proposalId: proposal.id, executionInvocationId, reviewDigest: "a".repeat(43), workspaceId: fixture.workspace.id,
      operatorUserId: fixture.operatorUserId, grantId: fixture.grantId, clientId: fixture.clientId, now: new Date(), claimTtlSeconds: 300,
    });
    expect(replay).toEqual({ status: "settled", outcome: "applied", appliedRef: { directiveId: existing.id } });
  });

  it("rolls a set_enabled change back when its reviewed receipt cannot settle", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("set-enabled-rolled-back"));
    const proposal = await prepareProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload: { op: "set_enabled", enabled: false }, versionToken: existing.updatedAt.toISOString() });
    const claimed = await claim(fixture, proposal.id, await createExecutionInvocation(fixture));

    await expect(adapter.applyIfVersionMatches(
      fixture.workspace.id, { agentId: fixture.agent.id, directiveId: existing.id }, { op: "set_enabled", enabled: false }, existing.updatedAt.toISOString(),
      applyContext(fixture, proposal.id, randomUUID(), claimed.claimedAt),
    )).rejects.toThrow(/receipt_conflict/u);

    expect((await agentRepository.listDirectives(fixture.agent.id, fixture.workspace.id)).find((directive) => directive.id === existing.id)?.enabled).toBe(true);
  });

  it("commits a directive removal and its reviewed receipt together, then returns the original appliedRef after a lost response", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("remove-committed"));
    const proposal = await prepareProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload: { op: "remove" }, versionToken: existing.updatedAt.toISOString() });
    const executionInvocationId = await createExecutionInvocation(fixture);
    const claimed = await claim(fixture, proposal.id, executionInvocationId);

    const result = await adapter.applyIfVersionMatches(
      fixture.workspace.id, { agentId: fixture.agent.id, directiveId: existing.id }, { op: "remove" }, existing.updatedAt.toISOString(),
      applyContext(fixture, proposal.id, executionInvocationId, claimed.claimedAt),
    );

    expect(result).toEqual({ outcome: "applied", appliedRef: { directiveId: existing.id } });
    expect((await agentRepository.listDirectives(fixture.agent.id, fixture.workspace.id)).find((directive) => directive.id === existing.id)).toBeUndefined();

    const replay = await proposals.claimMcpReviewedProposalApply({
      proposalId: proposal.id, executionInvocationId, reviewDigest: "a".repeat(43), workspaceId: fixture.workspace.id,
      operatorUserId: fixture.operatorUserId, grantId: fixture.grantId, clientId: fixture.clientId, now: new Date(), claimTtlSeconds: 300,
    });
    expect(replay).toEqual({ status: "settled", outcome: "applied", appliedRef: { directiveId: existing.id } });
  });

  it("rolls a directive removal back when its reviewed receipt cannot settle, so the directive still exists afterwards", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("remove-rolled-back"));
    const proposal = await prepareProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload: { op: "remove" }, versionToken: existing.updatedAt.toISOString() });
    const claimed = await claim(fixture, proposal.id, await createExecutionInvocation(fixture));

    await expect(adapter.applyIfVersionMatches(
      fixture.workspace.id, { agentId: fixture.agent.id, directiveId: existing.id }, { op: "remove" }, existing.updatedAt.toISOString(),
      applyContext(fixture, proposal.id, randomUUID(), claimed.claimedAt),
    )).rejects.toThrow(/receipt_conflict/u);

    expect((await agentRepository.listDirectives(fixture.agent.id, fixture.workspace.id)).find((directive) => directive.id === existing.id)).toBeDefined();
  });
});
