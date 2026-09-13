import { describe, expect, it, vi } from "vitest";

import { createReviewedProposalExecutionTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalExecution.js";

describe("reviewed proposal execution tool", () => {
  it("binds the MCP execution receipt, grant, and client to the reviewed apply", async () => {
    const executeMcpReviewedProposal = vi.fn(async () => ({ status: "applied" as const, appliedRef: { routineId: "routine-1" } }));
    const descriptor = createReviewedProposalExecutionTool({ executeMcpReviewedProposal });
    const tool = descriptor.createTool({
      workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp",
      operatorMcpInvocationId: "execution-1", operatorMcpGrantId: "grant-1", operatorMcpClientId: "client-1",
      currentAuthorization: { hasAllPermissions: vi.fn() }, pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
    });

    await expect(tool.invoke({ proposalId: "11111111-1111-4111-8111-111111111111", reviewDigest: "a".repeat(43) }, {} as never))
      .resolves.toMatchObject({ proposalId: "11111111-1111-4111-8111-111111111111", status: "applied" });
    expect(executeMcpReviewedProposal).toHaveBeenCalledWith(expect.objectContaining({
      executionInvocationId: "execution-1", grantId: "grant-1", clientId: "client-1", accountId: "account-1",
    }));
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
