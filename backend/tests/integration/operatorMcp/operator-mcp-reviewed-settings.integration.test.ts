import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { AgentRepository } from "../../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaceRepository.js";
import { IngestionSettingsRepository } from "../../../src/db/repositories/ingestionSettingsRepository.js";
import { CopilotRepository } from "../../../src/db/repositories/copilotRepository.js";
import { AgentService } from "../../../src/modules/agents/public.js";
import { IngestionSettingsService } from "../../../src/modules/settings/services/ingestionSettingsService.js";
import { AuditService } from "../../../src/modules/audit/services/auditService.js";
import { validateIngestionSettings } from "../../../src/modules/settings/domain/ingestionSettings.js";
import { createAgentSettingCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/proposalAdapters.js";
import { createIngestionSettingsCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/ingestionSettingsProposalAdapter.js";
import { createReviewedReceiptSettlement } from "../../../src/app/composition/copilotReviewedReceiptSettlement.js";
import { createLogger } from "../../../src/shared/observability/logger.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const noopAuditRepository = {
  async create() {
    return { id: randomUUID(), accountId: null, workspaceId: null, eventType: "", eventStatus: "", metadata: {}, createdAt: new Date() };
  },
} as never;

describeIntegration("reviewed agent settings and ingestion settings execution (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const agentRepository = new AgentRepository(database.kysely);
  const workspaceRepository = new WorkspaceRepository(database.kysely);
  const agentService = new AgentService(agentRepository, workspaceRepository);
  const ingestionRepository = new IngestionSettingsRepository(database.kysely);
  const ingestionService = new IngestionSettingsService(ingestionRepository, new AuditService(createLogger("silent"), noopAuditRepository));
  const proposals = new CopilotRepository(database.kysely);
  const reviewedReceipt = createReviewedReceiptSettlement(database.kysely);
  const agentAdapter = createAgentSettingCopilotProposalAdapter({ agentService, reviewedReceipt });
  const ingestionAdapter = createIngestionSettingsCopilotProposalAdapter({ ingestionSettings: ingestionService, reviewedReceipt });

  const resource = `https://mcp.example/${randomUUID()}/operator/mcp`;
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const clientId = randomUUID();
  const snapshotId = randomUUID();
  const grantId = randomUUID();
  const credentialId = randomUUID();

  const createInvocation = async (descriptorName: string, shape: "propose" | "act", status: "running" | "admitted"): Promise<string> => {
    const id = randomUUID();
    await database.query(
      "INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, operation_id, input_digest, proof_nonce_digest, status, retained_until) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'tools/call', $8, $9, $10, 'v1:input', $11, $12, NOW() + INTERVAL '30 days')",
      [id, credentialId, grantId, accountId, workspaceId, userId, clientId, descriptorName, shape, randomUUID(), `nonce-${id}`, status],
    );
    return id;
  };

  /** Prepares a reviewed proposal row bound to a fresh review+execution invocation pair, and claims it — the exact state `OperatorCopilotService.executeMcpReviewedProposal` hands a proposal adapter. */
  const prepareClaim = async (input: {
    readonly targetType: "agent_setting" | "ingestion_settings";
    readonly targetRef: unknown;
    readonly payload: unknown;
    readonly preparedBy: "prepare_agent_settings" | "prepare_ingestion_settings";
    readonly claimTtlSeconds?: number;
  }) => {
    const reviewId = await createInvocation(input.preparedBy, "propose", "running");
    const executionInvocationId = await createInvocation("execute_reviewed_proposal", "act", "admitted");
    const reviewDigest = randomUUID().replace(/-/gu, "");
    const proposal = await proposals.createProposal({
      workspaceId, operatorUserId: userId, origin: { type: "operator_mcp_invocation", invocationId: reviewId },
      targetType: input.targetType, targetRef: input.targetRef, payload: input.payload,
      versionToken: "unused", evidence: null, reviewDigest, expiresAt: new Date(Date.now() + 60_000),
    });
    const claimTtlSeconds = input.claimTtlSeconds ?? 300;
    const claim = await proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId, reviewDigest, workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds });
    if (claim.status !== "claimed") throw new Error(`expected claim, got ${claim.status}`);
    const applyContext = { surface: "mcp" as const, accountId, executionInvocationId, proposalId: proposal.id, applyClaimedAt: claim.claim.claimedAt, operatorUserId: userId };
    return { proposal, executionInvocationId, reviewDigest, applyContext };
  };

  const createAgent = (name: string) => agentRepository.create(workspaceId, { name });
  const resetIngestionSettings = () => ingestionRepository.upsert(workspaceId, validateIngestionSettings({
    chunkingStrategy: "fixed_window", fixedWindowChunkSize: 800, fixedWindowChunkOverlap: 120,
    structuredMinChunkSize: 24, structuredMaxChunkSize: 220, embeddingModel: "text-embedding-3-small",
  }));

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Reviewed settings', $2, 'hash')", [accountId, `reviewed-settings-${accountId}@example.com`]);
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [userId, `reviewed-settings-user-${userId}@example.com`]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'admin', 'active')", [membershipId, accountId, userId]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Reviewed settings', $3)", [workspaceId, accountId, `reviewed-settings-${workspaceId}`]);
    await database.query("INSERT INTO operator_mcp_clients (id, client_id, registration_method, application_type, display_name, redirect_uris, metadata_digest) VALUES ($1, $2, 'metadata_document', 'web', 'Client', '[\"https://client.example/callback\"]'::jsonb, 'digest')", [clientId, `https://client.example/${clientId}`]);
    await database.query("INSERT INTO operator_mcp_client_metadata_snapshots (id, client_id, client_version, metadata_digest, normalized_metadata, source, validated_at) VALUES ($1, $2, 1, 'digest', '{}'::jsonb, 'metadata_document', NOW())", [snapshotId, clientId]);
    await database.query("INSERT INTO operator_mcp_deployment_credential_state (resource, credential_epoch, key_fingerprint) VALUES ($1, 1, 'reviewed-settings-key')", [resource]);
    await database.query("INSERT INTO operator_mcp_grants (id, client_id, client_version, client_metadata_snapshot_id, account_id, workspace_id, user_id, membership_id, resource, tool_scopes, credential_epoch) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, ARRAY['operator:propose','operator:write'], 1)", [grantId, clientId, snapshotId, accountId, workspaceId, userId, membershipId, resource]);
    await database.query("INSERT INTO operator_mcp_access_credentials (id, grant_id, token_digest, issued_grant_version, issued_client_version, issued_client_metadata_snapshot_id, issued_credential_epoch, issued_tool_scopes, issued_offline_access, expires_at) VALUES ($1, $2, $3, 1, 1, $4, 1, ARRAY['operator:propose','operator:write'], false, NOW() + INTERVAL '15 minutes')", [credentialId, grantId, `digest-${credentialId}`, snapshotId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM copilot_proposals WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_invocations WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_client_metadata_snapshots WHERE client_id = $1", [clientId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_clients WHERE id = $1", [clientId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_deployment_credential_state WHERE resource = $1", [resource]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("commits the agent-setting compare-and-set and the receipt together, and a lost response replays the original appliedRef", async () => {
    const agent = await createAgent("Support");
    const targetRef = { agentId: agent.id, expectedFields: [{ key: "name", value: "Support" }] };
    const payload = { kind: "fields" as const, patch: { name: "Help Desk" } };
    const { proposal, executionInvocationId, reviewDigest, applyContext } = await prepareClaim({ targetType: "agent_setting", targetRef, payload, preparedBy: "prepare_agent_settings" });

    const applied = await agentAdapter.applyIfVersionMatches(workspaceId, targetRef, payload, "unused", applyContext);
    expect(applied).toEqual({ outcome: "applied", appliedRef: { agentId: agent.id } });
    await expect(agentRepository.findByIdAndWorkspaceId(agent.id, workspaceId)).resolves.toMatchObject({ name: "Help Desk" });

    const replay = await proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId, reviewDigest, workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 300 });
    expect(replay).toEqual({ status: "settled", outcome: "applied", appliedRef: { agentId: agent.id } });
  });

  it("rolls the agent write back when its reviewed receipt cannot settle (a superseded claim)", async () => {
    const agent = await createAgent("Support");
    const targetRef = { agentId: agent.id, expectedFields: [{ key: "name", value: "Support" }] };
    const payload = { kind: "fields" as const, patch: { name: "Help Desk" } };
    const { applyContext } = await prepareClaim({ targetType: "agent_setting", targetRef, payload, preparedBy: "prepare_agent_settings" });
    // A mismatched execution receipt models a claim this attempt no longer holds: the owner write
    // still runs, but the hook cannot settle the receipt it was handed, so the whole write rolls back.
    const superseded = { ...applyContext, executionInvocationId: randomUUID() };

    await expect(agentAdapter.applyIfVersionMatches(workspaceId, targetRef, payload, "unused", superseded)).rejects.toThrow(/receipt_conflict/u);
    await expect(agentRepository.findByIdAndWorkspaceId(agent.id, workspaceId)).resolves.toMatchObject({ name: "Support" });
  });

  it("goes stale with no write when the named field changes concurrently, but applies when an unrelated field changes", async () => {
    const agent = await createAgent("Support");
    const targetRef = { agentId: agent.id, expectedFields: [{ key: "name", value: "Support" }] };
    const payload = { kind: "fields" as const, patch: { name: "Help Desk" } };

    const staleAttempt = await prepareClaim({ targetType: "agent_setting", targetRef, payload, preparedBy: "prepare_agent_settings" });
    await agentRepository.update(agent.id, workspaceId, { name: "Changed elsewhere" });
    await expect(agentAdapter.applyIfVersionMatches(workspaceId, targetRef, payload, "unused", staleAttempt.applyContext))
      .resolves.toEqual({ outcome: "stale", reason: "Field changed: name" });
    await expect(agentRepository.findByIdAndWorkspaceId(agent.id, workspaceId)).resolves.toMatchObject({ name: "Changed elsewhere" });

    // The fence names only `name`; a concurrent change to a different field must not block it.
    const currentName = "Changed elsewhere";
    const unrelatedTargetRef = { agentId: agent.id, expectedFields: [{ key: "name", value: currentName }] };
    const unrelatedAttempt = await prepareClaim({ targetType: "agent_setting", targetRef: unrelatedTargetRef, payload, preparedBy: "prepare_agent_settings" });
    await agentRepository.update(agent.id, workspaceId, { internalName: "changed-internal-name" });
    await expect(agentAdapter.applyIfVersionMatches(workspaceId, unrelatedTargetRef, payload, "unused", unrelatedAttempt.applyContext))
      .resolves.toEqual({ outcome: "applied", appliedRef: { agentId: agent.id } });
    await expect(agentRepository.findByIdAndWorkspaceId(agent.id, workspaceId)).resolves.toMatchObject({ name: "Help Desk", internalName: "changed-internal-name" });
  });

  it("reclaims an agent-setting execution after its lease and writes exactly once", async () => {
    const agent = await createAgent("Support");
    const targetRef = { agentId: agent.id, expectedFields: [{ key: "name", value: "Support" }] };
    const payload = { kind: "fields" as const, patch: { name: "Help Desk" } };
    const { proposal, executionInvocationId, reviewDigest, applyContext } = await prepareClaim({ targetType: "agent_setting", targetRef, payload, preparedBy: "prepare_agent_settings", claimTtlSeconds: 5 });
    // Simulates a crash between the claim and the owner write: the lease is aged past its TTL with
    // no apply ever having run.
    await database.query("UPDATE copilot_proposals SET apply_started_at = NOW() - INTERVAL '10 seconds' WHERE id = $1", [proposal.id]);

    const reclaimed = await proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId, reviewDigest, workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 5 });
    if (reclaimed.status !== "claimed") throw new Error(`expected reclaimed, got ${reclaimed.status}`);
    expect(reclaimed.claim.previousAttemptStartedAt).not.toBeNull();

    // The superseded (pre-reclaim) claim can no longer settle anything.
    await expect(agentAdapter.applyIfVersionMatches(workspaceId, targetRef, payload, "unused", applyContext)).rejects.toThrow(/receipt_conflict/u);
    await expect(agentRepository.findByIdAndWorkspaceId(agent.id, workspaceId)).resolves.toMatchObject({ name: "Support" });

    const reclaimedContext = { ...applyContext, applyClaimedAt: reclaimed.claim.claimedAt };
    await expect(agentAdapter.applyIfVersionMatches(workspaceId, targetRef, payload, "unused", reclaimedContext)).resolves.toEqual({ outcome: "applied", appliedRef: { agentId: agent.id } });
    await expect(agentRepository.findByIdAndWorkspaceId(agent.id, workspaceId)).resolves.toMatchObject({ name: "Help Desk" });
  });

  it("applies several agent settings atomically, updating the agent draft for customInstruction in the same transaction — and none of them when the fence fails", async () => {
    const agent = await createAgent("Support");
    const prepared = await agentService.prepareFieldsProposal(workspaceId, agent.id, { name: "Help Desk", customInstruction: "Be concise and cite sources." });
    const targetRef = { agentId: agent.id, expectedFields: prepared.expectedFields };
    const payload = { kind: "fields" as const, patch: prepared.normalizedPatch };

    // All-or-nothing: an outside writer moves `name` before execution, so the whole operation must refuse.
    const staleAttempt = await prepareClaim({ targetType: "agent_setting", targetRef, payload, preparedBy: "prepare_agent_settings" });
    await agentRepository.update(agent.id, workspaceId, { name: "Changed elsewhere" });
    await expect(agentAdapter.applyIfVersionMatches(workspaceId, targetRef, payload, "unused", staleAttempt.applyContext))
      .resolves.toMatchObject({ outcome: "stale" });
    await expect(database.query("SELECT snapshot FROM agent_drafts WHERE agent_id = $1", [agent.id]))
      .resolves.toMatchObject([{ snapshot: expect.objectContaining({ customInstruction: expect.not.stringMatching("Be concise and cite sources.") }) }]);

    // Reset the fence to the field's current value and apply for real: both fields land together.
    await agentRepository.update(agent.id, workspaceId, { name: "Support" });
    const freshTargetRef = { agentId: agent.id, expectedFields: prepared.expectedFields };
    const attempt = await prepareClaim({ targetType: "agent_setting", targetRef: freshTargetRef, payload, preparedBy: "prepare_agent_settings" });
    await expect(agentAdapter.applyIfVersionMatches(workspaceId, freshTargetRef, payload, "unused", attempt.applyContext))
      .resolves.toEqual({ outcome: "applied", appliedRef: { agentId: agent.id } });
    await expect(agentRepository.findByIdAndWorkspaceId(agent.id, workspaceId)).resolves.toMatchObject({ name: "Help Desk" });
    await expect(database.query("SELECT snapshot FROM agent_drafts WHERE agent_id = $1", [agent.id]))
      .resolves.toMatchObject([{ snapshot: expect.objectContaining({ customInstruction: "Be concise and cite sources." }) }]);
  });

  it("commits the ingestion-settings compare-and-set and the receipt together, and a lost response replays the original appliedRef", async () => {
    await resetIngestionSettings();
    const targetRef = { expectedFields: { fixedWindowChunkSize: 800 } };
    const payload = { name: "Ingestion settings" as const, chunkingStrategy: "fixed_window" as const, fixedWindowChunkSize: 1_500, fixedWindowChunkOverlap: 120, structuredMinChunkSize: 24, structuredMaxChunkSize: 220 };
    const { proposal, executionInvocationId, reviewDigest, applyContext } = await prepareClaim({ targetType: "ingestion_settings", targetRef, payload, preparedBy: "prepare_ingestion_settings" });

    const applied = await ingestionAdapter.applyIfVersionMatches(workspaceId, targetRef, payload, "unused", applyContext);
    expect(applied).toEqual({ outcome: "applied", appliedRef: { workspaceId } });
    await expect(ingestionRepository.findByWorkspaceId(workspaceId)).resolves.toMatchObject({ fixedWindowChunkSize: 1_500 });

    const replay = await proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId, reviewDigest, workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 300 });
    expect(replay).toEqual({ status: "settled", outcome: "applied", appliedRef: { workspaceId } });
  });

  it("rolls the ingestion write back when its reviewed receipt cannot settle (a superseded claim)", async () => {
    await resetIngestionSettings();
    const targetRef = { expectedFields: { fixedWindowChunkSize: 800 } };
    const payload = { name: "Ingestion settings" as const, chunkingStrategy: "fixed_window" as const, fixedWindowChunkSize: 1_500, fixedWindowChunkOverlap: 120, structuredMinChunkSize: 24, structuredMaxChunkSize: 220 };
    const { applyContext } = await prepareClaim({ targetType: "ingestion_settings", targetRef, payload, preparedBy: "prepare_ingestion_settings" });
    const superseded = { ...applyContext, executionInvocationId: randomUUID() };

    await expect(ingestionAdapter.applyIfVersionMatches(workspaceId, targetRef, payload, "unused", superseded)).rejects.toThrow(/receipt_conflict/u);
    await expect(ingestionRepository.findByWorkspaceId(workspaceId)).resolves.toMatchObject({ fixedWindowChunkSize: 800 });
  });

  it("goes stale with no write when the named ingestion field changes concurrently, but applies when an unrelated field changes", async () => {
    await resetIngestionSettings();
    const targetRef = { expectedFields: { fixedWindowChunkSize: 800 } };
    const payload = { name: "Ingestion settings" as const, chunkingStrategy: "fixed_window" as const, fixedWindowChunkSize: 1_500, fixedWindowChunkOverlap: 120, structuredMinChunkSize: 24, structuredMaxChunkSize: 220 };

    const staleAttempt = await prepareClaim({ targetType: "ingestion_settings", targetRef, payload, preparedBy: "prepare_ingestion_settings" });
    await database.query("UPDATE ingestion_settings SET fixed_window_chunk_size = 1000, revision = revision + 1, updated_at = NOW() WHERE workspace_id = $1", [workspaceId]);
    await expect(ingestionAdapter.applyIfVersionMatches(workspaceId, targetRef, payload, "unused", staleAttempt.applyContext))
      .resolves.toEqual({ outcome: "stale", reason: "Field changed: fixedWindowChunkSize" });
    await expect(ingestionRepository.findByWorkspaceId(workspaceId)).resolves.toMatchObject({ fixedWindowChunkSize: 1_000 });

    const unrelatedTargetRef = { expectedFields: { fixedWindowChunkSize: 1_000 } };
    const unrelatedPayload = { ...payload, fixedWindowChunkSize: 1_500 };
    const unrelatedAttempt = await prepareClaim({ targetType: "ingestion_settings", targetRef: unrelatedTargetRef, payload: unrelatedPayload, preparedBy: "prepare_ingestion_settings" });
    await database.query("UPDATE ingestion_settings SET document_enrichment_enabled = true, revision = revision + 1, updated_at = NOW() WHERE workspace_id = $1", [workspaceId]);
    await expect(ingestionAdapter.applyIfVersionMatches(workspaceId, unrelatedTargetRef, unrelatedPayload, "unused", unrelatedAttempt.applyContext))
      .resolves.toEqual({ outcome: "applied", appliedRef: { workspaceId } });
    await expect(ingestionRepository.findByWorkspaceId(workspaceId)).resolves.toMatchObject({ fixedWindowChunkSize: 1_500, documentEnrichmentEnabled: true });
  });

  it("reclaims an ingestion-settings execution after its lease and writes exactly once", async () => {
    await resetIngestionSettings();
    const targetRef = { expectedFields: { fixedWindowChunkSize: 800 } };
    const payload = { name: "Ingestion settings" as const, chunkingStrategy: "fixed_window" as const, fixedWindowChunkSize: 1_500, fixedWindowChunkOverlap: 120, structuredMinChunkSize: 24, structuredMaxChunkSize: 220 };
    const { proposal, executionInvocationId, reviewDigest, applyContext } = await prepareClaim({ targetType: "ingestion_settings", targetRef, payload, preparedBy: "prepare_ingestion_settings", claimTtlSeconds: 5 });
    await database.query("UPDATE copilot_proposals SET apply_started_at = NOW() - INTERVAL '10 seconds' WHERE id = $1", [proposal.id]);

    const reclaimed = await proposals.claimMcpReviewedProposalApply({ proposalId: proposal.id, executionInvocationId, reviewDigest, workspaceId, operatorUserId: userId, grantId, clientId, now: new Date(), claimTtlSeconds: 5 });
    if (reclaimed.status !== "claimed") throw new Error(`expected reclaimed, got ${reclaimed.status}`);

    await expect(ingestionAdapter.applyIfVersionMatches(workspaceId, targetRef, payload, "unused", applyContext)).rejects.toThrow(/receipt_conflict/u);
    await expect(ingestionRepository.findByWorkspaceId(workspaceId)).resolves.toMatchObject({ fixedWindowChunkSize: 800 });

    const reclaimedContext = { ...applyContext, applyClaimedAt: reclaimed.claim.claimedAt };
    await expect(ingestionAdapter.applyIfVersionMatches(workspaceId, targetRef, payload, "unused", reclaimedContext)).resolves.toEqual({ outcome: "applied", appliedRef: { workspaceId } });
    await expect(ingestionRepository.findByWorkspaceId(workspaceId)).resolves.toMatchObject({ fixedWindowChunkSize: 1_500 });
  });

  it("refuses a coupled-field validation failure discovered under lock as failed, without writing anything", async () => {
    await resetIngestionSettings();
    // Fences only `fixedWindowChunkSize`; overlap is not named, so a concurrent overlap change is
    // not caught by the CAS and only surfaces when the merged, locked state is validated.
    const targetRef = { expectedFields: { fixedWindowChunkSize: 800 } };
    const payload = { name: "Ingestion settings" as const, chunkingStrategy: "fixed_window" as const, fixedWindowChunkSize: 500, fixedWindowChunkOverlap: 120, structuredMinChunkSize: 24, structuredMaxChunkSize: 220 };
    const { applyContext } = await prepareClaim({ targetType: "ingestion_settings", targetRef, payload, preparedBy: "prepare_ingestion_settings" });
    // Independently valid (600 < 800) at the moment it is written, but it makes the pending
    // 500-byte window proposal invalid once the two combine under the row lock.
    await database.query("UPDATE ingestion_settings SET fixed_window_chunk_overlap = 600, revision = revision + 1, updated_at = NOW() WHERE workspace_id = $1", [workspaceId]);

    await expect(ingestionAdapter.applyIfVersionMatches(workspaceId, targetRef, payload, "unused", applyContext))
      .resolves.toMatchObject({ outcome: "failed", reason: expect.stringContaining("smaller than") });
    await expect(ingestionRepository.findByWorkspaceId(workspaceId)).resolves.toMatchObject({ fixedWindowChunkSize: 800, fixedWindowChunkOverlap: 600 });
  });
});
