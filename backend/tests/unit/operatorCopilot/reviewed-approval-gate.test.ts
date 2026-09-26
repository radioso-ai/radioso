import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";
import { createReviewedProposalExecutionTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalExecution.js";
import { OperatorCopilotService } from "../../../src/modules/operatorCopilot/service.js";
import { canonicalReviewedOperationDigest } from "../../../src/modules/operatorCopilot/reviewedOperation.js";
import type { CopilotAuditPort, CopilotProposalAdapter, CopilotProposalDraft } from "../../../src/modules/operatorCopilot/contracts.js";
import type { OperatorMcpBoundGrantClientDescriptionPort } from "../../../src/modules/operatorMcpAuthorization/contracts.js";
import { InMemoryCopilotRepository } from "../../support/inMemoryCopilotRepository.js";

/**
 * Design §5.3/§5.4: `execute_reviewed_proposal` refuses a `signed_in_approval` operation until the
 * grant's own user has approved its exact digest in a signed-in dashboard session, and never
 * applies the approval itself. These tests drive that gate through the real `OperatorCopilotService`
 * and the real `execute_reviewed_proposal` descriptor over `OperatorMcpCatalogService.invoke`, the
 * same path an MCP client's execute call takes; only Postgres's row locking is out of reach for an
 * in-memory repository, so the exact claim/expiry race is proven separately in the integration suite.
 */

const workspaceId = randomUUID();
const accountId = randomUUID();
const operatorUserId = randomUUID();
const anotherOperatorUserId = randomUUID();
const grantId = randomUUID();
const clientId = randomUUID();
const appBaseUrl = "https://app.radioso.ai";

const permissiveAuthorization = { hasAllPermissions: vi.fn(async () => true) };
type ApprovalMetrics = {
  incrementCounter(name: string, options: { help: string; labels: Record<string, string> }): void;
  observeHistogram(name: string, options: { help: string; value: number; buckets: number[] }): void;
};

const directiveAdapter = (): CopilotProposalAdapter => ({
  targetType: "directive",
  readVersionToken: vi.fn(async () => "v1"),
  preview: vi.fn(),
  applyIfVersionMatches: vi.fn(async () => ({ outcome: "applied" as const, appliedRef: { directiveId: "directive-1" } })),
}) as never;

const buildService = (
  repository: InMemoryCopilotRepository,
  adapter: CopilotProposalAdapter,
  options: {
    auditService?: CopilotAuditPort;
    metrics?: ApprovalMetrics;
    reviewedGrantClient?: OperatorMcpBoundGrantClientDescriptionPort;
  } = {},
) => new OperatorCopilotService({
  repository,
  capabilityRunner: { runStreaming: vi.fn() },
  usageLimitPolicy: {} as never,
  auditService: options.auditService ?? { record: vi.fn() },
  workspaceRouteKeyResolver: { resolveWorkspaceKey: vi.fn(async () => "workspace-key") },
  prompt: "system",
  tools: [],
  currentAuthorization: permissiveAuthorization,
  proposalAdapters: [adapter],
  appBaseUrl,
  reviewedApprovalMetrics: options.metrics,
  reviewedGrantClient: options.reviewedGrantClient,
});

const executeCatalog = (service: OperatorCopilotService) => new OperatorMcpCatalogService([
  { ...createReviewedProposalExecutionTool(service), mcpDisposition: operatorMcpDispositions.execute_reviewed_proposal },
]);

const mcpContext = (invocationId: string) => ({
  workspaceId, accountId, operatorUserId, surface: "mcp" as const,
  currentAuthorization: permissiveAuthorization,
  operatorMcpInvocationId: invocationId,
  operatorMcpGrantId: grantId,
  operatorMcpClientId: clientId,
  pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
});

/** Seeds a reviewed directive proposal at the exact digest `execute_reviewed_proposal` must confirm. */
const seedReviewedProposal = async (
  repository: InMemoryCopilotRepository,
  overrides: Partial<Pick<CopilotProposalDraft, "confirmationRequirement" | "changeEffect" | "expiresAt">> = {},
) => {
  const targetRef = { agentId: randomUUID(), directiveId: randomUUID() };
  const payload = { name: "Updated" };
  const versionToken = "v1";
  const reviewSnapshot = { review: "value" };
  const reviewDigest = canonicalReviewedOperationDigest({ targetRef, payload, versionToken, reviewSnapshot });
  const confirmationRequirement = overrides.confirmationRequirement ?? "signed_in_approval";
  const proposal = await repository.createProposal({
    workspaceId, operatorUserId,
    origin: { type: "operator_mcp_invocation", invocationId: randomUUID() },
    targetType: "directive", targetRef, payload, versionToken, evidence: null,
    reviewDigest, reviewSnapshot,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 15 * 60_000),
    confirmationRequirement,
    changeEffect: overrides.changeEffect ?? (confirmationRequirement === "signed_in_approval"
      ? { exposure: "live", reversibility: "reversible", metered: false }
      : { exposure: "draft", reversibility: "reversible", metered: false }),
  });
  return { proposal, reviewDigest };
};

