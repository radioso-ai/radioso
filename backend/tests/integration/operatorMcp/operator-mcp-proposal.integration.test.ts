import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { CopilotRepository } from "../../../src/db/repositories/copilotRepository.js";
import { RoutineDefinitionRepository } from "../../../src/db/repositories/routineDefinitionRepository.js";
import { createRoutineMcpApplyPort } from "../../../src/app/composition/copilotRoutineAtomicApply.js";
import { createAgentSkillMcpApplyPort } from "../../../src/app/composition/copilotAgentSkillAtomicApply.js";
import { AgentSkillRepository } from "../../../src/modules/agentSkills/repository.js";
import type { RoutineDefinitionDraftInput } from "../../../src/modules/routines/public.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("operator MCP proposal origin", () => {
  const database = new Database(integrationDatabaseUrl);
  const proposals = new CopilotRepository(database.kysely);
  const routines = new RoutineDefinitionRepository(database.kysely);
  const structuralApply = createRoutineMcpApplyPort(database.kysely, { validateScopedReferences: async () => undefined });
  const agentSkillApply = createAgentSkillMcpApplyPort(database.kysely);
  const agentSkills = new AgentSkillRepository(database.kysely);
  const resource = `https://mcp.example/${randomUUID()}/operator/mcp`;
  const accountId = randomUUID(); const workspaceId = randomUUID(); const userId = randomUUID(); const membershipId = randomUUID();
  const clientId = randomUUID(); const snapshotId = randomUUID(); const grantId = randomUUID(); const credentialId = randomUUID(); const invocationId = randomUUID(); const reviewInvocationId = randomUUID(); const recoveryReviewInvocationId = randomUUID(); const executionInvocationId = randomUUID(); const recoveryExecutionInvocationId = randomUUID();
  let persistedProposalId: string | null = null; let reviewedProposalId: string | null = null;

  const routineDraft = (enabled: boolean): RoutineDefinitionDraftInput => ({
    name: `routine-${randomUUID()}`, enabled,
    activation: { triggerDescription: "Handle requests", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
    slots: [], steps: [{ stableStepId: "start", kind: "chat", instruction: "Start", toolRef: null, ordinal: 0, metadata: {} }],
    transitions: [{ fromStep: "start", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
    terminals: [{ stableStepId: "done", kind: "complete", instruction: "Done", ordinal: 0 }],
  });
  const createRoutineAgent = async () => {
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [agentId, workspaceId, `routine-${agentId}`]);
    await database.query("INSERT INTO agent_drafts (agent_id, workspace_id, generation, snapshot) VALUES ($1, $2, 1, $3::jsonb)", [agentId, workspaceId, JSON.stringify({ customInstruction: null, directives: [], routines: [], contextVariableEnablements: [] })]);
    return agentId;
  };
  const createExecution = async () => {
    const id = randomUUID();
    await database.query("INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, operation_id, input_digest, proof_nonce_digest, status, retained_until) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'tools/call', 'execute_reviewed_proposal', 'act', $8, 'v1:input', $9, 'admitted', NOW() + INTERVAL '30 days')", [id, credentialId, grantId, accountId, workspaceId, userId, clientId, randomUUID(), `nonce-${id}`]);
    return id;
  };
  const createReview = async () => {
    const id = randomUUID();
    await database.query("INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, operation_id, input_digest, proof_nonce_digest, status, retained_until) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'tools/call', 'prepare_routine_structure', 'propose', $8, 'v1:input', $9, 'running', NOW() + INTERVAL '30 days')", [id, credentialId, grantId, accountId, workspaceId, userId, clientId, randomUUID(), `nonce-${id}`]);
    return id;
  };

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
    await database.query("INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, operation_id, input_digest, proof_nonce_digest, status, retained_until) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'tools/call', 'review_ingestion_settings', 'propose', $8, 'v1:input', $9, 'running', NOW() + INTERVAL '30 days')", [reviewInvocationId, credentialId, grantId, accountId, workspaceId, userId, clientId, randomUUID(), `nonce-${reviewInvocationId}`]);
    await database.query("INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, operation_id, input_digest, proof_nonce_digest, status, retained_until) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'tools/call', 'review_ingestion_settings', 'propose', $8, 'v1:input', $9, 'running', NOW() + INTERVAL '30 days')", [recoveryReviewInvocationId, credentialId, grantId, accountId, workspaceId, userId, clientId, randomUUID(), `nonce-${recoveryReviewInvocationId}`]);
    await database.query("INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, operation_id, input_digest, proof_nonce_digest, status, retained_until) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'tools/call', 'execute_reviewed_proposal', 'act', $8, 'v1:input', $9, 'admitted', NOW() + INTERVAL '30 days')", [executionInvocationId, credentialId, grantId, accountId, workspaceId, userId, clientId, randomUUID(), `nonce-${executionInvocationId}`]);
    await database.query("INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, operation_id, input_digest, proof_nonce_digest, status, retained_until) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'tools/call', 'execute_reviewed_proposal', 'act', $8, 'v1:input', $9, 'admitted', NOW() + INTERVAL '30 days')", [recoveryExecutionInvocationId, credentialId, grantId, accountId, workspaceId, userId, clientId, randomUUID(), `nonce-${recoveryExecutionInvocationId}`]);
  });

  it("binds a reviewed MCP proposal to one matching execution receipt", async () => {
    const proposal = await proposals.createProposal({
      workspaceId, operatorUserId: userId, origin: { type: "operator_mcp_invocation", invocationId: reviewInvocationId },
      targetType: "ingestion_settings", targetRef: { workspaceId }, payload: { summary: "Reviewed" },
      versionToken: "v1", evidence: null, reviewDigest: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000),
    });
    reviewedProposalId = proposal.id;
    const [first, second] = await Promise.all([
      proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId, reviewDigest: "a".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 300 }),
      proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId, reviewDigest: "a".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 300 }),
    ]);
    expect([first, second].filter((result) => result.status === "claimed")).toHaveLength(1);
    await expect(proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId, reviewDigest: "b".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 300 })).resolves.toMatchObject({ status: "digest_mismatch" });
    await expect(proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId, reviewDigest: "a".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId: randomUUID(), now: new Date(), claimTtlSeconds: 300 })).resolves.toMatchObject({ status: "binding_mismatch" });
    await database.query("UPDATE copilot_proposals SET apply_started_at = NOW() - INTERVAL '10 seconds' WHERE id = $1", [proposal.id]);
    await expect(proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId, reviewDigest: "a".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 5 })).resolves.toMatchObject({ status: "claimed", claim: { previousAttemptStartedAt: expect.any(Date) } });
  });

  it("permits only the already-claimed receipt to recover after review expiry", async () => {
    const proposal = await proposals.createProposal({
      workspaceId, operatorUserId: userId, origin: { type: "operator_mcp_invocation", invocationId: recoveryReviewInvocationId },
      targetType: "ingestion_settings", targetRef: { workspaceId }, payload: { summary: "Recover uncertain effect" },
      versionToken: "v1", evidence: null, reviewDigest: "f".repeat(64), expiresAt: new Date(Date.now() + 60_000),
    });
    const claim = { proposalId: proposal.id, executionInvocationId: recoveryExecutionInvocationId, reviewDigest: "f".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 5 };
    await expect(proposals.claimMcpReviewedProposalApply(claim)).resolves.toMatchObject({ status: "claimed", claim: { previousAttemptStartedAt: null } });

    await database.query("UPDATE copilot_proposals SET expires_at = NOW() - INTERVAL '1 second', apply_started_at = NOW() - INTERVAL '10 seconds' WHERE id = $1", [proposal.id]);

    await expect(proposals.claimProposalApply({ id: proposal.id, workspaceId, operatorUserId: userId, claimTtlSeconds: 5 })).resolves.toBeNull();
    await expect(proposals.claimMcpReviewedProposalApply({ ...claim, now: new Date() })).resolves.toMatchObject({
      status: "claimed", claim: { previousAttemptStartedAt: expect.any(Date) },
    });
    await expect(proposals.claimMcpReviewedProposalApply({ ...claim, executionInvocationId, now: new Date() })).resolves.toMatchObject({ status: "expired" });
  });

  it("does not cancel a reviewed receipt after its pre-effect claim is released", async () => {
    const reviewId = await createReview();
    const executionId = await createExecution();
    const proposal = await proposals.createProposal({
      workspaceId, operatorUserId: userId, origin: { type: "operator_mcp_invocation", invocationId: reviewId },
      targetType: "ingestion_settings", targetRef: { workspaceId }, payload: { summary: "Retry reserved receipt" },
      versionToken: "v1", evidence: null, reviewDigest: "l".repeat(64), expiresAt: new Date(Date.now() + 60_000),
    });
    const input = { proposalId: proposal.id, executionInvocationId: executionId, reviewDigest: "l".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 300 };
    const firstClaim = await proposals.claimMcpReviewedProposalApply(input);
    if (firstClaim.status !== "claimed") throw new Error(`expected claim, got ${firstClaim.status}`);

    await expect(proposals.releaseProposalApplyClaim({ id: proposal.id, workspaceId, operatorUserId: userId, claimedAt: firstClaim.claim.claimedAt })).resolves.toBe(true);
    await expect(proposals.cancelPendingProposal({ id: proposal.id, workspaceId, operatorUserId: userId })).resolves.toBeNull();
    await expect(proposals.claimMcpReviewedProposalApply({ ...input, now: new Date() })).resolves.toMatchObject({ status: "claimed", claim: { previousAttemptStartedAt: null } });
  });

  it("reads an expired applied review only through its originating grant and client without changing its stored snapshot", async () => {
    const reviewId = await createReview();
    const snapshot = { target: { routineId: "routine-1" }, before: { enabled: true }, after: { enabled: false } };
    const proposal = await proposals.createProposal({
      workspaceId, operatorUserId: userId, origin: { type: "operator_mcp_invocation", invocationId: reviewId },
      targetType: "routine", targetRef: { agentId: randomUUID(), routineId: randomUUID() }, payload: { kind: "structural" },
      versionToken: "v1", evidence: null, reviewDigest: "r".repeat(43), reviewSnapshot: snapshot,
      expiresAt: new Date(Date.now() - 1_000),
    });
    await database.query("UPDATE copilot_proposals SET status = 'applied', applied_ref = $1::jsonb WHERE id = $2", [JSON.stringify({ routineId: "routine-1" }), proposal.id]);

    await expect(proposals.findMcpReviewedProposal({ id: proposal.id, workspaceId, operatorUserId: userId, grantId, clientId }))
      .resolves.toMatchObject({ id: proposal.id, status: "applied", appliedRef: { routineId: "routine-1" }, reviewSnapshot: snapshot });
    await expect(proposals.findMcpReviewedProposal({ id: proposal.id, workspaceId, operatorUserId: userId, grantId, clientId: randomUUID() }))
      .resolves.toBeNull();
    await expect(proposals.findMcpReviewedProposal({ id: proposal.id, workspaceId, operatorUserId: randomUUID(), grantId, clientId }))
      .resolves.toBeNull();
    // A later world change is intentionally not used to regenerate or alter the reviewed snapshot.
    await database.query("UPDATE copilot_proposals SET payload = '{\"worldChanged\":true}'::jsonb WHERE id = $1", [proposal.id]);
    await expect(proposals.findMcpReviewedProposal({ id: proposal.id, workspaceId, operatorUserId: userId, grantId, clientId }))
      .resolves.toMatchObject({ reviewSnapshot: snapshot });
  });

  it("commits a routine CAS and its exact receipt together, then returns the original reference after a lost response", async () => {
    const agentId = await createRoutineAgent();
    const original = await routines.createDraftWithAgentDraft(workspaceId, agentId, routineDraft(true));
    const executionId = await createExecution();
    const reviewId = await createReview();
    const proposal = await proposals.createProposal({
      workspaceId, operatorUserId: userId, origin: { type: "operator_mcp_invocation", invocationId: reviewId },
      targetType: "routine", targetRef: { agentId, routineId: original.id }, payload: { kind: "structural" },
      versionToken: original.updatedAt.toISOString(), evidence: null, reviewDigest: "9".repeat(64), expiresAt: new Date(Date.now() + 60_000),
    });
    const claim = await proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId: executionId, reviewDigest: "9".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 300 });
    if (claim.status !== "claimed") throw new Error(`expected claim, got ${claim.status}`);
    const replacement = { ...routineDraft(false), name: original.name };
    const settled = await structuralApply.apply({ workspaceId, agentId, operation: "update", routineId: original.id, draft: replacement, expectedUpdatedAt: original.updatedAt, removedNodeIds: [], removedSlotIds: [], proposalId: proposal.id, executionInvocationId: executionId, operatorUserId: userId, claimedAt: claim.claim.claimedAt });
    expect(settled.appliedRef).toEqual({ agentId, routineId: original.id });
    expect((await routines.findById(agentId, original.id))?.enabled).toBe(false);
    await expect(proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId: executionId, reviewDigest: "9".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 300 })).resolves.toEqual({ status: "already_applied", appliedRef: settled.appliedRef });
  });

  it("recovers a failed original receipt after its lease and settles one routine owner write", async () => {
    const agentId = await createRoutineAgent();
    const original = await routines.createDraftWithAgentDraft(workspaceId, agentId, routineDraft(true));
    const executionId = await createExecution();
    const reviewId = await createReview();
    const proposal = await proposals.createProposal({
      workspaceId, operatorUserId: userId, origin: { type: "operator_mcp_invocation", invocationId: reviewId },
      targetType: "routine", targetRef: { agentId, routineId: original.id }, payload: { kind: "structural" },
      versionToken: original.updatedAt.toISOString(), evidence: null, reviewDigest: "7".repeat(64), expiresAt: new Date(Date.now() + 60_000),
    });
    const input = { proposalId: proposal.id, executionInvocationId: executionId, reviewDigest: "7".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 5 };
    const first = await proposals.claimMcpReviewedProposalApply(input);
    if (first.status !== "claimed") throw new Error(`expected claim, got ${first.status}`);
    // Models the transport recording failure after an interrupted owner response. Neither the
    // proposal binding nor its owner mutation is altered; only the stale lease can recover it.
    await database.query("UPDATE operator_mcp_invocations SET status = 'failed', safe_outcome_code = 'dependency_error' WHERE id = $1", [executionId]);
    await database.query("UPDATE copilot_proposals SET apply_started_at = NOW() - INTERVAL '10 seconds' WHERE id = $1", [proposal.id]);
    const recovered = await proposals.claimMcpReviewedProposalApply({ ...input, now: new Date() });
    if (recovered.status !== "claimed") throw new Error(`expected recovered claim, got ${recovered.status}`);
    await expect(database.query("SELECT status FROM operator_mcp_invocations WHERE id = $1", [executionId])).resolves.toEqual([{ status: "running" }]);

    await structuralApply.apply({ workspaceId, agentId, operation: "update", routineId: original.id, draft: { ...routineDraft(false), name: original.name }, expectedUpdatedAt: original.updatedAt, removedNodeIds: [], removedSlotIds: [], proposalId: proposal.id, executionInvocationId: executionId, operatorUserId: userId, claimedAt: recovered.claim.claimedAt });
    expect((await routines.findById(agentId, original.id))?.enabled).toBe(false);
    await expect(database.query("SELECT status FROM operator_mcp_invocations WHERE id = $1", [executionId])).resolves.toEqual([{ status: "completed" }]);
    await expect(proposals.findProposal({ id: proposal.id, workspaceId, operatorUserId: userId })).resolves.toMatchObject({ status: "applied" });
  });

  it("rolls the routine write back when its receipt cannot be settled", async () => {
    const agentId = await createRoutineAgent();
    const original = await routines.createDraftWithAgentDraft(workspaceId, agentId, routineDraft(true));
    const executionId = await createExecution();
    const reviewId = await createReview();
    const proposal = await proposals.createProposal({
      workspaceId, operatorUserId: userId, origin: { type: "operator_mcp_invocation", invocationId: reviewId },
      targetType: "routine", targetRef: { agentId, routineId: original.id }, payload: { kind: "structural" },
      versionToken: original.updatedAt.toISOString(), evidence: null, reviewDigest: "8".repeat(64), expiresAt: new Date(Date.now() + 60_000),
    });
    const claim = await proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId: executionId, reviewDigest: "8".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 300 });
    if (claim.status !== "claimed") throw new Error(`expected claim, got ${claim.status}`);
    await expect(structuralApply.apply({ workspaceId, agentId, operation: "update", routineId: original.id, draft: { ...routineDraft(false), name: original.name }, expectedUpdatedAt: original.updatedAt, removedNodeIds: [], removedSlotIds: [], proposalId: proposal.id, executionInvocationId: randomUUID(), operatorUserId: userId, claimedAt: claim.claim.claimedAt })).rejects.toThrow(/receipt_conflict/u);
    expect((await routines.findById(agentId, original.id))?.enabled).toBe(true);
  });

  it("rolls an agent-skill update back when its reviewed receipt cannot settle", async () => {
    const agentId = await createRoutineAgent();
    const skill = await agentSkills.create({
      workspaceId, agentId, skillName: `retrieve-${randomUUID()}`, kind: "retrieve", targetType: "source_scope", targetId: "scope-before", config: { limit: 3 }, invocationMode: "routine_named", enabled: true,
    });
    const executionId = await createExecution();
    const reviewId = await createReview();
    const proposal = await proposals.createProposal({
      workspaceId, operatorUserId: userId, origin: { type: "operator_mcp_invocation", invocationId: reviewId },
      targetType: "agent_skill", targetRef: { agentId, skillId: skill.id }, payload: { kind: "retrieve" },
      versionToken: skill.updatedAt.toISOString(), evidence: null, reviewDigest: "6".repeat(64), expiresAt: new Date(Date.now() + 60_000),
    });
    const claim = await proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId: executionId, reviewDigest: "6".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 300 });
    if (claim.status !== "claimed") throw new Error(`expected claim, got ${claim.status}`);

    await expect(agentSkillApply.apply({ workspaceId, agentId, skillId: skill.id, expectedUpdatedAt: skill.updatedAt, target: { kind: "retrieve", id: "scope-after" }, config: { limit: 9 }, invocationMode: "routine_named", enabled: false, proposalId: proposal.id, executionInvocationId: randomUUID(), operatorUserId: userId, claimedAt: claim.claim.claimedAt })).rejects.toThrow(/receipt_conflict/u);
    await expect(agentSkills.findById(workspaceId, agentId, skill.id)).resolves.toMatchObject({ targetId: "scope-before", config: { limit: 3 }, enabled: true });
  });

  it("refuses legacy, expired, canceled, and mismatched reviewed executions without claiming", async () => {
    const execute = (proposalId: string, overrides: Record<string, unknown> = {}) => proposals.claimMcpReviewedProposalApply({
      proposalId, executionInvocationId, reviewDigest: "c".repeat(64), workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 300, ...overrides,
    });
    expect(reviewedProposalId).not.toBeNull(); const proposalId = reviewedProposalId!;
    await database.query("UPDATE copilot_proposals SET review_digest = NULL, expires_at = NULL, execution_invocation_id = NULL, apply_started_at = NULL WHERE id = $1", [proposalId]);
    await expect(execute(proposalId)).resolves.toMatchObject({ status: "digest_mismatch" });
    await database.query("UPDATE copilot_proposals SET review_digest = $1, expires_at = $2 WHERE id = $3", ["d".repeat(64), new Date(Date.now() - 1_000), proposalId]);
    await expect(execute(proposalId, { reviewDigest: "d".repeat(64) })).resolves.toMatchObject({ status: "expired" });
    await database.query("UPDATE copilot_proposals SET review_digest = $1, expires_at = $2, status = 'dismissed' WHERE id = $3", ["e".repeat(64), new Date(Date.now() + 60_000), proposalId]);
    await expect(execute(proposalId, { reviewDigest: "e".repeat(64) })).resolves.toMatchObject({ status: "canceled" });
    await database.query("UPDATE copilot_proposals SET review_digest = $1, status = 'pending' WHERE id = $2", ["c".repeat(64), proposalId]);
    await expect(execute(proposalId, { grantId: randomUUID() })).resolves.toMatchObject({ status: "binding_mismatch" });
    await expect(execute(proposalId, { operatorUserId: randomUUID() })).resolves.toMatchObject({ status: "missing" });
    await expect(execute(proposalId, { executionInvocationId: randomUUID() })).resolves.toMatchObject({ status: "binding_mismatch" });
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
