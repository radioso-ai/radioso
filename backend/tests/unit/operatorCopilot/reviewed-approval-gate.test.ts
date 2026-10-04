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
    now?: () => Date;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
  now: options.now,
  sleep: options.sleep,
});

/**
 * A deterministic stand-in for the real clock and the real bounded wait's `setTimeout`: `sleep`
 * advances the virtual clock by exactly the requested delay instead of waiting in real time, so a
 * test can drive a 25-second wait in milliseconds. `onSleep` runs before each tick advances the
 * clock, letting a test record an approval "during" the wait, simulating the grant's user clicking
 * Approve on the page while an accepted retry is mid-poll.
 */
const virtualApprovalClock = (onSleep?: (tick: number) => void | Promise<void>, startedAt = new Date("2026-01-01T00:00:00.000Z")) => {
  let now = startedAt.getTime();
  let tick = 0;
  const sleep = vi.fn(async (ms: number, signal?: AbortSignal) => {
    tick += 1;
    await onSleep?.(tick);
    if (signal?.aborted) return;
    now += ms;
  });
  return { now: () => new Date(now), sleep };
};

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
    const reviewedGrantClient = { describeBoundGrantClient: vi.fn<OperatorMcpBoundGrantClientDescriptionPort["describeBoundGrantClient"]>(async () => ({ clientId: "client-record-1", clientName: "Operator test client", grantId: "grant-record-1" })) };
    const service = buildService(repository, directiveAdapter(), { auditService, metrics, reviewedGrantClient });
    const catalog = executeCatalog(service);
    const { proposal, reviewDigest } = await seedReviewedProposal(repository);
    const firstExecutionInvocationId = randomUUID();

    await expect(catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContext(firstExecutionInvocationId), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    })).resolves.toMatchObject({ status: "approval_required" });
    // Non-secret join keys an incident reviewer needs: the review code (never the full digest -
    // design §5.6/§14) and requirement the refusal was against, and which client, grant, and
    // execution attempt asked for it.
    const reviewCode = reviewDigest.slice(0, 8);
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "copilot.proposal.apply_denied", eventStatus: "failure",
      metadata: expect.objectContaining({ reason: "approval_required", reviewCode, confirmationRequirement: "signed_in_approval", clientId, grantId, executionInvocationId: firstExecutionInvocationId }),
    }));
    expect(metrics.incrementCounter).toHaveBeenCalledWith("operator_mcp_reviewed_approval_total", expect.objectContaining({ labels: { requirement: "signed_in_approval", outcome: "required_at_execute" } }));

    await expect(service.approveReviewedProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id, reviewDigest })).resolves.toEqual({ status: "approved" });
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "copilot.proposal.approved",
      metadata: expect.objectContaining({ reviewCode, approvedAt: expect.any(String), clientId: "client-record-1", grantId: "grant-record-1" }),
    }));
    expect(metrics.observeHistogram).toHaveBeenCalledWith("operator_mcp_reviewed_approval_latency_seconds", expect.objectContaining({ buckets: expect.any(Array) }));
    // No event this test wrote ever carries the full, replayable digest - only its 8-char code.
    for (const call of auditService.record.mock.calls) {
      const metadata = call[0].metadata;
      expect(metadata).not.toHaveProperty("reviewDigest");
      expect(JSON.stringify(metadata)).not.toContain(reviewDigest);
    }

    // Repeating the exact same approval is idempotent server-side (§5.4): it must not write a
    // second `copilot.proposal.approved` event with a fresh timestamp.
    const approvedEventCount = () => auditService.record.mock.calls.filter((call) => call[0].eventType === "copilot.proposal.approved").length;
    const approvedAuditCallsBeforeRepeat = approvedEventCount();
    const observeHistogramCallsBeforeRepeat = (metrics.observeHistogram as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(service.approveReviewedProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id, reviewDigest })).resolves.toEqual({ status: "approved" });
    expect(approvedEventCount()).toBe(approvedAuditCallsBeforeRepeat);
    expect((metrics.observeHistogram as ReturnType<typeof vi.fn>).mock.calls.length).toBe(observeHistogramCallsBeforeRepeat);

    // Applying after approval carries the same join keys, plus the execution receipt that
    // actually committed the change and the approval time the approve event already recorded.
    const secondExecutionInvocationId = randomUUID();
    await expect(catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContext(secondExecutionInvocationId), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    })).resolves.toMatchObject({ status: "applied" });
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "copilot.proposal.applied",
      metadata: expect.objectContaining({ reviewCode, confirmationRequirement: "signed_in_approval", approvedAt: expect.any(String), clientId: "client-record-1", grantId: "grant-record-1", executionInvocationId: secondExecutionInvocationId }),
    }));

    const declined = await seedReviewedProposal(repository);
    await expect(service.dismissProposal({ workspaceId, accountId, operatorUserId, surface: "dashboard", proposalId: declined.proposal.id, reason: "declined" })).resolves.toEqual({ status: "dismissed" });
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "copilot.proposal.dismissed",
      // A declined operation was never approved, so it carries the review's join keys but no
      // approvedAt - the field is absent entirely rather than a misleading null.
      metadata: expect.objectContaining({ outcome: "declined", reason: "declined", reviewCode: declined.reviewDigest.slice(0, 8), confirmationRequirement: "signed_in_approval", clientId: "client-record-1", grantId: "grant-record-1" }),
    }));
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "copilot.proposal.dismissed",
      metadata: expect.not.objectContaining({ approvedAt: expect.anything() }),
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

