import { describe, expect, it, vi } from "vitest";

import { createReviewedProposalExecutionTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalExecution.js";
import { createCancelReviewedProposalTool } from "../../../src/modules/operatorCopilot/tools/cancelReviewedProposal.js";

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

  it("does not settle an original receipt while its matching owner lease is active", async () => {
    const descriptor = createReviewedProposalExecutionTool({
      executeMcpReviewedProposal: vi.fn(async () => ({ status: "refused" as const, reason: "not_prepared" })),
    });

    await expect(descriptor.reconcileMcpInvocation?.({
      invocation: { id: "original-receipt" } as never,
      arguments: { proposalId: "11111111-1111-4111-8111-111111111111", reviewDigest: "a".repeat(43) },
      context: {
        workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp",
        operatorMcpGrantId: "grant-1", operatorMcpClientId: "client-1", currentAuthorization: { hasAllPermissions: vi.fn() },
        pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
      }, staleBefore: new Date(), now: new Date(),
    })).resolves.toEqual({ status: "in_progress" });
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

  it("refuses a non-MCP invocation instead of accepting an unbound execution", async () => {
    const descriptor = createReviewedProposalExecutionTool({ executeMcpReviewedProposal: vi.fn() });
    const tool = descriptor.createTool({
      workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "dashboard",
      currentAuthorization: { hasAllPermissions: vi.fn() }, pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
    });
    await expect(tool.invoke({ proposalId: "11111111-1111-4111-8111-111111111111", reviewDigest: "a".repeat(43) }, {} as never)).rejects.toThrow(/MCP execution receipt/i);
  });
});
