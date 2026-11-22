import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createReviewedReceiptSettlement } from "../../../src/app/composition/copilotReviewedReceiptSettlement.js";
import { AccountRepository } from "../../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../../src/db/repositories/agentRepository.js";
import { ContextVariableRepository } from "../../../src/db/repositories/contextVariableRepository.js";
import { CopilotRepository } from "../../../src/db/repositories/copilotRepository.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaceRepository.js";
import { ContextVariableService } from "../../../src/modules/context-variables/public.js";
import { createContextVariableCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/contextVariableProposalAdapter.js";
import type { CopilotProposalApplyContext } from "../../../src/modules/operatorCopilot/contracts.js";
import { firstPartyCopilotProposalTargetTypes } from "../../../src/modules/operatorCopilot/proposalContribution.js";
import { createContextVariableReviewedPreparationTool } from "../../../src/modules/operatorCopilot/tools/contextVariableReviewedPreparation.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("reviewed context-variable changes, prepared, approved and executed over the operator MCP seam", () => {
  const database = new Database(integrationDatabaseUrl);
  const accountRepository = new AccountRepository(database.kysely);
  const workspaceRepository = new WorkspaceRepository(database.kysely);
  const agentRepository = new AgentRepository(database.kysely);
  const contextVariableRepository = new ContextVariableRepository(database.kysely);
  const proposals = new CopilotRepository(database.kysely, firstPartyCopilotProposalTargetTypes);
  const contextVariables = new ContextVariableService({
    repository: contextVariableRepository,
    agentReader: { get: async (workspaceId, agentId) => agentRepository.findByIdAndWorkspaceId(agentId, workspaceId) },
    agentSkillsReader: { list: async () => [] },
  });
  const adapter = createContextVariableCopilotProposalAdapter({
    contextVariables,
    reviewedReceipt: createReviewedReceiptSettlement(database.kysely, firstPartyCopilotProposalTargetTypes),
  });

  const accountIds: string[] = [];
  const resource = `https://mcp.example/${randomUUID()}/operator/mcp`;

  beforeAll(async () => {
    await database.query("INSERT INTO operator_mcp_deployment_credential_state (resource, credential_epoch, key_fingerprint) VALUES ($1, 1, 'reviewed-context-variables-key')", [resource]);
  });

  afterAll(async () => {
    for (const accountId of accountIds) {
      await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    }
    await database.query("DELETE FROM operator_mcp_deployment_credential_state WHERE resource = $1", [resource]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  /** The account, workspace, agent and MCP client/grant/credential/invocation chain a `prepare_context_variable` call leaves behind. */
  const createFixture = async () => {
    const account = await accountRepository.create({ name: "Reviewed Attributes", email: `reviewed-attributes-${randomUUID()}@example.com`, passwordHash: "hash" });
    accountIds.push(account.id);
    const workspace = await workspaceRepository.create(account.id, "Reviewed Attributes Workspace");
    const agent = await agentRepository.create(workspace.id, { name: "Reviewed Attributes Agent" });
    const operatorUserId = randomUUID();
    const membershipId = randomUUID();
    const clientId = randomUUID();
    const snapshotId = randomUUID();
    const grantId = randomUUID();
    const credentialId = randomUUID();
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [operatorUserId, `reviewed-attributes-user-${operatorUserId}@example.com`]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'admin', 'active')", [membershipId, account.id, operatorUserId]);
    await database.query("INSERT INTO operator_mcp_clients (id, client_id, registration_method, application_type, display_name, redirect_uris, metadata_digest) VALUES ($1, $2, 'metadata_document', 'web', 'Client', '[\"https://client.example/callback\"]'::jsonb, 'digest')", [clientId, `https://client.example/${clientId}`]);
    await database.query("INSERT INTO operator_mcp_client_metadata_snapshots (id, client_id, client_version, metadata_digest, normalized_metadata, source, validated_at) VALUES ($1, $2, 1, 'digest', '{}'::jsonb, 'metadata_document', NOW())", [snapshotId, clientId]);
    await database.query("INSERT INTO operator_mcp_grants (id, client_id, client_version, client_metadata_snapshot_id, account_id, workspace_id, user_id, membership_id, resource, tool_scopes, credential_epoch) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, ARRAY['operator:propose', 'operator:write'], 1)", [grantId, clientId, snapshotId, account.id, workspace.id, operatorUserId, membershipId, resource]);
    await database.query("INSERT INTO operator_mcp_access_credentials (id, grant_id, token_digest, issued_grant_version, issued_client_version, issued_client_metadata_snapshot_id, issued_credential_epoch, issued_tool_scopes, issued_offline_access, expires_at) VALUES ($1, $2, $3, 1, 1, $4, 1, ARRAY['operator:propose', 'operator:write'], false, NOW() + INTERVAL '15 minutes')", [credentialId, grantId, `digest-${credentialId}`, snapshotId]);
    return { account, workspace, agent, operatorUserId, grantId, clientId, credentialId };
  };
  type Fixture = Awaited<ReturnType<typeof createFixture>>;

  const invocation = async (fixture: Fixture, descriptorName: string, shape: string) => {
    const invocationId = randomUUID();
    await database.query(
      "INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, operation_id, input_digest, proof_nonce_digest, status, retained_until) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'tools/call', $8, $9, $10, 'v1:input', $11, 'running', NOW() + INTERVAL '30 days')",
      [invocationId, fixture.credentialId, fixture.grantId, fixture.account.id, fixture.workspace.id, fixture.operatorUserId, fixture.clientId, descriptorName, shape, randomUUID(), `nonce-${invocationId}`],
    );
    return invocationId;
  };

  /** `prepare_context_variable` exactly as an MCP client calls it, over the real proposal store and owner. */
  const prepare = async (fixture: Fixture, input: Record<string, unknown>) => {
    const tool = createContextVariableReviewedPreparationTool({
      proposalRepository: proposals,
      proposalRecovery: { recoverOperatorMcpProposal: vi.fn() },
      proposalAdapters: [adapter],
      auditService: { record: vi.fn() },
      agentService: { listExisting: async () => [{ id: fixture.agent.id, name: fixture.agent.name, isDefault: true, assistantBootstrapActive: false }] },
      contextVariables,
      appBaseUrl: "https://app.example",
    } as never).createTool({
      workspaceId: fixture.workspace.id, accountId: fixture.account.id, operatorUserId: fixture.operatorUserId, surface: "mcp",
      operatorMcpInvocationId: await invocation(fixture, "prepare_context_variable", "propose"), operatorMcpGrantId: fixture.grantId, operatorMcpClientId: fixture.clientId,
      currentAuthorization: { hasAllPermissions: async () => true },
      pageContext: { view: "other", agentId: null, conversationId: null, selection: null, entities: [] },
    } as never);
    return tool.invoke({ agentId: fixture.agent.id, ...input } as never, {} as never) as Promise<{
      proposalId: string; reviewDigest: string; confirmation: { requirement: string }; review: Record<string, unknown>;
    }>;
  };

  /** The approval when the review asks for one, then the claim and the owner's apply `execute_reviewed_proposal` runs. */
  const execute = async (fixture: Fixture, prepared: { proposalId: string; reviewDigest: string; confirmation: { requirement: string } }) => {
    if (prepared.confirmation.requirement === "signed_in_approval") {
      await expect(proposals.approveMcpReviewedProposal({ proposalId: prepared.proposalId, workspaceId: fixture.workspace.id, operatorUserId: fixture.operatorUserId, reviewDigest: prepared.reviewDigest, now: new Date() }))
        .resolves.toMatchObject({ status: "approved" });
    }
    const executionInvocationId = await invocation(fixture, "execute_reviewed_proposal", "act");
    const claimInput = {
      proposalId: prepared.proposalId, executionInvocationId, reviewDigest: prepared.reviewDigest, workspaceId: fixture.workspace.id,
      operatorUserId: fixture.operatorUserId, grantId: fixture.grantId, clientId: fixture.clientId, now: new Date(), claimTtlSeconds: 300,
    };
    const claimed = await proposals.claimMcpReviewedProposalApply(claimInput);
    if (claimed.status !== "claimed") throw new Error(`expected claim, got ${claimed.status}`);
    const { proposal, claimedAt } = claimed.claim;
    const context: CopilotProposalApplyContext = { surface: "mcp", accountId: fixture.account.id, proposalId: proposal.id, executionInvocationId, applyClaimedAt: claimedAt, operatorUserId: fixture.operatorUserId };
    const result = await adapter.applyIfVersionMatches(fixture.workspace.id, proposal.targetRef, proposal.payload, proposal.versionToken, context);
    // The receipt committed with the owner's writes, so a lost response replays as applied.
    const replay = await proposals.claimMcpReviewedProposalApply({ ...claimInput, now: new Date() });
    return { result, replay };
  };

  it("creates a Choice attribute after signed-in approval, then has the agent classify it in its draft", async () => {
    const fixture = await createFixture();

    const created = await prepare(fixture, {
      kind: "create", name: "topic", description: "What the visitor needs.", valueType: "enum",
      options: [{ key: "billing", label: "Billing", description: "Invoices and refunds." }, { key: "shipping", label: "Shipping" }],
      trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
    });
    expect(created.confirmation.requirement).toBe("signed_in_approval");
    expect(created.review).toMatchObject({ definition: { lifecycle: "live" }, publicationRequired: false });

    const applied = await execute(fixture, created);
    expect(applied.result.outcome).toBe("applied");
    const variableId = (applied.result as { appliedRef: { variableId: string } }).appliedRef.variableId;
    expect(applied.replay).toEqual({ status: "settled", outcome: "applied", appliedRef: { agentId: fixture.agent.id, variableId } });
    await expect(contextVariables.get(fixture.workspace.id, variableId)).resolves.toMatchObject({ name: "topic", valueType: "enum" });

    const classify = await prepare(fixture, { kind: "set_enablement", variableId, enablement: { source: "classified", surfacing: "on_reference" } });
    expect(classify.confirmation.requirement).toBe("conversation");
    expect(classify.review).toMatchObject({ enablement: { before: null, after: { source: "classified" }, lifecycle: "agent_draft" }, publicationRequired: true });

    const enabled = await execute(fixture, classify);
    expect(enabled.result.outcome).toBe("applied");
    await expect(contextVariables.listByAgent(fixture.workspace.id, fixture.agent.id)).resolves.toEqual([
      expect.objectContaining({ variableId, source: "classified", surfacing: "on_reference", enabled: true }),
    ]);
    const draft = await database.queryOptional<{ snapshot: { contextVariableEnablements: Array<{ variableId: string; source: string }> } }>(
      "SELECT snapshot FROM agent_drafts WHERE agent_id = $1", [fixture.agent.id],
    );
    expect(draft?.snapshot.contextVariableEnablements).toEqual([expect.objectContaining({ variableId, source: "classified" })]);
  });

  it("refuses to prepare classification of a Text attribute, and reports a definition another writer changed as stale", async () => {
    const fixture = await createFixture();
    const plan = await contextVariables.create({ workspaceId: fixture.workspace.id, name: "plan", valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always" });

    await expect(prepare(fixture, { kind: "set_enablement", variableId: plan.id, enablement: { source: "classified", surfacing: "on_reference" } }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Only a Choice \(enum\) attribute/u) });

    const edit = await prepare(fixture, { kind: "edit", variableId: plan.id, description: "The customer's plan." });
    await contextVariables.update(fixture.workspace.id, plan.id, { description: "Changed by a teammate meanwhile." });
    const stale = await execute(fixture, edit);
    expect(stale.result.outcome).toBe("stale");
    await expect(contextVariables.get(fixture.workspace.id, plan.id)).resolves.toMatchObject({ description: "Changed by a teammate meanwhile." });
  });
});