/**
 * Finding 1 of the stacked review: an MCP client's accepted URL-elicitation retry ("open URL ->
 * approve") must not just relay `approval_required` again immediately -- it asks execution to wait
 * briefly for the person's approval first (design §6 flow B). `context.awaitApprovalMs` is exactly
 * what `mcpApplicationService` sets on an accepted retry; these tests drive it directly over the
 * same real service and descriptor the gate tests above use, with a virtual clock standing in for
 * the real 1-second poll and 25-second budget.
 */
describe("execute_reviewed_proposal's bounded wait for an accepted elicitation retry", () => {
  const mcpContextAwaiting = (invocationId: string, awaitApprovalMs: number) => ({ ...mcpContext(invocationId), awaitApprovalMs });

  it("executes once the wait observes an approval recorded mid-poll, with a single claim attempt", async () => {
    const repository = new InMemoryCopilotRepository();
    const adapter = directiveAdapter();
    const holder: { service?: OperatorCopilotService } = {};
    const clock = virtualApprovalClock(async (tick) => {
      // The grant's own user approves while the third poll is in flight -- the next check must see it.
      if (tick === 3) await holder.service!.approveReviewedProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id, reviewDigest });
    });
    const service = buildService(repository, adapter, { now: clock.now, sleep: clock.sleep });
    holder.service = service;
    const catalog = executeCatalog(service);
    const { proposal, reviewDigest } = await seedReviewedProposal(repository);

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContextAwaiting(randomUUID(), 25_000), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(60_000),
    });

    expect(output).toMatchObject({ status: "applied", appliedRef: { directiveId: "directive-1" } });
    expect(adapter.applyIfVersionMatches).toHaveBeenCalledOnce();
    expect(clock.sleep).toHaveBeenCalledTimes(3);
  });

  it("answers approval_required after the full bounded wait when nobody approves, and never applies the change", async () => {
    const repository = new InMemoryCopilotRepository();
    const adapter = directiveAdapter();
    const metrics: ApprovalMetrics = { incrementCounter: vi.fn(), observeHistogram: vi.fn() };
    const clock = virtualApprovalClock();
    const service = buildService(repository, adapter, { now: clock.now, sleep: clock.sleep, metrics });
    const catalog = executeCatalog(service);
    const { proposal, reviewDigest } = await seedReviewedProposal(repository);

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContextAwaiting(randomUUID(), 25_000), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(60_000),
    });

    expect(output).toMatchObject({ status: "approval_required" });
    // The wait never records or implies approval -- polling out the whole budget with nobody
    // approving must never reach the owner's apply.
    expect(adapter.applyIfVersionMatches).not.toHaveBeenCalled();
    expect(clock.sleep).toHaveBeenCalledTimes(25);
    expect(metrics.incrementCounter).toHaveBeenCalledWith("operator_mcp_reviewed_approval_wait_total", expect.objectContaining({ labels: { outcome: "timed_out" } }));
    expect(metrics.observeHistogram).toHaveBeenCalledWith("operator_mcp_reviewed_approval_wait_ms", expect.objectContaining({ value: 25_000 }));
  });

  it("does not wait at all when the caller never asked to (a declined or cancelled retry never sets it)", async () => {
    const repository = new InMemoryCopilotRepository();
    const adapter = directiveAdapter();
    const clock = virtualApprovalClock();
    const service = buildService(repository, adapter, { now: clock.now, sleep: clock.sleep });
    const catalog = executeCatalog(service);
    const { proposal, reviewDigest } = await seedReviewedProposal(repository);

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      // No awaitApprovalMs on the context: exactly what a decline, a cancel, or an ordinary first
      // call looks like to the service.
      context: mcpContext(randomUUID()), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    });

    expect(output).toMatchObject({ status: "approval_required" });
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("ends the wait as soon as the request's own signal aborts, without polling out the full budget", async () => {
    const repository = new InMemoryCopilotRepository();
    const adapter = directiveAdapter();
    const controller = new AbortController();
    const clock = virtualApprovalClock((tick) => { if (tick === 2) controller.abort(); });
    const service = buildService(repository, adapter, { now: clock.now, sleep: clock.sleep });
    const catalog = executeCatalog(service);
    const { proposal, reviewDigest } = await seedReviewedProposal(repository);

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContextAwaiting(randomUUID(), 25_000), scopes: new Set(["operator:write"]), signal: controller.signal,
    });

    expect(output).toMatchObject({ status: "approval_required" });
    expect(adapter.applyIfVersionMatches).not.toHaveBeenCalled();
    // Aborted on the second tick, so it never reaches anywhere near the 25 polls a full wait takes.
    expect(clock.sleep).toHaveBeenCalledTimes(2);
  });

  it("refuses as expired when the operation's own expiry lands during the wait", async () => {
    const repository = new InMemoryCopilotRepository();
    const adapter = directiveAdapter();
    const clock = virtualApprovalClock();
    const service = buildService(repository, adapter, { now: clock.now, sleep: clock.sleep });
    const catalog = executeCatalog(service);
    // Expires in 2.5s -- well inside the 25s accept-wait budget, but the wait must not blow past it.
    const { proposal, reviewDigest } = await seedReviewedProposal(repository, { expiresAt: new Date(clock.now().getTime() + 2_500) });

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContextAwaiting(randomUUID(), 25_000), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(60_000),
    });

    expect(output).toMatchObject({ status: "refused", reason: "expired" });
    expect(adapter.applyIfVersionMatches).not.toHaveBeenCalled();
    expect(clock.sleep).toHaveBeenCalledTimes(3);
  });

  it("still refuses a declined operation after waiting, exactly as an immediate execute already does", async () => {
    const repository = new InMemoryCopilotRepository();
    const adapter = directiveAdapter();
    const holder: { service?: OperatorCopilotService } = {};
    const clock = virtualApprovalClock(async (tick) => {
      if (tick === 2) await holder.service!.dismissProposal({ workspaceId, accountId, operatorUserId, surface: "dashboard", proposalId: proposal.id, reason: "declined" });
    });
    const service = buildService(repository, adapter, { now: clock.now, sleep: clock.sleep });
    holder.service = service;
    const catalog = executeCatalog(service);
    const { proposal, reviewDigest } = await seedReviewedProposal(repository);

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: proposal.id, reviewDigest },
      context: mcpContextAwaiting(randomUUID(), 25_000), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(60_000),
    });

    expect(output).toMatchObject({ status: "refused", reason: "canceled" });
    expect(adapter.applyIfVersionMatches).not.toHaveBeenCalled();
  });
});
