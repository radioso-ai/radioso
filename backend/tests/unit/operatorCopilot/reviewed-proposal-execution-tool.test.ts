import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../../src/shared/domain/errors.js";
import { createReviewedProposalExecutionTool, type ReviewedProposalExecutionPort } from "../../../src/modules/operatorCopilot/tools/reviewedProposalExecution.js";
import { createCancelReviewedProposalTool } from "../../../src/modules/operatorCopilot/tools/cancelReviewedProposal.js";
import { REVIEWED_OPERATION_NOT_CANCELLABLE, REVIEWED_OPERATION_NOT_FOUND } from "../../../src/modules/operatorCopilot/reviewedOperation.js";

describe("reviewed proposal execution tool", () => {
  it("binds the MCP execution receipt, grant, and client to the reviewed apply", async () => {
    const executeMcpReviewedProposal = vi.fn(async () => ({ status: "applied" as const, appliedRef: { routineId: "routine-1" } }));
    const descriptor = createReviewedProposalExecutionTool({ executeMcpReviewedProposal });
    const currentAuthorization = { hasAllPermissions: vi.fn() };
    const tool = descriptor.createTool({
      workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp",
      operatorMcpInvocationId: "execution-1", operatorMcpGrantId: "grant-1", operatorMcpClientId: "client-1",
      currentAuthorization, pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
    });

    await expect(tool.invoke({ proposalId: "11111111-1111-4111-8111-111111111111", reviewDigest: "a".repeat(43) }, {} as never))
      .resolves.toMatchObject({ proposalId: "11111111-1111-4111-8111-111111111111", status: "applied" });
    expect(executeMcpReviewedProposal).toHaveBeenCalledWith(expect.objectContaining({
      executionInvocationId: "execution-1", grantId: "grant-1", clientId: "client-1", accountId: "account-1",
      currentAuthorization,
    }));
  });

  it("reconciles with the original receipt while retaining fresh request authorization", async () => {
    const executeMcpReviewedProposal = vi.fn(async () => ({ status: "applied" as const, appliedRef: { routineId: "routine-1" } }));
    const descriptor = createReviewedProposalExecutionTool({ executeMcpReviewedProposal });
    const currentAuthorization = { hasAllPermissions: vi.fn() };

    const recovered = await descriptor.reconcileMcpInvocation?.({
      invocation: { id: "original-receipt" } as never,
      arguments: { proposalId: "11111111-1111-4111-8111-111111111111", reviewDigest: "a".repeat(43) },
      context: {
        workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp",
        operatorMcpInvocationId: "fresh-retry", operatorMcpGrantId: "grant-1", operatorMcpClientId: "client-1",
        currentAuthorization, pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
      },
      staleBefore: new Date(), now: new Date(),
    });

    expect(recovered).toMatchObject({ status: "recovered", output: { status: "applied" } });
    expect(executeMcpReviewedProposal).toHaveBeenCalledWith(expect.objectContaining({
      executionInvocationId: "original-receipt", currentAuthorization, grantId: "grant-1", clientId: "client-1",
    }));
  });

  const recoveryNow = new Date("2026-09-25T12:00:00Z");
  const staleBefore = new Date(recoveryNow.getTime() - 120_000);
  const proposalId = "11111111-1111-4111-8111-111111111111";
  const reconcileExecution = (
    executeMcpReviewedProposal: ReviewedProposalExecutionPort["executeMcpReviewedProposal"],
    invocation: { status: string; proofConsumedAt: Date | null },
  ) => createReviewedProposalExecutionTool({ executeMcpReviewedProposal }).reconcileMcpInvocation?.({
    invocation: { id: "original-receipt", ...invocation } as never,
    arguments: { proposalId, reviewDigest: "a".repeat(43) },
    context: {
      workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp",
      operatorMcpGrantId: "grant-1", operatorMcpClientId: "client-1", currentAuthorization: { hasAllPermissions: vi.fn() },
      pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
    },
    staleBefore, now: recoveryNow,
  });

  it.each(["admitted", "running"])("leaves an %s original receipt to its first runner while its proof is inside the recovery lease", async (status) => {
    const executeMcpReviewedProposal = vi.fn();

    await expect(reconcileExecution(executeMcpReviewedProposal, { status, proofConsumedAt: new Date(recoveryNow.getTime() - 1_000) }))
      .resolves.toEqual({ status: "in_progress" });
    expect(executeMcpReviewedProposal).not.toHaveBeenCalled();
  });

  it("refuses to reconcile an open original receipt whose proof was never consumed", async () => {
    const executeMcpReviewedProposal = vi.fn();

    await expect(reconcileExecution(executeMcpReviewedProposal, { status: "admitted", proofConsumedAt: null })).resolves.toEqual({ status: "conflict" });
    expect(executeMcpReviewedProposal).not.toHaveBeenCalled();
  });

  it("reconciles an open original receipt through the owner once its runner outlived the recovery lease", async () => {
    const executeMcpReviewedProposal = vi.fn(async () => ({ status: "applied" as const, appliedRef: { routineId: "routine-1" } }));

    await expect(reconcileExecution(executeMcpReviewedProposal, { status: "running", proofConsumedAt: new Date(staleBefore.getTime() - 1_000) }))
      .resolves.toEqual({ status: "recovered", output: { proposalId, status: "applied", appliedRef: { routineId: "routine-1" } } });
    expect(executeMcpReviewedProposal).toHaveBeenCalledWith(expect.objectContaining({ executionInvocationId: "original-receipt" }));
  });

  // A concurrent retry may have reopened the receipt through the owner's claim since this snapshot
  // was read, so what the snapshot says about the receipt cannot make an unconfirmed outcome final.
  it.each(["running", "failed", "completed"])("answers an unconfirmed outcome through a %s original receipt without settling it", async (status) => {
    const executeMcpReviewedProposal = vi.fn(async () => ({ status: "uncertain" as const, reason: "unconfirmed" }));

    await expect(reconcileExecution(executeMcpReviewedProposal, { status, proofConsumedAt: new Date(staleBefore.getTime() - 1_000) }))
      .resolves.toEqual({ status: "unconfirmed", output: { proposalId, status: "uncertain", reason: "unconfirmed" } });
  });

  it.each([
    { status: "applied" as const, appliedRef: { routineId: "routine-1" } },
    { status: "stale" as const },
    { status: "failed" as const, reason: "target unavailable" },
    { status: "refused" as const, reason: "not_prepared" },
  ])("answers a finished original receipt with the owner's durable outcome for it (%o)", async (outcome) => {
    const executeMcpReviewedProposal = vi.fn(async () => outcome);

    await expect(reconcileExecution(executeMcpReviewedProposal, { status: "completed", proofConsumedAt: new Date(recoveryNow.getTime() - 1_000) }))
      .resolves.toEqual({ status: "recovered", output: { proposalId, ...outcome } });
  });

  it("forwards the request-scoped authorization to a reviewed cancellation", async () => {
    const cancelMcpReviewedProposal = vi.fn(async () => ({ status: "dismissed" as const }));
    const descriptor = createCancelReviewedProposalTool({ cancelMcpReviewedProposal });
    const currentAuthorization = { hasAllPermissions: vi.fn() };
    const tool = descriptor.createTool({
      workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp",
      operatorMcpGrantId: "grant-1", operatorMcpClientId: "client-1", currentAuthorization,
      pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
    });

    await tool.invoke({ proposalId: "11111111-1111-4111-8111-111111111111" }, {} as never);

    expect(cancelMcpReviewedProposal).toHaveBeenCalledWith(expect.objectContaining({ currentAuthorization }));
  });

  it("reconciles a replayed cancellation to the proposal's dismissed outcome under the fresh request's binding", async () => {
    const cancelMcpReviewedProposal = vi.fn(async () => ({ status: "dismissed" as const }));
    const descriptor = createCancelReviewedProposalTool({ cancelMcpReviewedProposal });
    const currentAuthorization = { hasAllPermissions: vi.fn() };
    const proposalId = "11111111-1111-4111-8111-111111111111";

    await expect(descriptor.reconcileMcpInvocation?.({
      invocation: { id: "original-receipt" } as never,
      arguments: { proposalId },
      context: {
        workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp",
        operatorMcpInvocationId: "fresh-retry", operatorMcpGrantId: "grant-1", operatorMcpClientId: "client-1",
        currentAuthorization, pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
      },
      staleBefore: new Date(), now: new Date(),
    })).resolves.toEqual({ status: "recovered", output: { proposalId, status: "dismissed" } });
    expect(cancelMcpReviewedProposal).toHaveBeenCalledWith(expect.objectContaining({
      proposalId, grantId: "grant-1", clientId: "client-1", currentAuthorization,
    }));
  });

  it("does not reconcile a cancellation without its MCP grant and client binding", async () => {
    const cancelMcpReviewedProposal = vi.fn();
    const descriptor = createCancelReviewedProposalTool({ cancelMcpReviewedProposal });

    await expect(descriptor.reconcileMcpInvocation?.({
      invocation: { id: "original-receipt" } as never,
      arguments: { proposalId: "11111111-1111-4111-8111-111111111111" },
      context: {
        workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp",
        currentAuthorization: { hasAllPermissions: vi.fn() },
        pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
      },
      staleBefore: new Date(), now: new Date(),
    })).resolves.toEqual({ status: "conflict" });
    expect(cancelMcpReviewedProposal).not.toHaveBeenCalled();
  });

  it("rejects cancelling an id with no reviewed operation bound to this grant and client as a correctable not-found, not an outage", async () => {
    const cancelMcpReviewedProposal = vi.fn(async () => ({ status: "not_found" as const }));
    const descriptor = createCancelReviewedProposalTool({ cancelMcpReviewedProposal });
    const tool = descriptor.createTool({
      workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp",
      operatorMcpGrantId: "grant-1", operatorMcpClientId: "client-1", currentAuthorization: { hasAllPermissions: vi.fn() },
      pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
    });

    const rejection = await tool.invoke({ proposalId: "11111111-1111-4111-8111-111111111111" }, {} as never).then(() => null, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(AppError);
    expect((rejection as AppError).statusCode).toBe(404);
    expect((rejection as AppError).message).toBe(REVIEWED_OPERATION_NOT_FOUND);
  });

  it("rejects reconciling a cancellation with no bound reviewed operation as a correctable not-found, not an outage", async () => {
    const cancelMcpReviewedProposal = vi.fn(async () => ({ status: "not_found" as const }));
    const descriptor = createCancelReviewedProposalTool({ cancelMcpReviewedProposal });

    const rejection = await descriptor.reconcileMcpInvocation?.({
      invocation: { id: "original-receipt" } as never,
      arguments: { proposalId: "11111111-1111-4111-8111-111111111111" },
      context: {
        workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp",
        operatorMcpInvocationId: "fresh-retry", operatorMcpGrantId: "grant-1", operatorMcpClientId: "client-1",
        currentAuthorization: { hasAllPermissions: vi.fn() }, pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
      },
      staleBefore: new Date(), now: new Date(),
    }).then(() => null, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(AppError);
    expect((rejection as AppError).statusCode).toBe(404);
    expect((rejection as AppError).message).toBe(REVIEWED_OPERATION_NOT_FOUND);
  });

  it("rejects cancelling a non-pending reviewed operation as a correctable refusal, not an outage", async () => {
    const cancelMcpReviewedProposal = vi.fn(async () => ({ status: "not_cancellable" as const }));
    const descriptor = createCancelReviewedProposalTool({ cancelMcpReviewedProposal });
    const tool = descriptor.createTool({
      workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp",
      operatorMcpGrantId: "grant-1", operatorMcpClientId: "client-1", currentAuthorization: { hasAllPermissions: vi.fn() },
      pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
    });

    const rejection = await tool.invoke({ proposalId: "11111111-1111-4111-8111-111111111111" }, {} as never).then(() => null, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(AppError);
    expect((rejection as AppError).statusCode).toBe(400);
    expect((rejection as AppError).message).toBe(REVIEWED_OPERATION_NOT_CANCELLABLE);
  });

  it("rejects reconciling a cancellation of a non-pending reviewed operation as a correctable refusal, not an outage", async () => {
    const cancelMcpReviewedProposal = vi.fn(async () => ({ status: "not_cancellable" as const }));
    const descriptor = createCancelReviewedProposalTool({ cancelMcpReviewedProposal });

    const rejection = await descriptor.reconcileMcpInvocation?.({
      invocation: { id: "original-receipt" } as never,
      arguments: { proposalId: "11111111-1111-4111-8111-111111111111" },
      context: {
        workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp",
        operatorMcpInvocationId: "fresh-retry", operatorMcpGrantId: "grant-1", operatorMcpClientId: "client-1",
        currentAuthorization: { hasAllPermissions: vi.fn() }, pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
      },
      staleBefore: new Date(), now: new Date(),
    }).then(() => null, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(AppError);
    expect((rejection as AppError).statusCode).toBe(400);
    expect((rejection as AppError).message).toBe(REVIEWED_OPERATION_NOT_CANCELLABLE);
  });

  it("refuses a non-MCP invocation instead of accepting an unbound execution", async () => {
    const descriptor = createReviewedProposalExecutionTool({ executeMcpReviewedProposal: vi.fn() });
    const tool = descriptor.createTool({
      workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "dashboard",
      currentAuthorization: { hasAllPermissions: vi.fn() }, pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
    });
    await expect(tool.invoke({ proposalId: "11111111-1111-4111-8111-111111111111", reviewDigest: "a".repeat(43) }, {} as never)).rejects.toThrow(/MCP execution receipt/i);
  });
});
