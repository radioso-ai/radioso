import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { digestOperatorMcpCall, type OperatorMcpScope } from "@radioso/operator-mcp-contract";

import { AccountRepository } from "../../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaceRepository.js";
import { CopilotRepository } from "../../../src/db/repositories/copilotRepository.js";
import { OperatorMcpInvocationRepository } from "../../../src/db/repositories/operatorMcpInvocationRepository.js";
import { createReviewedReceiptSettlement } from "../../../src/app/composition/copilotReviewedReceiptSettlement.js";
import { createDirectiveCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/proposalAdapters.js";
import { OperatorCopilotService } from "../../../src/modules/operatorCopilot/service.js";
import { AuthoredDirectiveService, type AuthoredDirectiveInput } from "../../../src/modules/agents/public.js";
import type { CopilotProposalApplyContext } from "../../../src/modules/operatorCopilot/contracts.js";
import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";
import { OperatorMcpApplicationService } from "../../../src/modules/operatorCopilot/mcpApplicationService.js";
import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { enrichCopilotToolCatalog } from "../../../src/modules/operatorCopilot/catalog.js";
import { createReviewedProposalExecutionTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalExecution.js";
import { createDirectiveReviewedPreparationTool } from "../../../src/modules/operatorCopilot/tools/directiveReviewedPreparation.js";
import type { OperatorMcpPrincipal } from "../../../src/modules/operatorMcpAuthorization/public.js";
import { NoopUsageLimitPolicy } from "../../../src/shared/domain/usageLimitPolicy.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("the reviewed approval gate, proven against Postgres's row lock and clock", () => {
  const database = new Database(integrationDatabaseUrl);
  const accountRepository = new AccountRepository(database.kysely);
  const workspaceRepository = new WorkspaceRepository(database.kysely);
  const agentRepository = new AgentRepository(database.kysely);
  const proposals = new CopilotRepository(database.kysely);
  const invocationsRepo = new OperatorMcpInvocationRepository(database.kysely);
  const coherenceChecker = { check: async () => ({ coherent: true as const, conflicts: [], rationale: "Coherent." }) };
  const authoredDirectiveService = new AuthoredDirectiveService({ repository: agentRepository, coherenceChecker, registeredCapabilityNames: new Set() });
  const adapter = createDirectiveCopilotProposalAdapter({
    authoredDirectiveService,
    directiveAuthorService: { draftForProposal: async () => { throw new Error("not exercised by these tests"); } },
    agentService: { get: async (workspaceId: string, agentId: string) => (await agentRepository.findByIdAndWorkspaceId(agentId, workspaceId))! } as never,
    reviewedReceipt: createReviewedReceiptSettlement(database.kysely),
  });
  const authorization = { hasAllPermissions: async () => true };
  const copilot = new OperatorCopilotService({
    repository: proposals,
    capabilityRunner: { runStreaming: async function* () {} } as never,
    usageLimitPolicy: new NoopUsageLimitPolicy(),
    auditService: { record: async () => undefined },
    workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "reviewed-approval" },
    prompt: "test",
    tools: [],
    currentAuthorization: authorization,
    proposalAdapters: [adapter],
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
    return { account, workspace, agent, operatorUserId, membershipId, grantId, clientId, snapshotId, credentialId, invocationId };
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

  const mcpSecret = "integration-test-secret-at-least-32-bytes-long";
  const principalFor = (
    fixture: Awaited<ReturnType<typeof createFixture>>,
    scopes: readonly OperatorMcpScope[] = ["operator:propose", "operator:write"],
  ): OperatorMcpPrincipal => ({
    credentialId: fixture.credentialId, credentialEpoch: "1", grantId: fixture.grantId, grantVersion: "1",
    accountId: fixture.account.id, workspaceId: fixture.workspace.id, userId: fixture.operatorUserId,
    membershipId: fixture.membershipId, membershipRole: "admin",
    clientId: `https://client.example/${fixture.clientId}`, clientRecordId: fixture.clientId, clientVersion: "1",
    clientMetadataSnapshotId: fixture.snapshotId, resource, currentToolScopes: scopes, currentOfflineAccess: false,
  });

  /**
   * The production `OperatorMcpApplicationService`, wired the way `buildOperatorMcpServices`
   * (`src/app/server/builders/operatorMcp.ts`) wires it: the real `OperatorMcpInvocationRepository`,
   * a catalog assembled from the real `execute_reviewed_proposal` and `prepare_directive` descriptor
   * factories carrying their real production `mcpDisposition` (`operatorMcpDispositions`), and the
   * real `OperatorCopilotService` underneath both. Only credential/token resolution is stubbed to a
   * fixed principal -- that OAuth machinery is a true external to the replay-key fix under test --
   * and `hasAllPermissions` is a toggleable seam, the same one `OperatorCopilotService`'s own tests
   * already use to simulate a revoked permission.
   */
  const buildRealMcpService = (
    fixture: Awaited<ReturnType<typeof createFixture>>,
    options: { isAuthorized?: () => boolean } = {},
  ) => {
    const principal = principalFor(fixture);
    const isAuthorized = options.isAuthorized ?? (() => true);
    const auditEvents: Array<{ eventType: string; eventStatus: string; metadata: Record<string, unknown> }> = [];
    const auditService = { record: async (event: { eventType: string; eventStatus: string; metadata: Record<string, unknown> }) => { auditEvents.push(event); } };
    // `execute_reviewed_proposal` declares no static required permission (its target-aware
    // authorization is a second, later check with the target's own permission list) -- an empty
    // list must stay vacuously authorized so the toggle below only ever denies a real,
    // target-specific check, exactly like the real permission set this stands in for.
    const currentAuthorization = { hasAllPermissions: async (input: { requiredPermissions: readonly string[] }) => input.requiredPermissions.length === 0 || isAuthorized() };
    // A test-local `OperatorCopilotService` rather than the shared `copilot` above, so each test's
    // audit events are its own -- the shared instance's no-op audit stub is used by every other test
    // in this file and must stay unaffected.
    const localCopilot = new OperatorCopilotService({
      repository: proposals,
      capabilityRunner: { runStreaming: async function* () {} } as never,
      usageLimitPolicy: new NoopUsageLimitPolicy(),
      auditService,
      workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "reviewed-approval" },
      prompt: "test",
      tools: [],
      currentAuthorization,
      proposalAdapters: [adapter],
    });
    const executionTool = {
      ...createReviewedProposalExecutionTool({ executeMcpReviewedProposal: (input) => localCopilot.executeMcpReviewedProposal(input) }),
      mcpDisposition: operatorMcpDispositions.execute_reviewed_proposal,
    };
    const prepareDirectiveTool = {
      ...createDirectiveReviewedPreparationTool({
        proposalRepository: proposals, proposalAdapters: [adapter], auditService,
        proposalRecovery: proposals, directives: authoredDirectiveService,
        directiveAuthor: { draftForProposal: async () => { throw new Error("not exercised by these tests"); } },
      }),
      mcpDisposition: operatorMcpDispositions.prepare_directive,
    };
    const catalog = new OperatorMcpCatalogService(
      enrichCopilotToolCatalog([executionTool, prepareDirectiveTool], { resolveWorkspaceKey: async () => "reviewed-approval" }),
    );
    const service = new OperatorMcpApplicationService({
      credentialValidation: { validate: async () => principal, revalidateCredential: async () => principal },
      invocations: invocationsRepo,
      catalog,
      currentAuthorization,
      audit: { record: (event) => auditService.record({ eventType: event.eventType, eventStatus: event.eventStatus, metadata: { ...event.metadata } }) },
      secret: mcpSecret,
    });
    return { service, principal, auditEvents };
  };

  /** Admits and invokes one `tools/call` through the real service, exactly as an MCP client would. */
  const callTool = (
    service: OperatorMcpApplicationService,
    input: { name: string; arguments: Record<string, unknown>; operationId?: string },
  ) => {
    const bodyDigest = digestOperatorMcpCall({ name: input.name, arguments: input.arguments, ...(input.operationId ? { operationId: input.operationId } : {}) });
    return service.admit({
      accessToken: "integration-test-access-token", invocationId: randomUUID(), method: "tools/call",
      descriptorName: input.name, resource, timestamp: String(Math.floor(Date.now() / 1_000)), nonce: randomUUID(), bodyDigest,
    }).then((admitted) => service.invoke({
      proof: admitted.proof, name: input.name, arguments: input.arguments,
      ...(input.operationId ? { operationId: input.operationId } : {}), bodyDigest,
    }));
  };

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
    expect(approveResult).toMatchObject({ status: "approved" });
    expect(["claimed", "approval_required"]).toContain(claimResult.status);

    if (claimResult.status === "approval_required") {
      // Approval is now fully committed (`Promise.all` resolved), so the same receipt can claim.
      const followUp = await proposals.claimMcpReviewedProposalApply(claimInput(fixture, proposal.id, executionInvocationId));
      expect(followUp).toMatchObject({ status: "claimed" });
    } else {
      expect(claimResult).toMatchObject({ status: "claimed" });
    }
  });

  it("repeats an idempotent approval without moving its recorded timestamp", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("idempotent-approve"));
    const proposal = await prepareSignedInProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload: { name: "idempotent-approve", condition: { kind: "always" }, action: "Approved twice." }, versionToken: existing.updatedAt.toISOString() });

    const first = await approve(fixture, proposal.id);
    expect(first).toMatchObject({ status: "approved", newlyRecorded: true });
    if (first.status !== "approved") throw new Error(`expected approved, got ${first.status}`);

    // A repeat of the exact same digest must not move `approved_at`: the caller learns nothing was
    // newly recorded, so it can skip auditing a transition that never happened.
    const second = await approve(fixture, proposal.id);
    expect(second).toEqual({ status: "approved", approvedAt: first.approvedAt, newlyRecorded: false });
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
      await expect(approvePromise).resolves.toEqual({ status: "expired" });
    } finally {
      lockClient.release();
    }
  });

  it("replays the same settled outcome after approval, without re-checking approval or re-invoking the owner", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("replay-after-approval"));
    const payload = { name: "replay-after-approval", condition: { kind: "always" }, action: "Applied once." };
    const proposal = await prepareSignedInProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload, versionToken: existing.updatedAt.toISOString() });
    await expect(approve(fixture, proposal.id)).resolves.toMatchObject({ status: "approved" });
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

  /**
   * Issue #1324's key-switch fix, driven through the real `OperatorMcpApplicationService.invoke`
   * (admission, proof, and `prepareInvocation` dedup all real) rather than by calling `replayKeyFor`
   * or the repository directly: `execute_reviewed_proposal` is `operationIdentity: "input"`, so a
   * first call that carries a client operation id and a retry that omits it must reconcile onto the
   * one bound receipt.
   */
  it("applies a reviewed proposal once when a keyed execute is retried without an operation id", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("key-switch-keyed-first"));
    const payload = { name: "key-switch-keyed-first", condition: { kind: "always" }, action: "Applied once, however the retry is keyed." };
    const proposal = await proposals.createProposal({
      workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId,
      origin: { type: "operator_mcp_invocation", invocationId: fixture.invocationId },
      targetType: "directive", targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload,
      versionToken: existing.updatedAt.toISOString(), evidence: null, reviewDigest: REVIEW_DIGEST, reviewSnapshot: {},
      expiresAt: new Date(Date.now() + 60_000), confirmationRequirement: "conversation",
      changeEffect: { exposure: "draft", reversibility: "reversible", metered: false },
    });
    const { service, auditEvents } = buildRealMcpService(fixture);
    const args = { proposalId: proposal.id, reviewDigest: REVIEW_DIGEST };

    const first = await callTool(service, { name: "execute_reviewed_proposal", arguments: args, operationId: "client-operation-a" });
    expect(first).toMatchObject({
      structuredContent: { proposalId: proposal.id, status: "applied", appliedRef: { directiveId: existing.id } },
      safeOutcomeCode: "completed",
    });

    const retry = await callTool(service, { name: "execute_reviewed_proposal", arguments: args });
    expect(retry).toEqual(first);

    const bound = await database.query<{ execution_invocation_id: string | null }>(
      "SELECT execution_invocation_id FROM copilot_proposals WHERE id = $1", [proposal.id],
    );
    expect(bound).toHaveLength(1);
    expect(bound[0].execution_invocation_id).not.toBeNull();
    const receiptRows = await database.query<{ id: string }>(
      "SELECT id FROM operator_mcp_invocations WHERE id = $1", [bound[0].execution_invocation_id],
    );
    expect(receiptRows).toHaveLength(1);

    await expect(proposals.findProposal({ id: proposal.id, workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId }))
      .resolves.toMatchObject({ status: "applied", appliedRef: { directiveId: existing.id } });
    expect(auditEvents.filter((event) => event.eventType === "copilot.proposal.applied")).toHaveLength(1);

    const directives = await authoredDirectiveService.list(fixture.workspace.id, fixture.agent.id);
    expect(directives.find((directive) => directive.id === existing.id)).toMatchObject({ action: payload.action });
  });

  it("applies a reviewed proposal once when an unkeyed execute is retried with an operation id", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("key-switch-unkeyed-first"));
    const payload = { name: "key-switch-unkeyed-first", condition: { kind: "always" }, action: "Applied once, however the first call is unkeyed." };
    const proposal = await proposals.createProposal({
      workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId,
      origin: { type: "operator_mcp_invocation", invocationId: fixture.invocationId },
      targetType: "directive", targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload,
      versionToken: existing.updatedAt.toISOString(), evidence: null, reviewDigest: REVIEW_DIGEST, reviewSnapshot: {},
      expiresAt: new Date(Date.now() + 60_000), confirmationRequirement: "conversation",
      changeEffect: { exposure: "draft", reversibility: "reversible", metered: false },
    });
    const { service, auditEvents } = buildRealMcpService(fixture);
    const args = { proposalId: proposal.id, reviewDigest: REVIEW_DIGEST };

    const first = await callTool(service, { name: "execute_reviewed_proposal", arguments: args });
    expect(first).toMatchObject({
      structuredContent: { proposalId: proposal.id, status: "applied", appliedRef: { directiveId: existing.id } },
      safeOutcomeCode: "completed",
    });

    const retry = await callTool(service, { name: "execute_reviewed_proposal", arguments: args, operationId: "client-operation-b" });
    expect(retry).toEqual(first);

    const bound = await database.query<{ execution_invocation_id: string | null }>(
      "SELECT execution_invocation_id FROM copilot_proposals WHERE id = $1", [proposal.id],
    );
    expect(bound).toHaveLength(1);
    expect(bound[0].execution_invocation_id).not.toBeNull();

    await expect(proposals.findProposal({ id: proposal.id, workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId }))
      .resolves.toMatchObject({ status: "applied", appliedRef: { directiveId: existing.id } });
    expect(auditEvents.filter((event) => event.eventType === "copilot.proposal.applied")).toHaveLength(1);

    const directives = await authoredDirectiveService.list(fixture.workspace.id, fixture.agent.id);
    expect(directives.find((directive) => directive.id === existing.id)).toMatchObject({ action: payload.action });
  });

  /**
   * Issue #1324's completed-proposal reconciliation fix: `mcpApplicationService`'s recoverable-attempt
   * gate now includes a `completed` proposal-effect receipt, so a replay of a completed `prepare_*`
   * call recovers the committed proposal instead of preparing (or being told nothing is retained
   * for) a second one. Driven through the real service, catalog, and `prepare_directive` descriptor.
   */
  it("replays a completed prepare_directive call onto its committed proposal, creating no second row", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("completed-replay"));
    const { service } = buildRealMcpService(fixture);
    const args = { kind: "set_enabled" as const, agentId: fixture.agent.id, directiveId: existing.id, enabled: false };

    const first = await callTool(service, { name: "prepare_directive", arguments: args, operationId: "prepare-once" });
    expect(first).toMatchObject({ safeOutcomeCode: "completed" });
    const firstProposalId = (first.structuredContent as { proposalId: string }).proposalId;
    expect(typeof firstProposalId).toBe("string");

    const replay = await callTool(service, { name: "prepare_directive", arguments: args, operationId: "prepare-once" });
    expect(replay).toMatchObject({ safeOutcomeCode: "completed" });
    expect((replay.structuredContent as { proposalId: string }).proposalId).toBe(firstProposalId);

    const rows = await database.query<{ id: string }>(
      "SELECT id FROM copilot_proposals WHERE target_type = 'directive' AND (target_ref->>'directiveId') = $1",
      [existing.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstProposalId);
  });

  /**
   * Issue #1324's §2 fix: a receipt refused before any owner effect must not pin an input-derived
   * key forever. `execute_reviewed_proposal`'s pre-claim `requireProposalAuthorization` check throws
   * `target_permission_denied` (400, mapped to `invalid_arguments`) before `claimMcpReviewedProposalApply`
   * ever runs, so the proposal is never bound to that refused receipt. Once the permission is
   * restored, an identical retry must run fresh rather than replay the stale refusal forever.
   */
  it("lets an identical execute retry apply once its pre-claim permission denial is fixed", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("permission-denied-then-restored"));
    const payload = { name: "permission-denied-then-restored", condition: { kind: "always" }, action: "Applied once permission is restored." };
    const proposal = await proposals.createProposal({
      workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId,
      origin: { type: "operator_mcp_invocation", invocationId: fixture.invocationId },
      targetType: "directive", targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload,
      versionToken: existing.updatedAt.toISOString(), evidence: null, reviewDigest: REVIEW_DIGEST, reviewSnapshot: {},
      expiresAt: new Date(Date.now() + 60_000), confirmationRequirement: "conversation",
      changeEffect: { exposure: "draft", reversibility: "reversible", metered: false },
    });
    let authorized = false;
    const { service } = buildRealMcpService(fixture, { isAuthorized: () => authorized });
    const args = { proposalId: proposal.id, reviewDigest: REVIEW_DIGEST };

    await expect(callTool(service, { name: "execute_reviewed_proposal", arguments: args }))
      .rejects.toMatchObject({ code: "invalid_arguments" });

    // The pre-claim refusal never reached `claimMcpReviewedProposalApply`, so the proposal was never
    // bound to that refused receipt -- it is still exactly what it was before the call.
    await expect(proposals.findProposal({ id: proposal.id, workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId }))
      .resolves.toMatchObject({ status: "pending", executionInvocationId: null });

    authorized = true;
    const retry = await callTool(service, { name: "execute_reviewed_proposal", arguments: args });
    expect(retry).toMatchObject({
      structuredContent: { proposalId: proposal.id, status: "applied", appliedRef: { directiveId: existing.id } },
      safeOutcomeCode: "completed",
    });

    const directives = await authoredDirectiveService.list(fixture.workspace.id, fixture.agent.id);
    expect(directives.find((directive) => directive.id === existing.id)).toMatchObject({ action: payload.action });
  });

  /**
   * Issue #1339: the permission is revoked between the pre-claim check and the post-claim
   * recheck, so the denial lands after `claimMcpReviewedProposalApply` bound the proposal to the
   * first receipt. Nothing was applied, so the release must leave the proposal unbound; otherwise
   * every retry after the permission is restored answers `not_prepared` until the proposal expires.
   */
  it("lets an identical execute retry apply once its post-claim permission denial is fixed", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("post-claim-denied-then-restored"));
    const payload = { name: "post-claim-denied-then-restored", condition: { kind: "always" }, action: "Applied once the post-claim permission is restored." };
    const proposal = await proposals.createProposal({
      workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId,
      origin: { type: "operator_mcp_invocation", invocationId: fixture.invocationId },
      targetType: "directive", targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload,
      versionToken: existing.updatedAt.toISOString(), evidence: null, reviewDigest: REVIEW_DIGEST, reviewSnapshot: {},
      expiresAt: new Date(Date.now() + 60_000), confirmationRequirement: "conversation",
      changeEffect: { exposure: "draft", reversibility: "reversible", metered: false },
    });
    let authorized = true;
    const { service } = buildRealMcpService(fixture, { isAuthorized: () => authorized });
    const args = { proposalId: proposal.id, reviewDigest: REVIEW_DIGEST };
    const claim = proposals.claimMcpReviewedProposalApply.bind(proposals);
    const claimStatuses: string[] = [];
    const revokeAfterClaim = vi.spyOn(proposals, "claimMcpReviewedProposalApply").mockImplementationOnce(async (input) => {
      const claimed = await claim(input);
      claimStatuses.push(claimed.status);
      authorized = false;
      return claimed;
    });

    try {
      await expect(callTool(service, { name: "execute_reviewed_proposal", arguments: args }))
        .rejects.toMatchObject({ code: "invalid_arguments" });
    } finally {
      revokeAfterClaim.mockRestore();
    }
    expect(claimStatuses).toEqual(["claimed"]);
    await expect(proposals.findProposal({ id: proposal.id, workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId }))
      .resolves.toMatchObject({ status: "pending", executionInvocationId: null });

    authorized = true;
    const retry = await callTool(service, { name: "execute_reviewed_proposal", arguments: args });
    expect(retry).toMatchObject({
      structuredContent: { proposalId: proposal.id, status: "applied", appliedRef: { directiveId: existing.id } },
      safeOutcomeCode: "completed",
    });

    const directives = await authoredDirectiveService.list(fixture.workspace.id, fixture.agent.id);
    expect(directives.find((directive) => directive.id === existing.id)).toMatchObject({ action: payload.action });
  });

  /** Holds a request at a chosen point until the test lets it continue. */
  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { open, opened };
  };

  /** Every `execute_reviewed_proposal` receipt in the fixture's workspace, oldest first. */
  const executionReceipts = (fixture: Awaited<ReturnType<typeof createFixture>>) => database.query<{
    id: string; status: string; safe_outcome_code: string | null; result_reference: string | null;
  }>(
    "SELECT id, status, safe_outcome_code, result_reference FROM operator_mcp_invocations WHERE workspace_id = $1 AND descriptor_name = 'execute_reviewed_proposal' ORDER BY created_at ASC",
    [fixture.workspace.id],
  );

  /** The first request has stalled for longer than the recovery lease, so an identical retry reconciles under its receipt. */
  const ageExecutionProofs = (fixture: Awaited<ReturnType<typeof createFixture>>) => database.query(
    "UPDATE operator_mcp_invocations SET proof_consumed_at = NOW() - INTERVAL '3 minutes' WHERE workspace_id = $1 AND descriptor_name = 'execute_reviewed_proposal'",
    [fixture.workspace.id],
  );

  const createConversationTierProposal = async (fixture: Awaited<ReturnType<typeof createFixture>>, name: string) => {
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput(name));
    const payload = { name, condition: { kind: "always" }, action: `Applied by the retry that took over (${name}).` };
    const proposal = await proposals.createProposal({
      workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId,
      origin: { type: "operator_mcp_invocation", invocationId: fixture.invocationId },
      targetType: "directive", targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload,
      versionToken: existing.updatedAt.toISOString(), evidence: null, reviewDigest: REVIEW_DIGEST, reviewSnapshot: {},
      expiresAt: new Date(Date.now() + 60_000), confirmationRequirement: "conversation",
      changeEffect: { exposure: "draft", reversibility: "reversible", metered: false },
    });
    return { existing, payload, proposal };
  };

  /**
   * Issue #1347: request A wins `claimRunning` on its receipt, then stalls past the recovery lease
   * before its pre-claim permission check. An identical retry B takes the receipt over, claims the
   * proposal, and is about to apply when A resumes and is denied. A's refusal must not land on the
   * receipt B is running under; otherwise B's owner transaction fails its receipt fence, and the
   * freed key leaves every later retry answering `not_prepared` until the proposal expires.
   */
  it("keeps a stalled request's refusal off the receipt an identical retry took over, so the retry applies", async () => {
    const fixture = await createFixture();
    const { existing, payload, proposal } = await createConversationTierProposal(fixture, "stalled-refusal-after-takeover");
    let authorized = true;
    const { service, auditEvents } = buildRealMcpService(fixture, { isAuthorized: () => authorized });
    const args = { proposalId: proposal.id, reviewDigest: REVIEW_DIGEST };
    const find = proposals.findMcpReviewedProposal.bind(proposals);
    const claim = proposals.claimMcpReviewedProposalApply.bind(proposals);
    const firstStalled = gate();
    const resumeFirst = gate();
    const retryClaimed = gate();
    const resumeRetry = gate();
    const stallFirst = vi.spyOn(proposals, "findMcpReviewedProposal").mockImplementationOnce(async (input) => {
      firstStalled.open();
      await resumeFirst.opened;
      return find(input);
    });
    const pauseRetry = vi.spyOn(proposals, "claimMcpReviewedProposalApply").mockImplementationOnce(async (input) => {
      const claimed = await claim(input);
      retryClaimed.open();
      await resumeRetry.opened;
      return claimed;
    });

    try {
      const first = callTool(service, { name: "execute_reviewed_proposal", arguments: args });
      await firstStalled.opened;
      await ageExecutionProofs(fixture);
      const retry = callTool(service, { name: "execute_reviewed_proposal", arguments: args });
      await retryClaimed.opened;

      authorized = false;
      resumeFirst.open();
      await expect(first).rejects.toMatchObject({ code: "invalid_arguments" });
      authorized = true;
      resumeRetry.open();

      await expect(retry).resolves.toMatchObject({
        structuredContent: { proposalId: proposal.id, status: "applied", appliedRef: { directiveId: existing.id } },
        safeOutcomeCode: "completed",
      });
    } finally {
      stallFirst.mockRestore();
      pauseRetry.mockRestore();
    }

    const directives = await authoredDirectiveService.list(fixture.workspace.id, fixture.agent.id);
    expect(directives.find((directive) => directive.id === existing.id)).toMatchObject({ action: payload.action });
    const [firstReceipt] = await executionReceipts(fixture);
    expect(firstReceipt).toMatchObject({ status: "completed", safe_outcome_code: "completed", result_reference: proposal.id });
    expect(auditEvents.find((event) => event.eventType === "operator_mcp.invocation" && event.metadata.invocationId === firstReceipt?.id))
      .toMatchObject({ eventStatus: "failure", metadata: { outcome: "refused", reason: "operation_taken_over" } });
  });

  /**
   * Issue #1347, the recoverable variant: the stalled request A resumes into its claim while the
   * retry B holds a fresh lease, so A answers `uncertain`. A's `completed` must not close the receipt
   * B is about to settle in its owner transaction.
   */
  it("keeps a stalled request's uncertain answer off the receipt an identical retry took over, so the retry applies", async () => {
    const fixture = await createFixture();
    const { existing, payload, proposal } = await createConversationTierProposal(fixture, "stalled-uncertain-after-takeover");
    const { service, auditEvents } = buildRealMcpService(fixture);
    const args = { proposalId: proposal.id, reviewDigest: REVIEW_DIGEST };
    const claim = proposals.claimMcpReviewedProposalApply.bind(proposals);
    const firstStalled = gate();
    const resumeFirst = gate();
    const retryClaimed = gate();
    const resumeRetry = gate();
    const claims = vi.spyOn(proposals, "claimMcpReviewedProposalApply")
      .mockImplementationOnce(async (input) => {
        firstStalled.open();
        await resumeFirst.opened;
        return claim(input);
      })
      .mockImplementationOnce(async (input) => {
        const claimed = await claim(input);
        retryClaimed.open();
        await resumeRetry.opened;
        return claimed;
      });

    try {
      const first = callTool(service, { name: "execute_reviewed_proposal", arguments: args });
      await firstStalled.opened;
      await ageExecutionProofs(fixture);
      const retry = callTool(service, { name: "execute_reviewed_proposal", arguments: args });
      await retryClaimed.opened;

      resumeFirst.open();
      await expect(first).resolves.toMatchObject({ structuredContent: { proposalId: proposal.id, status: "uncertain" } });
      resumeRetry.open();

      await expect(retry).resolves.toMatchObject({
        structuredContent: { proposalId: proposal.id, status: "applied", appliedRef: { directiveId: existing.id } },
        safeOutcomeCode: "completed",
      });
    } finally {
      claims.mockRestore();
    }

    const directives = await authoredDirectiveService.list(fixture.workspace.id, fixture.agent.id);
    expect(directives.find((directive) => directive.id === existing.id)).toMatchObject({ action: payload.action });
    const [firstReceipt] = await executionReceipts(fixture);
    expect(firstReceipt).toMatchObject({ status: "completed", safe_outcome_code: "completed", result_reference: proposal.id });
    expect(auditEvents.find((event) => event.eventType === "operator_mcp.invocation" && event.metadata.invocationId === firstReceipt?.id))
      .toMatchObject({ metadata: { reason: "operation_taken_over" } });
  });

  it("reports stale once the target changed after approval, so approving never bypasses the version fence", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("approved-then-changed"));
    const staleVersionToken = existing.updatedAt.toISOString();
    const payload = { name: "approved-then-changed", condition: { kind: "always" }, action: "Should be stale." };
    const proposal = await prepareSignedInProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload, versionToken: staleVersionToken });
    await expect(approve(fixture, proposal.id)).resolves.toMatchObject({ status: "approved" });

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

  /**
   * Finding 1 of the stacked review, proven end to end through the real `OperatorCopilotService`
   * over Postgres: an accepted URL-elicitation retry's bounded wait must observe an approval a
   * *different* connection commits mid-poll (real read-committed visibility, not merely something
   * held in the same in-flight transaction), and the operation must apply exactly once through the
   * one locked claim path -- the wait itself never records or implies approval.
   */
  it("observes an approval committed by another connection mid-wait and applies exactly once", async () => {
    const fixture = await createFixture();
    const existing = await agentRepository.createDirective(fixture.agent.id, fixture.workspace.id, createDirectiveInput("accepted-retry-wait"));
    const payload = { name: "accepted-retry-wait", condition: { kind: "always" }, action: "Applied after the wait observed approval." };
    const proposal = await prepareSignedInProposal(fixture, { targetRef: { agentId: fixture.agent.id, directiveId: existing.id }, payload, versionToken: existing.updatedAt.toISOString() });
    const executionInvocationId = await createExecutionInvocation(fixture);

    // A second, independent call through the same pool -- exactly the "another connection" the
    // wait must observe rather than anything the executing call itself wrote -- commits the
    // approval partway through the wait's real, un-mocked 1-second poll.
    const approvalAfterADelay = new Promise<void>((resolve) => {
      setTimeout(() => { approve(fixture, proposal.id).then(() => resolve()).catch(() => resolve()); }, 1_500);
    });

    const [execution] = await Promise.all([
      copilot.executeMcpReviewedProposal({
        workspaceId: fixture.workspace.id, accountId: fixture.account.id, operatorUserId: fixture.operatorUserId,
        proposalId: proposal.id, reviewDigest: REVIEW_DIGEST, executionInvocationId, grantId: fixture.grantId, clientId: fixture.clientId,
        currentAuthorization: authorization, awaitApprovalMs: 4_000,
      }),
      approvalAfterADelay,
    ]);

    expect(execution).toMatchObject({ status: "applied", appliedRef: { directiveId: existing.id } });

    // The same execution receipt retried afterward replays the one settled outcome -- the wait
    // and the apply it led to both happened exactly once.
    const replay = await copilot.executeMcpReviewedProposal({
      workspaceId: fixture.workspace.id, accountId: fixture.account.id, operatorUserId: fixture.operatorUserId,
      proposalId: proposal.id, reviewDigest: REVIEW_DIGEST, executionInvocationId, grantId: fixture.grantId, clientId: fixture.clientId,
      currentAuthorization: authorization,
    });
    expect(replay).toMatchObject({ status: "applied", appliedRef: { directiveId: existing.id } });

    const directives = await authoredDirectiveService.list(fixture.workspace.id, fixture.agent.id);
    expect(directives.find((directive) => directive.id === existing.id)).toMatchObject({ action: "Applied after the wait observed approval." });
  }, 10_000);
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
