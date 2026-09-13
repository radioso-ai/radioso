import { z } from "zod";

import type { CopilotCurrentAuthorizationPort, CopilotToolDescriptor } from "../contracts.js";
import { reviewedOperationDigestPattern } from "../reviewedOperation.js";

const inputSchema = z.object({
  proposalId: z.string().uuid(),
  reviewDigest: z.string().regex(reviewedOperationDigestPattern),
}).strict();

const outputSchema = z.object({
  proposalId: z.string().uuid(),
  status: z.enum(["applied", "stale", "failed", "refused", "uncertain"]),
  appliedRef: z.unknown().optional(),
  reason: z.string().optional(),
}).strict();

type ReviewedProposalExecutionResult = Omit<z.infer<typeof outputSchema>, "proposalId">;

export interface ReviewedProposalExecutionPort {
  executeMcpReviewedProposal(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly operatorUserId: string;
    readonly proposalId: string;
    readonly reviewDigest: string;
    readonly executionInvocationId: string;
    readonly grantId: string;
    readonly clientId: string;
    /** Request-bound MCP credential/grant authorization, rechecked by the owner before mutation. */
    readonly currentAuthorization: CopilotCurrentAuthorizationPort;
  }): Promise<ReviewedProposalExecutionResult>;
}

/** The client confirms the reviewed digest before calling this write-scoped descriptor. */
export const createReviewedProposalExecutionTool = (
  executor: ReviewedProposalExecutionPort,
): CopilotToolDescriptor => ({
  name: "execute_reviewed_proposal",
  shape: "act",
  verificationCost: () => 0,
  uiLabel: "Applying reviewed operation",
  description: "Apply a previously prepared operation after the MCP client has shown and confirmed its exact review digest.",
  contributingModule: "operatorCopilot",
  dashboardSubject: { type: "proposal" },
  requiredPermissions: ["workspace.agents.manage"],
  inputSchema,
  outputSchema,
  reconcileMcpInvocation: async ({ invocation, arguments: rawInput, context }) => {
    const input = inputSchema.parse(rawInput);
    if (!context.operatorMcpGrantId || !context.operatorMcpClientId) return { status: "conflict" };
    const result = await executor.executeMcpReviewedProposal({
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      operatorUserId: context.operatorUserId,
      proposalId: input.proposalId,
      reviewDigest: input.reviewDigest,
      // The durable proposal is bound to the first receipt. A fresh request provides only
      // current authority; it must never become a replacement execution receipt.
      executionInvocationId: invocation.id,
      grantId: context.operatorMcpGrantId,
      clientId: context.operatorMcpClientId,
      currentAuthorization: context.currentAuthorization,
    });
    // A matching receipt with a live lease belongs to the first runner. Settling its invocation
    // from this retry would fence that runner's atomic owner+receipt transaction, so leave the
    // original receipt untouched until its lease expires or it reaches a durable outcome.
    if (result.status === "refused" && result.reason === "not_prepared") return { status: "in_progress" };
    return { status: "recovered", output: { proposalId: input.proposalId, ...result } };
  },
  createTool: (context) => ({
    name: "execute_reviewed_proposal",
    description: "Apply a previously prepared operation after the MCP client has shown and confirmed its exact review digest.",
    inputSchema,
    outputSchema,
    invoke: async (rawInput) => {
      const input = inputSchema.parse(rawInput);
      if (context.surface !== "mcp" || !context.operatorMcpInvocationId || !context.operatorMcpGrantId || !context.operatorMcpClientId) {
        throw new Error("MCP execution receipt is required");
      }
      const result = await executor.executeMcpReviewedProposal({
        workspaceId: context.workspaceId,
        accountId: context.accountId,
        operatorUserId: context.operatorUserId,
        proposalId: input.proposalId,
        reviewDigest: input.reviewDigest,
        executionInvocationId: context.operatorMcpInvocationId,
        grantId: context.operatorMcpGrantId,
        clientId: context.operatorMcpClientId,
        currentAuthorization: context.currentAuthorization,
      });
      return { proposalId: input.proposalId, ...result };
    },
  }),
});
