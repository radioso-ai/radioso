import { describe, expect, it, vi } from "vitest";

import { createReviewedProposalOutcomeTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalOutcome.js";

const context = {
  workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp" as const,
  operatorMcpInvocationId: "read-1", operatorMcpGrantId: "grant-1", operatorMcpClientId: "client-1",
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
};

describe("reviewed proposal outcome tool", () => {
  it("returns the immutable review snapshot and applied outcome through the preparation binding", async () => {
    const getMcpReviewedProposal = vi.fn(async () => ({
      proposal: {
        id: "11111111-1111-4111-8111-111111111111", status: "applied" as const,
        reviewDigest: "a".repeat(43), expiresAt: new Date("2026-09-13T00:15:00.000Z"),
        appliedRef: { agentId: "agent-1" }, reviewSnapshot: { before: { enabled: true }, after: { enabled: false } },
      },
      currentVersionMatches: false,
    }));
    const tool = createReviewedProposalOutcomeTool({ getMcpReviewedProposal }).createTool(context);

    await expect(tool.invoke({ proposalId: "11111111-1111-4111-8111-111111111111" }, {} as never)).resolves.toEqual({
      proposalId: "11111111-1111-4111-8111-111111111111", status: "applied", reviewDigest: "a".repeat(43),
      expiresAt: "2026-09-13T00:15:00.000Z", currentVersionMatches: false, appliedRef: { agentId: "agent-1" },
      review: { before: { enabled: true }, after: { enabled: false } },
    });
    expect(getMcpReviewedProposal).toHaveBeenCalledWith(expect.objectContaining({ grantId: "grant-1", clientId: "client-1", workspaceId: "workspace-1", operatorUserId: "user-1" }));
  });

  it("keeps a bounded stored review out of the default response and returns explicit detail chunks", async () => {
    const fullReview = { before: {}, after: { steps: { step_40: { instruction: "The omitted instruction" } } } };
    const getMcpReviewedProposal = vi.fn(async () => ({
      proposal: {
        id: "11111111-1111-4111-8111-111111111111", status: "pending" as const,
        reviewDigest: "a".repeat(43), expiresAt: new Date("2026-09-13T00:15:00.000Z"), appliedRef: null,
        reviewSnapshot: { diagnostics: [], review: { truncated: true, detailAvailable: true, after: { steps: { step_0: { instruction: "Visible" } } } }, fullReview },
      },
      currentVersionMatches: true,
    }));
    const tool = createReviewedProposalOutcomeTool({ getMcpReviewedProposal }).createTool(context);
    const summary = await tool.invoke({ proposalId: "11111111-1111-4111-8111-111111111111" }, {} as never);
    expect(summary.review).not.toHaveProperty("fullReview");
    const detail = await tool.invoke({ proposalId: "11111111-1111-4111-8111-111111111111", reviewDetail: { offset: 0, limit: 30 } }, {} as never);
    expect(detail.reviewDetail).toMatchObject({ text: expect.stringContaining("before"), totalLength: expect.any(Number) });
  });
});
