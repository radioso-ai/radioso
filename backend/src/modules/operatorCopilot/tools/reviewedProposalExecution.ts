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
  surfaces: ["mcp"],
  requiredPermissions: [],
  inputSchema,
  outputSchema,
  reconcileMcpInvocation: async ({ invocation, arguments: rawInput, context, staleBefore }) => {
    const input = inputSchema.parse(rawInput);
    if (!context.operatorMcpGrantId || !context.operatorMcpClientId) return { status: "conflict" };
    // An open receipt whose proof is inside the recovery lease belongs to its first runner: a
    // retry that reached the owner first could claim under that receipt before the runner does.
    if (invocation.status === "admitted" || invocation.status === "running") {
      if (!invocation.proofConsumedAt) return { status: "conflict" };
      if (invocation.proofConsumedAt.getTime() > staleBefore.getTime()) return { status: "in_progress" };
    }
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
    // `recovered` settles the original receipt, so only a durable outcome may take that path. The
    // snapshot above can be stale: a concurrent retry's claim may have reopened the receipt, and
    // settling it from here would fence that retry's atomic owner+receipt settlement.
    if (result.status === "uncertain") return { status: "unconfirmed", output: { proposalId: input.proposalId, ...result } };
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