describe("execute_reviewed_proposal through the operator MCP catalog, driven by the real OperatorCopilotService", () => {
  it("returns approval_required with an absolute approval link and writes nothing when a live operation has no approval", async () => {
    const repository = new InMemoryCopilotRepository();
    const adapter = directiveAdapter();
    const service = buildService(repository, adapter);
    const catalog = executeCatalog(service);
    const { proposal, reviewDigest } = await seedReviewedProposal(repository);

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContext(randomUUID()), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    });

    expect(output).toMatchObject({
      status: "approval_required",
      approval: { url: expect.stringMatching(/^https:\/\/app\.radioso\.ai\/oauth\/operator-mcp\/proposal\//), expiresAt: expect.any(String), effect: { exposure: "live" } },
    });
    expect(adapter.applyIfVersionMatches).not.toHaveBeenCalled();
    await expect(repository.findProposal({ id: proposal.id, workspaceId, operatorUserId })).resolves.toMatchObject({ status: "pending" });
  });

  it("records the approval gate's audits and low-cardinality metrics", async () => {
    const repository = new InMemoryCopilotRepository();
    const auditService = { record: vi.fn<CopilotAuditPort["record"]>(async () => {}) };
    const metrics: ApprovalMetrics = {
      incrementCounter: vi.fn<(name: string, options: { help: string; labels: Record<string, string> }) => void>(),
      observeHistogram: vi.fn<(name: string, options: { help: string; value: number; buckets: number[] }) => void>(),
    };
    const reviewedGrantClient = { describeBoundGrantClient: vi.fn<OperatorMcpBoundGrantClientDescriptionPort["describeBoundGrantClient"]>(async () => ({ clientId: "client-record-1", clientName: "Operator test client" })) };
    const service = buildService(repository, directiveAdapter(), { auditService, metrics, reviewedGrantClient });
    const catalog = executeCatalog(service);
    const { proposal, reviewDigest } = await seedReviewedProposal(repository);

    await expect(catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContext(randomUUID()), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    })).resolves.toMatchObject({ status: "approval_required" });
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "copilot.proposal.apply_denied", eventStatus: "failure", metadata: expect.objectContaining({ reason: "approval_required" }),
    }));
    expect(metrics.incrementCounter).toHaveBeenCalledWith("operator_mcp_reviewed_approval_total", expect.objectContaining({ labels: { requirement: "signed_in_approval", outcome: "required_at_execute" } }));

    await expect(service.approveReviewedProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id, reviewDigest })).resolves.toEqual({ status: "approved" });
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "copilot.proposal.approved", metadata: expect.objectContaining({ clientId: "client-record-1" }),
    }));
    expect(metrics.observeHistogram).toHaveBeenCalledWith("operator_mcp_reviewed_approval_latency_seconds", expect.objectContaining({ buckets: expect.any(Array) }));

    const declined = await seedReviewedProposal(repository);
    await expect(service.dismissProposal({ workspaceId, accountId, operatorUserId, surface: "dashboard", proposalId: declined.proposal.id, reason: "declined" })).resolves.toEqual({ status: "dismissed" });
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "copilot.proposal.dismissed", metadata: expect.objectContaining({ outcome: "declined", reason: "declined" }),
    }));
    expect(metrics.incrementCounter).toHaveBeenCalledWith("operator_mcp_reviewed_approval_total", expect.objectContaining({ labels: { requirement: "signed_in_approval", outcome: "declined" } }));
  });

  it("applies once the grant's own user has approved the exact digest", async () => {
    const repository = new InMemoryCopilotRepository();
    const adapter = directiveAdapter();
    const service = buildService(repository, adapter);
    const catalog = executeCatalog(service);
    const { proposal, reviewDigest } = await seedReviewedProposal(repository);

    await expect(service.approveReviewedProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id, reviewDigest })).resolves.toEqual({ status: "approved" });

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContext(randomUUID()), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    });

    expect(output).toMatchObject({ status: "applied", appliedRef: { directiveId: "directive-1" } });
    expect(adapter.applyIfVersionMatches).toHaveBeenCalledOnce();
  });

  it("refuses an approval attempt by another user of the same account, and execution still asks for approval", async () => {
    const repository = new InMemoryCopilotRepository();
    const adapter = directiveAdapter();
    const service = buildService(repository, adapter);
    const catalog = executeCatalog(service);
    const { proposal, reviewDigest } = await seedReviewedProposal(repository);

    // The MCP grant scopes approval to its own user; a different operator in the same account
    // finds no such proposal to approve, exactly as an unrelated proposal id would.
    await expect(service.approveReviewedProposal({ workspaceId, accountId, operatorUserId: anotherOperatorUserId, proposalId: proposal.id, reviewDigest })).resolves.toEqual({ status: "not_found" });

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContext(randomUUID()), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    });
    expect(output).toMatchObject({ status: "approval_required" });
    expect(adapter.applyIfVersionMatches).not.toHaveBeenCalled();
  });

  it("refuses execution after the operation is declined on the approval page", async () => {
    const repository = new InMemoryCopilotRepository();
    const adapter = directiveAdapter();
    const service = buildService(repository, adapter);
    const catalog = executeCatalog(service);
    const { proposal, reviewDigest } = await seedReviewedProposal(repository);

    await expect(service.dismissProposal({ workspaceId, accountId, operatorUserId, surface: "dashboard", proposalId: proposal.id })).resolves.toEqual({ status: "dismissed" });

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContext(randomUUID()), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    });
    expect(output).toMatchObject({ status: "refused", reason: "canceled" });
    expect(adapter.applyIfVersionMatches).not.toHaveBeenCalled();
  });

  it("refuses an approval recorded against a different digest than the one currently reviewed", async () => {
    const repository = new InMemoryCopilotRepository();
    const service = buildService(repository, directiveAdapter());
    const { proposal } = await seedReviewedProposal(repository);

    await expect(service.approveReviewedProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id, reviewDigest: "z".repeat(43) })).resolves.toEqual({ status: "digest_mismatch" });
  });

  it("refuses an approval attempted after the reviewed operation has expired", async () => {
    const repository = new InMemoryCopilotRepository();
    const service = buildService(repository, directiveAdapter());
    const { proposal, reviewDigest } = await seedReviewedProposal(repository, { expiresAt: new Date(Date.now() - 1_000) });

    await expect(service.approveReviewedProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id, reviewDigest })).resolves.toEqual({ status: "expired" });
  });

  it("still executes a draft-only, chat-confirmed operation with no approval, exactly as before the gate", async () => {
    const repository = new InMemoryCopilotRepository();
    const adapter = directiveAdapter();
    const service = buildService(repository, adapter);
    const catalog = executeCatalog(service);
    const { proposal, reviewDigest } = await seedReviewedProposal(repository, { confirmationRequirement: "conversation" });

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContext(randomUUID()), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    });

    expect(output).toMatchObject({ status: "applied", appliedRef: { directiveId: "directive-1" } });
    expect(adapter.applyIfVersionMatches).toHaveBeenCalledOnce();
  });

  it("leaves an ordinary dashboard propose_* apply unaffected by the reviewed gate", async () => {
    const repository = new InMemoryCopilotRepository();
    const adapter = directiveAdapter();
    const service = buildService(repository, adapter);
    // A propose_* proposal carries no review digest or confirmation requirement at all: the gate
    // lives entirely on the reviewed-operation columns, so a dashboard-origin proposal never
    // touches it.
    const proposal = await repository.createProposal({
      workspaceId, operatorUserId, conversationId: randomUUID(),
      targetType: "directive", targetRef: { agentId: randomUUID(), directiveId: randomUUID() },
      payload: { name: "Dashboard change" }, versionToken: "v1", evidence: null,
    });

    await expect(service.applyProposal({ workspaceId, accountId, operatorUserId, surface: "dashboard", proposalId: proposal.id }))
      .resolves.toMatchObject({ status: "applied", appliedRef: { directiveId: "directive-1" } });
    expect(adapter.applyIfVersionMatches).toHaveBeenCalledOnce();
  });
});
